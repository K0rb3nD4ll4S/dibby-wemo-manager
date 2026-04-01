"""
Async DWM Scheduler for Home Assistant.
Direct port of the Homebridge/desktop DwmScheduler (JavaScript → Python asyncio).

Rule types:
  Schedule  — fixed time or sunrise/sunset, per-day
  Countdown — state-change trigger → wait N seconds → fire action
  Away      — randomised ON/OFF loop within a time window
  AlwaysOn  — health-monitor enforces ON every HEALTH_POLL_S seconds
  Trigger   — IFTTT-style: device A state change → action on device B
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime
from typing import Any, Callable, Awaitable

from .const import (
    ACTION_ON, ACTION_OFF,
    HEALTH_POLL_S, HEARTBEAT_S, TICK_S, CATCHUP_WINDOW_S,
    SUN_SUNRISE, SUN_SUNSET,
    WEMO_DAY_NAMES,
)
from .sun import sun_times

_LOGGER = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _secs_from_midnight(dt: datetime | None = None) -> int:
    dt = dt or datetime.now()
    return dt.hour * 3600 + dt.minute * 60 + dt.second


def _secs_to_hhmm(s: int) -> str:
    return f"{(s // 3600) % 24:02d}:{(s % 3600) // 60:02d}"


def _action_label(a: int) -> str:
    return "ON" if a == ACTION_ON else "OFF" if a == ACTION_OFF else f"action({a})"


def _py_to_wemo_day(py_weekday: int) -> int:
    """Python weekday 0=Mon…6=Sun → Wemo 1=Mon…7=Sun."""
    return 7 if py_weekday == 6 else py_weekday + 1


def _resolve_secs(raw: int | None, kind: str | None, offset_mins: int | None,
                  today_sun: tuple | None) -> int | None:
    offset_secs = (offset_mins or 0) * 60
    if kind == "sunset" or raw == SUN_SUNSET:
        return (today_sun[1] + offset_secs) if today_sun and today_sun[1] is not None else None
    if kind == "sunrise" or raw == SUN_SUNRISE:
        return (today_sun[0] + offset_secs) if today_sun and today_sun[0] is not None else None
    return raw if (raw is not None and raw >= 0) else None


def _today_sun(store) -> tuple | None:
    loc = store.get_location()
    if not loc or not loc.get("lat") or not loc.get("lng"):
        return None
    try:
        return sun_times(loc["lat"], loc["lng"])
    except Exception:
        return None


# ── Scheduler ─────────────────────────────────────────────────────────────────

class DwmScheduler:
    def __init__(self, store, wemo_client_module, hass=None, logger=None,
                 heartbeat_s: int = HEARTBEAT_S) -> None:
        self._store = store
        self._wemo = wemo_client_module
        self._hass = hass
        self._log = logger or _LOGGER
        self._heartbeat_s = max(1, int(heartbeat_s or HEARTBEAT_S))

        self._schedule: list[dict] = []
        self._fired_today: set[str] = set()
        self._away_loops: dict[str, dict] = {}
        self._countdown_states: dict[str, bool] = {}
        self._countdown_timers: dict[str, asyncio.Task] = {}
        self._trigger_states: dict[str, bool] = {}
        self._device_health: dict[str, bool] = {}

        self._tick_task: asyncio.Task | None = None
        self._health_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._running = False
        self._started_at: datetime | None = None
        self._last_fire: dict | None = None

        self._on_fire_cb: Callable | None = None
        self._on_health_cb: Callable | None = None
        self._on_status_cb: Callable | None = None

    # ── Public API ────────────────────────────────────────────────────────────

    def on_fire(self, cb: Callable) -> None:
        self._on_fire_cb = cb

    def on_health(self, cb: Callable) -> None:
        self._on_health_cb = cb

    def on_status(self, cb: Callable) -> None:
        self._on_status_cb = cb

    def is_running(self) -> bool:
        return self._running

    async def start(self) -> dict:
        if self._running:
            await self.stop()
        self._running = True
        self._started_at = datetime.now()
        self._fired_today = set()
        self._load_schedule()
        self._catch_up_missed()
        await self._resume_away_loops()
        self._tick_task = asyncio.ensure_future(self._tick_loop())
        self._health_task = asyncio.ensure_future(self._health_loop())
        self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop())
        status = self._build_status()
        self._emit_status(status)
        self._log.info("[DWM] Started — %d schedule entries", len(self._schedule))
        return status

    async def stop(self) -> dict:
        self._running = False
        for task in [self._tick_task, self._health_task, self._heartbeat_task]:
            if task:
                task.cancel()
        for loop in self._away_loops.values():
            t = loop.get("task")
            if t:
                t.cancel()
        for t in self._countdown_timers.values():
            t.cancel()
        self._away_loops.clear()
        self._countdown_timers.clear()
        self._schedule = []
        self._log.info("[DWM] Stopped")
        return {"running": False}

    async def reload(self) -> dict:
        if not self._running:
            return {"running": False}
        for loop in self._away_loops.values():
            t = loop.get("task")
            if t:
                t.cancel()
        self._away_loops.clear()
        self._countdown_states.clear()
        self._load_schedule()
        self._catch_up_missed()
        await self._resume_away_loops()
        status = self._build_status()
        self._emit_status(status)
        self._log.info("[DWM] Reloaded — %d entries", len(self._schedule))
        return status

    def get_status(self) -> dict:
        return self._build_status()

    # ── Events ───────────────────────────────────────────────────────────────

    def _emit(self, event: dict) -> None:
        self._last_fire = {**event, "at": datetime.utcnow().isoformat() + "Z"}
        if self._on_fire_cb:
            try:
                result = self._on_fire_cb(event)
                if asyncio.iscoroutine(result):
                    asyncio.ensure_future(result)
            except Exception:
                pass

    def _emit_status(self, status: dict) -> None:
        if self._on_status_cb:
            try:
                self._on_status_cb(status)
            except Exception:
                pass

    def _emit_health(self, event: dict) -> None:
        if self._on_health_cb:
            try:
                self._on_health_cb(event)
            except Exception:
                pass

    # ── Schedule loading ──────────────────────────────────────────────────────

    def _load_schedule(self) -> None:
        schedule = []
        rules = self._store.get_dwm_rules()
        today_sun = _today_sun(self._store)

        for rule in rules:
            if not rule.get("enabled"):
                continue
            rt = rule.get("type")
            if rt in ("AlwaysOn", "Trigger", "Countdown"):
                continue

            if rt == "Away":
                start = _resolve_secs(rule.get("startTime"), rule.get("startType"), rule.get("startOffset"), today_sun)
                end   = _resolve_secs(rule.get("endTime"),   rule.get("endType"),   rule.get("endOffset"),   today_sun)
                if start is None:
                    continue
                td0 = (rule.get("targetDevices") or [{}])[0]
                for day in (rule.get("days") or []):
                    schedule.append({
                        "ruleId": rule["id"], "ruleName": rule["name"],
                        "targetHost": td0.get("host", ""), "targetPort": td0.get("port", 0),
                        "dayId": int(day), "targetSecs": start,
                        "action": int(rule.get("startAction", ACTION_ON)),
                        "isAwayStart": True,
                    })
                    if end is not None and end >= 0:
                        schedule.append({
                            "ruleId": rule["id"] + "-away-end", "ruleName": rule["name"],
                            "targetHost": td0.get("host", ""), "targetPort": td0.get("port", 0),
                            "dayId": int(day), "targetSecs": end,
                            "action": int(rule.get("endAction", ACTION_OFF)),
                            "isAwayEnd": True, "awayRuleId": rule["id"],
                        })
                continue

            # Schedule (time-based)
            start = _resolve_secs(rule.get("startTime"), rule.get("startType"), rule.get("startOffset"), today_sun)
            end   = _resolve_secs(rule.get("endTime"),   rule.get("endType"),   rule.get("endOffset"),   today_sun)
            if start is None:
                continue
            start_action = int(rule.get("startAction", ACTION_ON))
            end_action   = int(rule.get("endAction", -1))

            for day in (rule.get("days") or []):
                for td in (rule.get("targetDevices") or []):
                    if not td.get("host") or not td.get("port"):
                        continue
                    if start_action >= 0:
                        schedule.append({
                            "ruleId": rule["id"], "ruleName": rule["name"],
                            "targetHost": td["host"], "targetPort": int(td["port"]),
                            "dayId": int(day), "targetSecs": start, "action": start_action,
                        })
                    if end is not None and end > 0 and end_action >= 0:
                        schedule.append({
                            "ruleId": rule["id"], "ruleName": rule["name"],
                            "targetHost": td["host"], "targetPort": int(td["port"]),
                            "dayId": int(day), "targetSecs": end, "action": end_action,
                        })

        self._schedule = schedule

    # ── Tick loop ─────────────────────────────────────────────────────────────

    async def _tick_loop(self) -> None:
        last_date = datetime.now().date()
        while self._running:
            try:
                now = datetime.now()
                if now.date() != last_date:
                    last_date = now.date()
                    self._fired_today = set()
                    for loop in self._away_loops.values():
                        t = loop.get("task")
                        if t:
                            t.cancel()
                    self._away_loops.clear()
                    self._load_schedule()
                    await self._resume_away_loops()
                    self._emit_status(self._build_status())
                else:
                    self._load_schedule()

                self._schedule_upcoming()
            except Exception as e:
                self._log.error("[DWM] Tick error (scheduler still running): %s", e)

            await asyncio.sleep(TICK_S)

    def _schedule_upcoming(self) -> None:
        if not self._running:
            return
        now = datetime.now()
        now_secs = _secs_from_midnight(now)
        today_id = _py_to_wemo_day(now.weekday())
        window_end = now_secs + 65

        for entry in self._schedule:
            if entry["dayId"] != today_id:
                continue
            if entry["targetSecs"] < now_secs - 5:
                continue
            if entry["targetSecs"] > window_end:
                continue

            key = f"{entry['ruleId']}-{entry['dayId']}-{entry['targetSecs']}-{entry.get('targetHost','')}"
            if key in self._fired_today:
                continue
            self._fired_today.add(key)

            delay = max(0, entry["targetSecs"] - now_secs)
            asyncio.ensure_future(self._fire_after(entry, delay))

    async def _fire_after(self, entry: dict, delay_s: float) -> None:
        if delay_s > 0:
            await asyncio.sleep(delay_s)
        if not self._running:
            return
        await self._fire(entry)

    async def _fire(self, entry: dict) -> None:
        if entry.get("isAwayStart"):
            rules = self._store.get_dwm_rules()
            rule = next((r for r in rules if r["id"] == entry["ruleId"]), None)
            if rule and rule.get("enabled"):
                await self._start_away_loop(rule)
                self._emit({"success": True, "msg": f'"{entry["ruleName"]}" Away Mode started'})
            return

        if entry.get("isAwayEnd"):
            await self._stop_away_loop(entry["awayRuleId"], force_off=True)
            return

        want_on = entry["action"] == ACTION_ON
        label = _action_label(entry["action"])
        host, port = entry["targetHost"], entry["targetPort"]
        try:
            await self._wemo.set_binary_state(host, port, want_on)
            await asyncio.sleep(3)
            try:
                confirmed = await self._wemo.get_binary_state(host, port) == want_on
            except Exception:
                confirmed = None

            suffix = " (unverified)" if confirmed is None else " ✓" if confirmed else " ⚠ retrying"
            self._emit({"success": True, "msg": f'"{entry["ruleName"]}" → {label} ({host}){suffix}'})

            if confirmed is False:
                await asyncio.sleep(5)
                try:
                    await self._wemo.set_binary_state(host, port, want_on)
                    self._emit({"success": True, "msg": f'"{entry["ruleName"]}" → {label} retry OK'})
                except Exception:
                    pass
        except Exception as e:
            self._emit({"success": False, "msg": f'"{entry["ruleName"]}" → {label} FAILED: {e}'})

    # ── Catch-up on restart ───────────────────────────────────────────────────

    def _catch_up_missed(self) -> None:
        now = datetime.now()
        now_secs = _secs_from_midnight(now)
        today_id = _py_to_wemo_day(now.weekday())

        for entry in self._schedule:
            if entry.get("isAwayStart") or entry.get("isAwayEnd"):
                continue
            if entry["dayId"] != today_id:
                continue
            age = now_secs - entry["targetSecs"]
            if age <= 0 or age > CATCHUP_WINDOW_S:
                continue
            key = f"{entry['ruleId']}-{entry['dayId']}-{entry['targetSecs']}-{entry.get('targetHost','')}"
            if key in self._fired_today:
                continue
            self._fired_today.add(key)
            self._emit({"success": True, "msg": f'[catch-up] "{entry["ruleName"]}" → {_action_label(entry["action"])} ({entry.get("targetHost","")})'})
            asyncio.ensure_future(self._fire(entry))

    # ── Away Mode loops ───────────────────────────────────────────────────────

    async def _resume_away_loops(self) -> None:
        now = datetime.now()
        now_secs = _secs_from_midnight(now)
        today_id = _py_to_wemo_day(now.weekday())
        today_sun = _today_sun(self._store)

        for rule in self._store.get_dwm_rules():
            if not rule.get("enabled") or rule.get("type") != "Away":
                continue
            if rule["id"] in self._away_loops:
                continue
            if today_id not in (rule.get("days") or []):
                continue

            start = _resolve_secs(rule.get("startTime"), rule.get("startType"), rule.get("startOffset"), today_sun)
            end   = _resolve_secs(rule.get("endTime"),   rule.get("endType"),   rule.get("endOffset"),   today_sun)
            if start is None:
                continue

            if end is not None and end >= 0:
                in_window = now_secs >= start and now_secs < end
            else:
                in_window = now_secs >= start

            if in_window:
                await self._start_away_loop(rule)

    async def _start_away_loop(self, rule: dict) -> None:
        existing = self._away_loops.get(rule["id"], {})
        if existing.get("task"):
            existing["task"].cancel()

        devices = [td for td in (rule.get("targetDevices") or []) if td.get("host") and td.get("port")]
        if not devices:
            return

        today_sun = _today_sun(self._store)
        end_secs = _resolve_secs(rule.get("endTime"), rule.get("endType"), rule.get("endOffset"), today_sun)
        loop_state: dict[str, Any] = {"rule": rule, "devices": devices, "end_secs": end_secs or -1, "is_on": False}
        self._away_loops[rule["id"]] = loop_state
        task = asyncio.ensure_future(self._away_loop(rule["id"], turn_on=True))
        loop_state["task"] = task

    async def _away_loop(self, rule_id: str, turn_on: bool) -> None:
        loop = self._away_loops.get(rule_id)
        if not loop or not self._running:
            return

        now_secs = _secs_from_midnight()
        if loop["end_secs"] >= 0 and now_secs >= loop["end_secs"]:
            await self._stop_away_loop(rule_id, force_off=True)
            return

        loop["is_on"] = turn_on
        for td in loop["devices"]:
            try:
                await self._wemo.set_binary_state(td["host"], td["port"], turn_on)
                self._emit({"success": True, "msg": f'"{loop["rule"]["name"]}" Away → {"ON" if turn_on else "OFF"} ({td["host"]}) ✓'})
            except Exception as e:
                self._emit({"success": False, "msg": f'"{loop["rule"]["name"]}" Away FAILED: {e}'})

        delay_secs = random.randint(30, 90) * 60 if turn_on else random.randint(1, 15) * 60
        if loop["end_secs"] >= 0:
            remaining = loop["end_secs"] - _secs_from_midnight()
            if delay_secs >= remaining:
                return

        await asyncio.sleep(delay_secs)
        if rule_id in self._away_loops and self._running:
            await self._away_loop(rule_id, not turn_on)

    async def _stop_away_loop(self, rule_id: str, force_off: bool) -> None:
        loop = self._away_loops.pop(rule_id, None)
        if not loop:
            return
        if loop.get("task"):
            loop["task"].cancel()
        if force_off:
            end_action = int(loop["rule"].get("endAction", ACTION_OFF))
            want_on = end_action == ACTION_ON
            for td in loop["devices"]:
                try:
                    await self._wemo.set_binary_state(td["host"], td["port"], want_on)
                except Exception:
                    pass
            self._emit({"success": True, "msg": f'"{loop["rule"]["name"]}" Away Mode ended — {"ON" if want_on else "OFF"}'})

    # ── Health monitor ────────────────────────────────────────────────────────

    async def _health_loop(self) -> None:
        await asyncio.sleep(15)  # initial delay
        while self._running:
            try:
                await self._poll_device_health()
            except Exception as e:
                self._log.error("[DWM] Health poll error: %s", e)
            await asyncio.sleep(HEALTH_POLL_S)

    async def _poll_device_health(self) -> None:
        all_rules = self._store.get_dwm_rules()
        device_map: dict[str, dict] = {}
        always_on_set: set[str] = set()
        trigger_src_set: set[str] = set()
        countdown_dev_map: dict[str, list] = {}

        def add_dev(td: dict) -> str | None:
            if not td.get("host") or not td.get("port"):
                return None
            key = f"{td['host']}:{td['port']}"
            if key not in device_map:
                device_map[key] = {"host": td["host"], "port": int(td["port"]), "name": td.get("name", td["host"])}
            return key

        for rule in all_rules:
            if not rule.get("enabled"):
                continue
            if rule.get("type") == "Trigger":
                k = add_dev(rule.get("triggerDevice") or {})
                if k:
                    trigger_src_set.add(k)
                for td in (rule.get("actionDevices") or []):
                    add_dev(td)
                continue
            for td in (rule.get("targetDevices") or []):
                k = add_dev(td)
                if not k:
                    continue
                if rule.get("type") == "AlwaysOn":
                    always_on_set.add(k)
                if rule.get("type") == "Countdown":
                    countdown_dev_map.setdefault(k, []).append({"rule": rule, "td": td})

        for key, dev in device_map.items():
            was_online = self._device_health.get(key)
            try:
                is_on = await self._wemo.get_binary_state(dev["host"], dev["port"])
                self._device_health[key] = True

                if was_online is False:
                    self._emit_health({**dev, "online": True, "msg": f"{dev['name']} came back online"})
                    await self._enforce_current_state(dev)
                elif was_online is None:
                    self._emit_health({**dev, "online": True, "msg": f"{dev['name']} online"})

                # AlwaysOn
                if key in always_on_set and not is_on:
                    try:
                        await self._wemo.set_binary_state(dev["host"], dev["port"], True)
                        self._emit({"success": True, "msg": f"[always-on] {dev['name']} was OFF — turned ON ✓"})
                    except Exception as e:
                        self._emit({"success": False, "msg": f"[always-on] {dev['name']} FAILED: {e}"})

                # Trigger
                if key in trigger_src_set:
                    prev = self._trigger_states.get(key)
                    self._trigger_states[key] = is_on
                    if prev is not None and prev != is_on:
                        await self._fire_trigger_rules(key, is_on)

                # Countdown — fire on first poll OR state change (no prev is not None guard)
                if key in countdown_dev_map:
                    prev = self._countdown_states.get(key)
                    self._countdown_states[key] = is_on
                    if prev != is_on:
                        now_secs = _secs_from_midnight()
                        for item in countdown_dev_map[key]:
                            rule, td = item["rule"], item["td"]
                            condition = rule.get("countdownAction", "on_to_off")
                            triggered = is_on if condition == "on_to_off" else not is_on
                            if not triggered:
                                continue

                            win_start = rule.get("windowStart", -1)
                            win_end   = rule.get("windowEnd",   -1)
                            if win_start is not None and win_start >= 0 and win_end is not None and win_end >= 0:
                                if win_end < win_start:
                                    in_win = now_secs >= win_start or now_secs <= win_end
                                else:
                                    in_win = win_start <= now_secs <= win_end
                                if not in_win:
                                    continue
                            elif win_start is not None and win_start >= 0:
                                if now_secs < win_start:
                                    continue

                            timer_key = f"{key}-{rule['id']}"
                            existing = self._countdown_timers.pop(timer_key, None)
                            if existing:
                                existing.cancel()

                            want_on = condition == "off_to_on"
                            duration_s = int(rule.get("countdownTime") or 60)
                            label = "ON" if want_on else "OFF"
                            mins = round(duration_s / 60)
                            self._emit({"success": True,
                                "msg": f'"{rule["name"]}" countdown started — will turn {label} in {mins} min ({td["host"]})'})

                            task = asyncio.ensure_future(
                                self._run_countdown(timer_key, td["host"], int(td["port"]),
                                                    want_on, duration_s, rule["name"])
                            )
                            self._countdown_timers[timer_key] = task

            except Exception as e:
                self._device_health[key] = False
                if was_online is not False:
                    self._emit_health({**dev, "online": False, "msg": f"{dev['name']} unreachable: {e}"})

    async def _run_countdown(self, timer_key: str, host: str, port: int,
                              want_on: bool, duration_s: int, rule_name: str) -> None:
        try:
            await asyncio.sleep(duration_s)
            self._countdown_timers.pop(timer_key, None)
            await self._wemo.set_binary_state(host, port, want_on)
            label = "ON" if want_on else "OFF"
            self._emit({"success": True, "msg": f'"{rule_name}" countdown elapsed → {label} ({host}) ✓'})
        except asyncio.CancelledError:
            pass
        except Exception as e:
            label = "ON" if want_on else "OFF"
            self._emit({"success": False, "msg": f'"{rule_name}" countdown elapsed → {label} FAILED: {e}'})

    async def _enforce_current_state(self, dev: dict) -> None:
        now_secs = _secs_from_midnight()
        today_id = _py_to_wemo_day(datetime.now().weekday())
        best = None
        for entry in self._schedule:
            if entry.get("isAwayStart") or entry.get("isAwayEnd"):
                continue
            if entry.get("targetHost") != dev["host"]:
                continue
            if entry.get("dayId") != today_id:
                continue
            if entry["targetSecs"] > now_secs:
                continue
            if not best or entry["targetSecs"] > best["targetSecs"]:
                best = entry
        if not best:
            return
        try:
            await self._wemo.set_binary_state(dev["host"], dev["port"], best["action"] == ACTION_ON)
            self._emit({"success": True, "msg": f'[enforce] "{best["ruleName"]}" → {_action_label(best["action"])} restored on {dev["name"]} ✓'})
        except Exception as e:
            self._emit({"success": False, "msg": f'[enforce] FAILED on {dev["name"]}: {e}'})

    async def _fire_trigger_rules(self, source_key: str, is_on: bool) -> None:
        rules = [r for r in self._store.get_dwm_rules()
                 if r.get("enabled") and r.get("type") == "Trigger"
                 and r.get("triggerDevice")
                 and f"{r['triggerDevice']['host']}:{r['triggerDevice']['port']}" == source_key]

        for rule in rules:
            event = rule.get("triggerEvent", "any")
            if event != "any" and (event == "on") != is_on:
                continue

            action = rule.get("action", "mirror")
            if action == "on":
                target_on = True
            elif action == "off":
                target_on = False
            elif action == "mirror":
                target_on = is_on
            elif action == "opposite":
                target_on = not is_on
            else:
                continue

            for dev in (rule.get("actionDevices") or []):
                if not dev.get("host") or not dev.get("port"):
                    continue
                try:
                    await self._wemo.set_binary_state(dev["host"], int(dev["port"]), target_on)
                    self._emit({"success": True, "msg": f'[trigger] "{rule["name"]}" → {dev.get("name", dev["host"])} {"ON" if target_on else "OFF"} ✓'})
                except Exception as e:
                    self._emit({"success": False, "msg": f'[trigger] "{rule["name"]}" FAILED: {e}'})

    # ── Heartbeat / Status ────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Independent heartbeat — writes status every heartbeat_s seconds."""
        self._write_heartbeat()  # write immediately on start
        while self._running:
            await asyncio.sleep(self._heartbeat_s)
            try:
                self._write_heartbeat()
            except Exception:
                pass

    def _write_heartbeat(self) -> None:
        try:
            status = self._build_status()
            self._store.save_heartbeat({
                "running": True,
                "startedAt": self._started_at.isoformat() + "Z" if self._started_at else None,
                "totalEntries": status["totalEntries"],
                "upcoming": status["upcoming"][:3],
                "heartbeatInterval": self._heartbeat_s,
                "lastFire": self._last_fire,
            })
        except Exception:
            pass

    def _build_status(self) -> dict:
        now = datetime.now()
        now_secs = _secs_from_midnight(now)
        today_id = _py_to_wemo_day(now.weekday())

        away_active = [
            {"ruleName": loop["rule"]["name"], "action": "ON (Away)" if loop["is_on"] else "OFF (Away)", "at": "now"}
            for loop in self._away_loops.values()
        ]

        seen: set[str] = set()
        upcoming = []
        for e in sorted((e for e in self._schedule if e["dayId"] == today_id and e["targetSecs"] > now_secs and not e.get("isAwayEnd")),
                        key=lambda x: x["targetSecs"]):
            k = f"{e['ruleId']}|{e['targetSecs']}|{e['action']}|{e.get('targetHost','')}"
            if k not in seen:
                seen.add(k)
                upcoming.append({
                    "ruleName": e["ruleName"],
                    "targetHost": e.get("targetHost", ""),
                    "action": "Away Mode start" if e.get("isAwayStart") else _action_label(e["action"]),
                    "at": _secs_to_hhmm(e["targetSecs"]),
                })

        return {
            "running": self._running,
            "totalEntries": len(self._schedule),
            "awayActive": away_active,
            "upcoming": (away_active + upcoming)[:8],
        }
