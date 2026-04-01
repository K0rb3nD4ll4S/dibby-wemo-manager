"""DataUpdateCoordinator — polls all Wemo device states and drives the DWM scheduler."""

from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import wemo_client
from .const import CONF_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL_S, HEARTBEAT_S, DOMAIN
from .scheduler import DwmScheduler
from .store import DwmStore

_LOGGER = logging.getLogger(__name__)


class WemoCoordinator(DataUpdateCoordinator):
    """Polls device states every poll_interval seconds."""

    def __init__(
        self,
        hass: HomeAssistant,
        store: DwmStore,
        devices: list[dict],
        poll_interval_s: int = DEFAULT_POLL_INTERVAL_S,
        heartbeat_s: int = HEARTBEAT_S,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=poll_interval_s),
        )
        self._store = store
        self._devices = devices
        self.scheduler = DwmScheduler(store, wemo_client, hass, _LOGGER,
                                      heartbeat_s=heartbeat_s)
        self.scheduler.on_fire(self._on_scheduler_fire)
        self.scheduler.on_health(self._on_device_health)

    # ── Coordinator lifecycle ─────────────────────────────────────────────────

    async def async_start_scheduler(self) -> None:
        await self.scheduler.start()

    async def async_stop_scheduler(self) -> None:
        await self.scheduler.stop()

    # ── Poll ──────────────────────────────────────────────────────────────────

    async def _async_update_data(self) -> dict[str, bool]:
        """Fetch current on/off state for all known devices. Returns {udn: is_on}."""
        states: dict[str, bool] = {}
        for dev in self._devices:
            udn = dev.get("udn", f"{dev['host']}:{dev['port']}")
            try:
                states[udn] = await wemo_client.get_binary_state(dev["host"], dev["port"])
            except Exception as e:
                _LOGGER.debug("State poll failed for %s: %s", dev.get("name", dev["host"]), e)
                # Keep last known state if available
                if self.data and udn in self.data:
                    states[udn] = self.data[udn]
        return states

    # ── Callbacks ─────────────────────────────────────────────────────────────

    def _on_scheduler_fire(self, event: dict) -> None:
        icon = "✓" if event.get("success") else "✗"
        _LOGGER.info("[DWM] %s %s", icon, event.get("msg", ""))
        # Trigger a coordinator refresh so switch states update immediately
        self.hass.async_create_task(self.async_request_refresh())

    def _on_device_health(self, event: dict) -> None:
        if event.get("online"):
            _LOGGER.info("[DWM] %s", event.get("msg", ""))
        else:
            _LOGGER.warning("[DWM] %s", event.get("msg", ""))
