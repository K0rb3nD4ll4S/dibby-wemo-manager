"""
JSON persistence store for Dibby Wemo.
Saves to <ha_config_dir>/dibby-wemo.json.
Schema-compatible with the Homebridge and desktop app stores.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from .const import STORE_FILENAME

_LOGGER = logging.getLogger(__name__)


class DwmStore:
    def __init__(self, config_dir: str) -> None:
        self._path = os.path.join(config_dir, STORE_FILENAME)
        self._data: dict[str, Any] = {}
        self._load()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as f:
                self._data = json.load(f)
        except FileNotFoundError:
            self._data = {}
        except Exception as e:
            _LOGGER.warning("Could not load %s: %s — starting fresh", self._path, e)
            self._data = {}

    def _save(self) -> None:
        try:
            with open(self._path, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
        except Exception as e:
            _LOGGER.error("Could not save %s: %s", self._path, e)

    def _get(self, key: str, default=None):
        return self._data.get(key, default)

    def _set(self, key: str, value: Any) -> None:
        self._data[key] = value
        self._save()

    # ── Location ──────────────────────────────────────────────────────────────

    def get_location(self) -> dict | None:
        return self._get("location")

    def set_location(self, loc: dict) -> None:
        self._set("location", loc)

    # ── Devices ───────────────────────────────────────────────────────────────

    def get_devices(self) -> list[dict]:
        return self._get("devices", [])

    def save_devices(self, devices: list[dict]) -> None:
        self._set("devices", devices)

    def merge_devices(self, fresh: list[dict]) -> list[dict]:
        """Upsert fresh devices into saved list by UDN."""
        existing = {d["udn"]: d for d in self.get_devices() if d.get("udn")}
        for dev in fresh:
            udn = dev.get("udn")
            if udn:
                existing[udn] = {**existing.get(udn, {}), **dev}
        merged = list(existing.values())
        self.save_devices(merged)
        return merged

    # ── DWM Rules ─────────────────────────────────────────────────────────────

    def get_dwm_rules(self) -> list[dict]:
        return self._get("dwmRules", [])

    def create_dwm_rule(self, rule: dict) -> dict:
        rules = self.get_dwm_rules()
        now = _iso_now()
        uid = f"dwm-{int(time.time() * 1000)}-{os.urandom(3).hex()}"
        new_rule = {**rule, "id": uid, "createdAt": now, "updatedAt": now}
        rules.append(new_rule)
        self._set("dwmRules", rules)
        return new_rule

    def update_dwm_rule(self, rule_id: str, updates: dict) -> dict | None:
        rules = self.get_dwm_rules()
        for i, r in enumerate(rules):
            if r.get("id") == rule_id:
                rules[i] = {**r, **updates, "updatedAt": _iso_now()}
                self._set("dwmRules", rules)
                return rules[i]
        return None

    def delete_dwm_rule(self, rule_id: str) -> bool:
        rules = self.get_dwm_rules()
        new_rules = [r for r in rules if r.get("id") != rule_id]
        if len(new_rules) == len(rules):
            return False
        self._set("dwmRules", new_rules)
        return True

    # ── Heartbeat ─────────────────────────────────────────────────────────────

    def get_heartbeat(self) -> dict | None:
        return self._get("schedulerHeartbeat")

    def save_heartbeat(self, data: dict) -> None:
        self._set("schedulerHeartbeat", {**data, "ts": _iso_now()})


def _iso_now() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat() + "Z"
