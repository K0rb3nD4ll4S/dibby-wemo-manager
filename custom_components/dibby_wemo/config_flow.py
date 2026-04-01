"""Config flow — UI setup for Dibby Wemo integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from . import wemo_client
from .const import (
    CONF_DISCOVERY_TIMEOUT,
    CONF_MANUAL_DEVICES,
    CONF_POLL_INTERVAL,
    DEFAULT_DISCOVERY_TIMEOUT_S,
    DEFAULT_POLL_INTERVAL_S,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_DISCOVERY_TIMEOUT, default=DEFAULT_DISCOVERY_TIMEOUT_S): vol.All(
            int, vol.Range(min=3, max=60)
        ),
        vol.Optional(CONF_POLL_INTERVAL, default=DEFAULT_POLL_INTERVAL_S): vol.All(
            int, vol.Range(min=10, max=300)
        ),
    }
)


class DibbyWemoConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the initial setup flow."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: list[dict] = []
        self._options: dict = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Step 1 — let user set options, then auto-discover."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}

        if user_input is not None:
            self._options = user_input
            return await self.async_step_discover()

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            errors=errors,
            description_placeholders={},
        )

    async def async_step_discover(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Step 2 — run SSDP and show found devices."""
        if user_input is None:
            # Run discovery
            timeout = self._options.get(CONF_DISCOVERY_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT_S)
            try:
                self._discovered = await wemo_client.discover_devices(timeout_s=float(timeout))
            except Exception as e:
                _LOGGER.error("Discovery failed: %s", e)
                self._discovered = []

            device_lines = "\n".join(
                f"• {d.get('name', d['host'])} ({d['host']}:{d['port']})"
                for d in self._discovered
            ) or "No devices found. You can add them manually in Options."

            return self.async_show_form(
                step_id="discover",
                data_schema=vol.Schema({}),
                description_placeholders={"devices": device_lines},
            )

        # User confirmed — create the entry
        return self.async_create_entry(
            title="Dibby Wemo",
            data={
                **self._options,
                CONF_MANUAL_DEVICES: [],
            },
        )

    @staticmethod
    def async_get_options_flow(config_entry):
        return DibbyWemoOptionsFlow(config_entry)


class DibbyWemoOptionsFlow(config_entries.OptionsFlow):
    """Handle options (re-configure after setup)."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_DISCOVERY_TIMEOUT,
                    default=self._entry.data.get(CONF_DISCOVERY_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT_S),
                ): vol.All(int, vol.Range(min=3, max=60)),
                vol.Optional(
                    CONF_POLL_INTERVAL,
                    default=self._entry.data.get(CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL_S),
                ): vol.All(int, vol.Range(min=10, max=300)),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
