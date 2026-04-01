"""Wemo switch platform — one SwitchEntity per discovered device."""

from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import wemo_client
from .const import DOMAIN, MANUFACTURER
from .coordinator import WemoCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WemoCoordinator = hass.data[DOMAIN][entry.entry_id]
    devices = sorted(coordinator._devices, key=lambda d: (d.get("name") or d.get("friendlyName") or d.get("host", "")).lower())
    async_add_entities(
        WemoSwitch(coordinator, dev) for dev in devices
    )


class WemoSwitch(CoordinatorEntity, SwitchEntity):
    """Represents a single Wemo device as a HA switch."""

    def __init__(self, coordinator: WemoCoordinator, device: dict) -> None:
        super().__init__(coordinator)
        self._device = device
        self._udn = device.get("udn", f"{device['host']}:{device['port']}")
        self._attr_unique_id = self._udn
        self._attr_name = device.get("name") or device.get("friendlyName") or device["host"]

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._udn)},
            name=self._attr_name,
            manufacturer=MANUFACTURER,
            model=self._device.get("model") or self._device.get("productModel", "Wemo Device"),
            sw_version=self._device.get("firmware") or self._device.get("firmwareVersion"),
        )

    @property
    def is_on(self) -> bool | None:
        if self.coordinator.data:
            return self.coordinator.data.get(self._udn)
        return None

    @property
    def available(self) -> bool:
        return self.coordinator.last_update_success and self.is_on is not None

    async def async_turn_on(self, **kwargs) -> None:
        try:
            await wemo_client.set_binary_state(
                self._device["host"], self._device["port"], True
            )
            await self.coordinator.async_request_refresh()
        except Exception as e:
            _LOGGER.error("Failed to turn on %s: %s", self._attr_name, e)

    async def async_turn_off(self, **kwargs) -> None:
        try:
            await wemo_client.set_binary_state(
                self._device["host"], self._device["port"], False
            )
            await self.coordinator.async_request_refresh()
        except Exception as e:
            _LOGGER.error("Failed to turn off %s: %s", self._attr_name, e)
