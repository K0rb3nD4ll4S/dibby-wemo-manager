"""Dibby Wemo — Home Assistant integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from . import wemo_client
from .const import (
    CONF_DISCOVERY_TIMEOUT,
    CONF_HEARTBEAT_INTERVAL,
    CONF_MANUAL_DEVICES,
    CONF_POLL_INTERVAL,
    DEFAULT_DISCOVERY_TIMEOUT_S,
    DEFAULT_POLL_INTERVAL_S,
    HEARTBEAT_S,
    DOMAIN,
)
from .coordinator import WemoCoordinator
from .store import DwmStore

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SWITCH]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Dibby Wemo from a config entry."""
    store = await DwmStore.async_create(hass, hass.config.config_dir)

    # Discover + merge devices
    timeout = entry.data.get(CONF_DISCOVERY_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT_S)
    try:
        fresh = await wemo_client.discover_devices(timeout_s=float(timeout))
    except Exception as e:
        _LOGGER.warning("SSDP discovery failed: %s — using cached devices", e)
        fresh = []

    # Add any manual devices
    for md in entry.data.get(CONF_MANUAL_DEVICES, []):
        if md.get("host"):
            fresh.append({"host": md["host"], "port": md.get("port", 49153)})

    devices = store.merge_devices(fresh) if fresh else store.get_devices()

    poll_interval = entry.data.get(CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL_S)
    heartbeat_s   = entry.data.get(CONF_HEARTBEAT_INTERVAL, HEARTBEAT_S)
    coordinator = WemoCoordinator(hass, store, devices, poll_interval_s=poll_interval,
                                  heartbeat_s=heartbeat_s)

    await coordinator.async_config_entry_first_refresh()
    await coordinator.async_start_scheduler()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Dibby Wemo config entry."""
    coordinator: WemoCoordinator = hass.data[DOMAIN].get(entry.entry_id)
    if coordinator:
        await coordinator.async_stop_scheduler()

    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unloaded
