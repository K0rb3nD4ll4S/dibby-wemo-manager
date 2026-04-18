'use strict';

/**
 * Local App Scheduler
 *
 * Reads DWM rules from the local app database (store.js) and fires
 * SetBinaryState SOAP commands at the correct wall-clock times.
 *
 * Rule types handled:
 *  - Schedule / Away (fixed times)   → pre-computed {dayId, targetSecs, action} entries
 *  - Countdown with active window    → ON at windowStart, OFF at windowEnd (cross-midnight aware)
 *  - Away Mode                       → randomisation loop: ON 30–90 min, OFF 1–15 min within window
 *  - AlwaysOn                        → health monitor enforces ON every 10 s; no schedule entry
 *  - Trigger                         → if device A changes state, fire action on device B
 *
 * Sun-based times (startTime < 0) are skipped for now.
 */

const wemo      = require('./wemo');
const store     = require('./store');
const { sunTimes: calcSunTimes } = require('./core/sun');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wemo DayID: 1=Mon … 7=Sun.  JS getDay(): 0=Sun … 6=Sat. */
function jsToWemoDayId(jsDay) { return jsDay === 0 ? 7 : jsDay; }

function secondsFromMidnight(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function secsToHHMM(secs) {
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function actionLabel(a) {
  return a === 1 ? 'ON' : a === 0 ? 'OFF' : `action(${a})`;
}

function randBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ── Scheduler class ──────────────────────────────────────────────────────────

const HEALTH_POLL_MS   = 10_000;          // poll devices every 10 seconds
const CATCHUP_WINDOW_S = 10 * 60;         // catch up rules missed within last 10 minutes

class LocalScheduler {
  constructor() {
    this._schedule      = [];          // pre-computed time entries for Schedule/Countdown rules
    this._awayLoops     = new Map();   // ruleId → away-loop state for active Away Mode rules
    this._firedToday    = new Set();   // prevent double-firing within a tick window
    this._timers        = [];
    this._tickTimer     = null;
    this._running       = false;
    this._lastDate      = null;
    this._onFire        = null;        // ({success, msg, entry}) notification callback
    this._onStatus      = null;        // (statusObj) status callback
    this._onHealth      = null;        // ({host, port, name, online, msg}) health event callback
    this._deviceHealth  = new Map();   // 'host:port' → true | false
    this._triggerStates   = new Map();   // 'host:port' → last known boolean state (for Trigger rules)
    this._countdownStates = new Map();   // 'host:port' → last known boolean state (for Countdown rules)
    this._countdownTimers = new Map();   // 'deviceKey-ruleId' → {timer, wantOn}
    this._healthTimer     = null;
    this._startedAt     = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setDevices(_devices) { /* no-op — DWM rules store target host/port directly */ }
  onFire(cb)   { this._onFire   = cb; }
  onStatus(cb) { this._onStatus = cb; }
  onHealth(cb) { this._onHealth = cb; }

  getHealthStatus() {
    const out = {};
    for (const [key, online] of this._deviceHealth) out[key] = online;
    return out;
  }

  async start(_devices) {
    if (this._running) this._clearTimers();
    this._running    = true;
    this._startedAt  = new Date();
    this._firedToday = new Set();

    this._loadSchedule();
    this._resumeAwayLoops();   // re-arm any Away windows already in progress
    this._catchUpMissedRules();
    this._tick();
    this._startHealthMonitor();

    const status = this._buildStatus();
    this._onStatus?.(status);
    return status;
  }

  stop() {
    this._running = false;
    this._clearTimers();
    this._stopAllAwayLoops(false);
    this._stopHealthMonitor();
    this._schedule      = [];
    this._firedToday    = new Set();
    this._lastDate      = null;
    this._deviceHealth  = new Map();
    this._triggerStates = new Map();
    return { running: false };
  }

  reload() {
    if (!this._running) return;
    this._stopAllAwayLoops(false);
    this._countdownStates.clear();
    this._loadSchedule();
    this._resumeAwayLoops();
    const status = this._buildStatus();
    this._onStatus?.(status);
    return status;
  }

  getStatus() { return this._buildStatus(); }

  // ── Schedule loading ─────────────────────────────────────────────────────

  _loadSchedule() {
    const schedule = [];
    const rules    = store.getDwmRules();

    // Compute today's sunrise/sunset once — used to resolve sun-based start/end times
    const loc = store.getLocation();
    const todaySun = (loc?.lat != null && loc?.lng != null)
      ? calcSunTimes(loc.lat, loc.lng)
      : null;

    /**
     * Convert a raw stored time value to seconds-from-midnight.
     * -2 = sunrise sentinel, -3 = sunset sentinel (set by RuleEditor.jsx saveDwm).
     * offsetMins is added/subtracted from the sun time (e.g. "30 min before sunset").
     * Returns null if the time cannot be resolved (no location, polar day/night, or no time set).
     */
    const resolveSecs = (rawSecs, type, offsetMins) => {
      const offsetSecs = (offsetMins ?? 0) * 60;
      if (type === 'sunset'  || rawSecs === -3) {
        return todaySun?.sunset  != null ? todaySun.sunset  + offsetSecs : null;
      }
      if (type === 'sunrise' || rawSecs === -2) {
        return todaySun?.sunrise != null ? todaySun.sunrise + offsetSecs : null;
      }
      return rawSecs >= 0 ? rawSecs : null;
    };

    for (const rule of rules) {
      if (!rule.enabled) continue;

      // ── AlwaysOn / Trigger — handled entirely by the health-monitor poll ──
      if (rule.type === 'AlwaysOn' || rule.type === 'Trigger') continue;

      // ── Away Mode — handled by the randomisation loop, not pre-computed entries ──
      if (rule.type === 'Away') {
        const startSecs = resolveSecs(Number(rule.startTime ?? -1), rule.startType, rule.startOffset);
        const endSecs   = resolveSecs(Number(rule.endTime   ?? -1), rule.endType,   rule.endOffset);
        if (startSecs === null) continue; // no location set or polar day/night

        const awayStartAction = Number(rule.startAction ?? 1);
        const awayEndAction   = Number(rule.endAction   ?? 0);

        for (const dayId of (rule.days ?? [])) {
          const td0 = rule.targetDevices?.[0]; // for status display only
          // Window-start entry: fires the away loop
          schedule.push({
            ruleId:      rule.id,
            ruleName:    rule.name,
            targetHost:  td0?.host ?? '',
            targetPort:  td0?.port ?? 0,
            dayId:       Number(dayId),
            targetSecs:  startSecs,
            action:      awayStartAction,
            isAwayStart: true,
          });
          // Window-end entry: stops the away loop
          if (endSecs !== null && endSecs >= 0) {
            schedule.push({
              ruleId:     rule.id + '-away-end',
              ruleName:   rule.name,
              targetHost: td0?.host ?? '',
              targetPort: td0?.port ?? 0,
              dayId:      Number(dayId),
              targetSecs: endSecs,
              action:     awayEndAction,
              isAwayEnd:  true,
              awayRuleId: rule.id,
            });
          }
        }
        continue;
      }

      // ── Countdown — handled by the health-monitor state-change poll ─────
      if (rule.type === 'Countdown') continue;

      // ── Schedule / other time-based rules ────────────────────────────────
      const startSecs   = resolveSecs(Number(rule.startTime ?? -1), rule.startType, rule.startOffset);
      const endSecs     = resolveSecs(Number(rule.endTime   ?? -1), rule.endType,   rule.endOffset);
      const startAction = Number(rule.startAction ?? 1);
      const endAction   = Number(rule.endAction   ?? -1);
      if (startSecs === null) continue; // no location set, polar day/night, or no time defined

      for (const dayId of (rule.days ?? [])) {
        for (const td of (rule.targetDevices ?? [])) {
          if (!td.host || !td.port) continue;
          if (startAction >= 0) {
            schedule.push({ ruleId: rule.id, ruleName: rule.name,
              targetHost: td.host, targetPort: td.port,
              dayId: Number(dayId), targetSecs: startSecs, action: startAction });
          }
          if (endSecs !== null && endSecs > 0 && endAction >= 0) {
            schedule.push({ ruleId: rule.id, ruleName: rule.name,
              targetHost: td.host, targetPort: td.port,
              dayId: Number(dayId), targetSecs: endSecs, action: endAction });
          }
        }
      }
    }

    this._schedule = schedule;
    this._lastDate = new Date().toDateString();
  }

  // ── Away Mode loop ───────────────────────────────────────────────────────

  /**
   * After load/reload, check if any Away Mode rule's window is currently active
   * and start its randomisation loop if it isn't already running.
   */
  _resumeAwayLoops() {
    if (!this._running) return;
    const now     = new Date();
    const nowSecs = secondsFromMidnight(now);
    const todayId = jsToWemoDayId(now.getDay());
    const rules   = store.getDwmRules();

    for (const rule of rules) {
      if (!rule.enabled || rule.type !== 'Away') continue;
      if (this._awayLoops.has(rule.id)) continue; // already running

      const startSecs = Number(rule.startTime ?? -1);
      const endSecs   = Number(rule.endTime   ?? -1);
      if (startSecs < 0) continue;
      if (!(rule.days ?? []).includes(todayId)) continue;

      const inWindow = endSecs >= 0
        ? (startSecs <= endSecs ? (nowSecs >= startSecs && nowSecs < endSecs)
                                : (nowSecs >= startSecs || nowSecs < endSecs))
        : nowSecs >= startSecs;

      if (inWindow) {
        this._startAwayLoop(rule);
      }
    }
  }

  _startAwayLoop(rule) {
    // Stop any existing loop for this rule first
    const existing = this._awayLoops.get(rule.id);
    if (existing?.timer) clearTimeout(existing.timer);

    const devices  = (rule.targetDevices ?? []).filter(td => td.host && td.port);
    if (!devices.length) return;

    const endSecs = Number(rule.endTime ?? -1);
    const loop = { rule, devices, endSecs, timer: null, isOn: false };
    this._awayLoops.set(rule.id, loop);

    // Immediately turn ON to begin the cycle
    this._awayStep(rule.id, true);
  }

  _awayStep(ruleId, turnOn) {
    if (!this._running) return;

    const loop = this._awayLoops.get(ruleId);
    if (!loop) return;

    // Check we're still within the window
    const nowSecs = secondsFromMidnight(new Date());
    if (loop.endSecs >= 0 && nowSecs >= loop.endSecs) {
      this._stopAwayLoop(ruleId, true);
      return;
    }

    loop.isOn = turnOn;

    // Fire on all target devices
    for (const td of loop.devices) {
      wemo.setBinaryState(td.host, td.port, turnOn)
        .then(() => {
          this._onFire?.({
            success: true,
            msg: `"${loop.rule.name}" Away Mode → ${turnOn ? 'ON' : 'OFF'} (${td.host}) ✓`,
            entry: { action: turnOn ? 1 : 0 },
          });
        })
        .catch((e) => {
          this._onFire?.({
            success: false,
            msg: `"${loop.rule.name}" Away Mode → ${turnOn ? 'ON' : 'OFF'} FAILED (${td.host}): ${e.message}`,
            entry: { action: turnOn ? 1 : 0 },
          });
        });
    }

    // ON for 30–90 minutes, OFF for 1–15 minutes (matches Wemo firmware behaviour)
    const delaySecs = turnOn
      ? randBetween(30, 90) * 60
      : randBetween(1,  15) * 60;

    // Don't schedule a next step past the window end
    if (loop.endSecs >= 0) {
      const remaining = loop.endSecs - nowSecs;
      if (delaySecs >= remaining) {
        // Window will end before the next toggle — let window-end entry handle OFF
        return;
      }
    }

    loop.timer = setTimeout(() => this._awayStep(ruleId, !turnOn), delaySecs * 1000);
  }

  _stopAwayLoop(ruleId, forceOff) {
    const loop = this._awayLoops.get(ruleId);
    if (!loop) return;
    if (loop.timer) clearTimeout(loop.timer);
    this._awayLoops.delete(ruleId);

    if (forceOff) {
      const endAction = Number(loop.rule.endAction ?? 0);
      const turnOn    = endAction === 1;
      for (const td of loop.devices) {
        wemo.setBinaryState(td.host, td.port, turnOn).catch(() => {});
      }
      this._onFire?.({
        success: true,
        msg: `"${loop.rule.name}" Away Mode window ended — all devices ${turnOn ? 'ON' : 'OFF'}`,
        entry: { action: endAction },
      });
    }
  }

  _stopAllAwayLoops(forceOff) {
    for (const [id] of this._awayLoops) this._stopAwayLoop(id, forceOff);
  }

  // ── Tick / scheduling ────────────────────────────────────────────────────

  _tick() {
    if (!this._running) return;
    const now   = new Date();
    const today = now.toDateString();

    if (today !== this._lastDate) {
      this._firedToday = new Set();
      this._stopAllAwayLoops(false);
      this._loadSchedule();
      this._scheduleUpcoming();
      this._resumeAwayLoops();
      this._onStatus?.(this._buildStatus());
    } else {
      this._scheduleUpcoming();
    }

    this._tickTimer = setTimeout(() => this._tick(), 30_000);
  }

  // ── Missed-rule catch-up ─────────────────────────────────────────────────

  /**
   * On start, fire any Schedule/Countdown entries whose time fell within the
   * last CATCHUP_WINDOW_S seconds (i.e. the app/service was down when they
   * were supposed to run).  Away Mode windows are handled by _resumeAwayLoops.
   */
  _catchUpMissedRules() {
    if (!this._schedule.length) return;

    const now     = new Date();
    const nowSecs = secondsFromMidnight(now);
    const todayId = jsToWemoDayId(now.getDay());
    const missed  = [];

    for (const entry of this._schedule) {
      if (entry.isAwayStart || entry.isAwayEnd) continue;
      if (entry.dayId !== todayId) continue;

      const age = nowSecs - entry.targetSecs;
      if (age <= 0 || age > CATCHUP_WINDOW_S) continue;

      const key = `${entry.ruleId}-${entry.dayId}-${entry.targetSecs}-${entry.targetHost}`;
      if (this._firedToday.has(key)) continue;

      missed.push({ entry, key });
    }

    for (const { entry, key } of missed) {
      this._firedToday.add(key);
      this._onFire?.({ success: true, msg: `[catch-up] "${entry.ruleName}" → ${actionLabel(entry.action)} (${entry.targetHost})`, entry });
      this._fire(entry);
    }

    if (missed.length) {
      this._onStatus?.(this._buildStatus());
    }
  }

  // ── Health monitor ────────────────────────────────────────────────────────

  _startHealthMonitor() {
    if (this._healthTimer) return;
    // Small initial delay so start() returns quickly before first poll
    this._healthTimer = setTimeout(() => this._pollDeviceHealth(), 15_000);
  }

  _stopHealthMonitor() {
    if (this._healthTimer) { clearTimeout(this._healthTimer); this._healthTimer = null; }
  }

  /**
   * Collect every unique host:port referenced in enabled DWM rules,
   * probe each one, track online/offline state, and emit _onHealth events
   * on transitions.  When a device comes back online, enforce the state
   * it should currently be in according to the active schedule.
   */
  async _pollDeviceHealth() {
    if (!this._running) return;

    // Build device map: all targets + trigger source devices
    const deviceMap    = new Map(); // 'host:port' → { host, port, name }
    const allRules     = store.getDwmRules();
    const alwaysOnSet    = new Set(); // keys with an active AlwaysOn rule
    const triggerSrcSet  = new Set(); // keys that are trigger source devices
    const countdownDevMap = new Map(); // deviceKey → [{rule, td}]

    const addDev = (td) => {
      if (!td?.host || !td?.port) return;
      const key = `${td.host}:${td.port}`;
      if (!deviceMap.has(key))
        deviceMap.set(key, { host: td.host, port: Number(td.port), name: td.name ?? td.host });
      return key;
    };

    for (const rule of allRules) {
      if (!rule.enabled) continue;
      if (rule.type === 'Trigger') {
        const k = addDev(rule.triggerDevice);
        if (k) triggerSrcSet.add(k);
        for (const td of (rule.actionDevices ?? [])) addDev(td);
        continue;
      }
      for (const td of (rule.targetDevices ?? [])) {
        const k = addDev(td);
        if (!k) continue;
        if (rule.type === 'AlwaysOn') alwaysOnSet.add(k);
        if (rule.type === 'Countdown') {
          if (!countdownDevMap.has(k)) countdownDevMap.set(k, []);
          countdownDevMap.get(k).push({ rule, td });
        }
      }
    }

    for (const [key, dev] of deviceMap) {
      const wasOnline = this._deviceHealth.get(key);  // undefined = first check

      try {
        const isOn = await wemo.getBinaryState(dev.host, dev.port);

        if (wasOnline === false) {
          // ── Just came back online ──────────────────────────────────────
          this._deviceHealth.set(key, true);
          this._onHealth?.({ ...dev, online: true,
            msg: `${dev.name} came back online` });
          await this._enforceCurrentState(dev);
        } else {
          this._deviceHealth.set(key, true);
          if (wasOnline === undefined) {
            this._onHealth?.({ ...dev, online: true, msg: `${dev.name} online` });
          }
        }

        // ── AlwaysOn enforcement ──────────────────────────────────────────
        if (alwaysOnSet.has(key) && !isOn) {
          try {
            await wemo.setBinaryState(dev.host, dev.port, true);
            this._onFire?.({ success: true,
              msg: `[always-on] ${dev.name} was OFF — turned ON ✓` });
          } catch (e) {
            this._onFire?.({ success: false,
              msg: `[always-on] ${dev.name} turn-ON failed: ${e.message}` });
          }
        }

        // ── Trigger detection — fire rules if this device changed state ──
        if (triggerSrcSet.has(key)) {
          const prevState = this._triggerStates.get(key);
          this._triggerStates.set(key, isOn);
          if (prevState !== undefined && prevState !== isOn) {
            await this._fireTriggerRules(key, isOn);
          }
        }

        // ── Countdown — level-triggered: fires whenever device is IN the trigger state
        //    (not just on the transition), within optional active window. Cancels
        //    the pending timer if the device leaves the state or window. ──
        if (countdownDevMap.has(key)) {
          this._countdownStates.set(key, isOn);
          const nowSecs = secondsFromMidnight(new Date());
          for (const { rule, td } of countdownDevMap.get(key)) {
            const condition      = rule.countdownAction ?? 'on_to_off';
            const inTriggerState = condition === 'on_to_off' ? isOn : !isOn;
            const timerKey       = `${key}-${rule.id}`;
            const existing       = this._countdownTimers.get(timerKey);

            // Active window check (if defined)
            let inWindow = true;
            const winStart = Number(rule.windowStart ?? -1);
            const winEnd   = Number(rule.windowEnd   ?? -1);
            if (winStart >= 0 && winEnd >= 0) {
              const crossesMidnight = winEnd < winStart;
              inWindow = crossesMidnight
                ? (nowSecs >= winStart || nowSecs <= winEnd)
                : (nowSecs >= winStart && nowSecs <= winEnd);
            } else if (winStart >= 0) {
              inWindow = nowSecs >= winStart;
            }

            // Not in trigger state / outside window → cancel any pending timer
            if (!inTriggerState || !inWindow) {
              if (existing) { clearTimeout(existing.timer); this._countdownTimers.delete(timerKey); }
              continue;
            }

            // In trigger state AND in window. If a timer is already running, let it keep running.
            if (existing) continue;

            const wantOn     = condition === 'off_to_on';
            const durationMs = (Number(rule.countdownTime) || 60) * 1000;
            const label      = wantOn ? 'ON' : 'OFF';
            const mins       = Math.round(durationMs / 60000);
            this._onFire?.({ success: true,
              msg: `"${rule.name}" countdown started — will turn ${label} in ${mins} min (${td.host})`,
              entry: { action: wantOn ? 1 : 0 } });

            const timer = setTimeout(async () => {
              this._countdownTimers.delete(timerKey);
              try {
                await wemo.setBinaryState(td.host, td.port, wantOn);
                this._onFire?.({ success: true,
                  msg: `"${rule.name}" countdown elapsed → ${label} (${td.host}) ✓`,
                  entry: { action: wantOn ? 1 : 0 } });
              } catch (e2) {
                this._onFire?.({ success: false,
                  msg: `"${rule.name}" countdown elapsed → ${label} FAILED: ${e2.message}`,
                  entry: { action: wantOn ? 1 : 0 } });
              }
            }, durationMs);
            this._countdownTimers.set(timerKey, { timer, wantOn });
          }
        }

      } catch (e) {
        this._deviceHealth.set(key, false);
        if (wasOnline !== false) {
          this._onHealth?.({ ...dev, online: false,
            msg: `${dev.name} unreachable: ${e.message}` });
        }
      }
    }

    this._onStatus?.(this._buildStatus());

    // Schedule next poll
    if (this._running) {
      this._healthTimer = setTimeout(() => this._pollDeviceHealth(), HEALTH_POLL_MS);
    }
  }

  /**
   * For a device that just came back online, find the most recent Schedule
   * entry that should have fired today and push that state to the device.
   */
  async _enforceCurrentState(dev) {
    const now     = new Date();
    const nowSecs = secondsFromMidnight(now);
    const todayId = jsToWemoDayId(now.getDay());

    // Find the most-recently-past entry for this device today
    let best = null;
    for (const entry of this._schedule) {
      if (entry.isAwayStart || entry.isAwayEnd) continue;
      if (entry.targetHost !== dev.host) continue;
      if (entry.dayId !== todayId) continue;
      if (entry.targetSecs > nowSecs) continue;   // hasn't fired yet today

      if (!best || entry.targetSecs > best.targetSecs) best = entry;
    }

    if (!best) return; // no rule has fired today for this device

    const wantOn = best.action === 1;
    try {
      await wemo.setBinaryState(dev.host, dev.port, wantOn);
      this._onFire?.({
        success: true,
        msg: `[enforce] "${best.ruleName}" → ${actionLabel(best.action)} restored on ${dev.name} ✓`,
        entry: best,
      });
    } catch (e) {
      this._onFire?.({
        success: false,
        msg: `[enforce] "${best.ruleName}" → ${actionLabel(best.action)} FAILED on ${dev.name}: ${e.message}`,
        entry: best,
      });
    }
  }

  // ── Trigger rules ─────────────────────────────────────────────────────────

  /**
   * A trigger device changed state.  Find every enabled Trigger rule whose
   * triggerDevice matches sourceKey and whose triggerEvent matches, then
   * fire the action on each actionDevice.
   *
   * triggerEvent: 'on' | 'off' | 'any'
   * action:       'on' | 'off' | 'mirror' | 'opposite'
   */
  async _fireTriggerRules(sourceKey, isOn) {
    const rules = store.getDwmRules().filter((r) =>
      r.enabled &&
      r.type === 'Trigger' &&
      r.triggerDevice?.host &&
      `${r.triggerDevice.host}:${r.triggerDevice.port}` === sourceKey
    );

    for (const rule of rules) {
      const matches =
        rule.triggerEvent === 'any' ||
        (rule.triggerEvent === 'on'  &&  isOn) ||
        (rule.triggerEvent === 'off' && !isOn);
      if (!matches) continue;

      let targetOn;
      if      (rule.action === 'on')       targetOn = true;
      else if (rule.action === 'off')      targetOn = false;
      else if (rule.action === 'mirror')   targetOn = isOn;
      else if (rule.action === 'opposite') targetOn = !isOn;
      else continue;

      for (const dev of (rule.actionDevices ?? [])) {
        if (!dev.host || !dev.port) continue;
        try {
          await wemo.setBinaryState(dev.host, Number(dev.port), targetOn);
          this._onFire?.({ success: true,
            msg: `[trigger] "${rule.name}" → ${dev.name ?? dev.host} ${targetOn ? 'ON' : 'OFF'} ✓` });
        } catch (e) {
          this._onFire?.({ success: false,
            msg: `[trigger] "${rule.name}" → ${dev.name ?? dev.host} FAILED: ${e.message}` });
        }
      }
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    for (const { timer } of this._countdownTimers.values()) clearTimeout(timer);
    this._countdownTimers.clear();
  }

  _scheduleUpcoming() {
    if (!this._running) return;
    const now      = new Date();
    const nowSecs  = secondsFromMidnight(now);
    const todayId  = jsToWemoDayId(now.getDay());
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const windowEnd = nowSecs + 65;

    for (const entry of this._schedule) {
      if (entry.dayId !== todayId) continue;
      if (entry.targetSecs < nowSecs - 5) continue;
      if (entry.targetSecs > windowEnd) continue;

      const key = `${entry.ruleId}-${entry.dayId}-${entry.targetSecs}-${entry.targetHost}`;
      if (this._firedToday.has(key)) continue;
      this._firedToday.add(key);

      const fireAt = dayStart.getTime() + entry.targetSecs * 1000;
      const delay  = Math.max(0, fireAt - Date.now());
      const t = setTimeout(() => this._fire(entry), delay);
      this._timers.push(t);
    }
  }

  async _fire(entry) {
    // Away Mode start — kick off the randomisation loop
    if (entry.isAwayStart) {
      const rule = store.getDwmRules().find(r => r.id === entry.ruleId);
      if (rule && rule.enabled) {
        this._startAwayLoop(rule);
        this._onFire?.({ success: true, msg: `"${entry.ruleName}" Away Mode started`, entry });
      }
      return;
    }

    // Away Mode end — stop the loop and force all devices OFF
    if (entry.isAwayEnd) {
      this._stopAwayLoop(entry.awayRuleId, true);
      return;
    }

    // Normal on/off command
    const label  = actionLabel(entry.action);
    const wantOn = entry.action === 1;
    try {
      await wemo.setBinaryState(entry.targetHost, entry.targetPort, wantOn);

      // Verify 3 s later
      await new Promise((r) => setTimeout(r, 3000));
      let confirmed = true;
      try {
        const state = await wemo.getBinaryState(entry.targetHost, entry.targetPort);
        confirmed = (!!state) === wantOn;
      } catch { confirmed = null; }

      const suffix = confirmed === null ? ' (unverified)' : confirmed ? ' ✓' : ' ⚠ retrying';
      this._onFire?.({ success: true, msg: `"${entry.ruleName}" → ${label} (${entry.targetHost})${suffix}`, entry });

      if (confirmed === false) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          await wemo.setBinaryState(entry.targetHost, entry.targetPort, wantOn);
          this._onFire?.({ success: true, msg: `"${entry.ruleName}" → ${label} retry OK`, entry });
        } catch { /* silent */ }
      }
    } catch (e) {
      this._onFire?.({ success: false, msg: `"${entry.ruleName}" → ${label} FAILED: ${e.message}`, entry });
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────

  _buildStatus() {
    const now      = new Date();
    const nowSecs  = secondsFromMidnight(now);
    const todayId  = jsToWemoDayId(now.getDay());

    // Active away loops → show as "Away Mode active"
    const awayActive = [];
    for (const [, loop] of this._awayLoops) {
      awayActive.push({
        ruleName: loop.rule.name,
        action:   loop.isOn ? 'ON (Away)' : 'OFF (Away)',
        at:       'now',
      });
    }

    const seen = new Set();
    const upcoming = this._schedule
      .filter(e => e.dayId === todayId && e.targetSecs > nowSecs && !e.isAwayEnd)
      .sort((a, b) => a.targetSecs - b.targetSecs)
      .reduce((acc, e) => {
        const key = `${e.ruleId}|${e.targetSecs}|${e.action}|${e.targetHost}`;
        if (!seen.has(key)) {
          seen.add(key);
          acc.push({
            ruleName: e.ruleName,
            targetHost: e.targetHost,
            action:   e.isAwayStart ? 'Away Mode start' : actionLabel(e.action),
            at:       secsToHHMM(e.targetSecs),
          });
        }
        return acc;
      }, [])
      .slice(0, 8);

    return {
      running:      this._running,
      totalEntries: this._schedule.length,
      awayActive,
      upcoming:     [...awayActive, ...upcoming].slice(0, 8),
    };
  }
}

const scheduler = new LocalScheduler();
module.exports = scheduler;
