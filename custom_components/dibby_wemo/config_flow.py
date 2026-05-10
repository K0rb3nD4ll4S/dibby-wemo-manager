"""Config flow — UI setup for Dibby Wemo integration.

Discovery strategy (v2.0.19+):
  1. Home Assistant's own SSDP service discovers Wemo devices at the supervisor
     level (which has multicast access regardless of Docker/container sandboxing)
     and pushes them to us via `async_step_ssdp`. Each discovered device creates
     a single config entry the first time, then subsequent SSDP announcements
     are ignored (we already know about that device).
  2. DHCP discovery via Wemo OUI MAC prefixes (`manifest.json` `dhcp` list)
     triggers `async_step_dhcp` when a new device joins the network.
  3. Manual user step (`async_step_user`) lets the user enter device IPs by
     hand if neither SSDP nor DHCP discovers their devices (most common in
     Docker `bridge` networking or hostile router setups).

All paths converge on a single config entry — there is only ever one Dibby
Wemo integration per Home Assistant install, and it manages all discovered
Wemos as child devices via the coordinator.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

try:  # Newer HA versions expose typed helpers; older ones just use plain dicts
    from homeassistant.helpers.service_info.ssdp import SsdpServiceInfo
except ImportError:  # pragma: no cover — HA <2024.4
    SsdpServiceInfo = dict  # type: ignore[assignment, misc]

try:
    from homeassistant.helpers.service_info.dhcp import DhcpServiceInfo
except ImportError:  # pragma: no cover
    DhcpServiceInfo = dict  # type: ignore[assignment, misc]

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

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_DISCOVERY_TIMEOUT, default=DEFAULT_DISCOVERY_TIMEOUT_S): vol.All(
            int, vol.Range(min=3, max=60)
        ),
        vol.Optional(CONF_POLL_INTERVAL, default=DEFAULT_POLL_INTERVAL_S): vol.All(
            int, vol.Range(min=10, max=300)
        ),
        vol.Optional(CONF_HEARTBEAT_INTERVAL, default=HEARTBEAT_S): vol.All(
            int, vol.Range(min=1, max=300)
        ),
        vol.Optional(CONF_MANUAL_DEVICES, default=""): str,
    }
)


def _parse_manual_devices(raw: str) -> list[dict]:
    """Parse 'ip[:port], ip[:port], ...' into a list of {host, port} dicts.

    Accepts whitespace, commas, semicolons, newlines as separators. Default
    port 49153 is the standard Wemo UPnP port. Silently skips entries that
    don't look like an IP.
    """
    out: list[dict] = []
    if not raw:
        return out
    for piece in raw.replace(";", ",").replace("\n", ",").split(","):
        piece = piece.strip()
        if not piece:
            continue
        host, _, port = piece.partition(":")
        host = host.strip()
        if not host:
            continue
        try:
            port_num = int(port) if port else 49153
        except ValueError:
            port_num = 49153
        out.append({"host": host, "port": port_num})
    return out


class DibbyWemoConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the initial setup flow."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: list[dict] = []
        self._options: dict = {}
        self._pending_host: str | None = None
        self._pending_port: int | None = None
        self._pending_name: str | None = None

    # ── HA-pushed SSDP discovery ────────────────────────────────────────────

    async def async_step_ssdp(self, discovery_info) -> FlowResult:
        """HA's supervisor saw a Belkin device via SSDP — single-instance the integration."""
        # Extract host + port from the SSDP LOCATION header (e.g. http://192.168.1.5:49153/setup.xml)
        try:
            location = discovery_info.ssdp_location  # type: ignore[union-attr]
        except AttributeError:
            location = discovery_info.get("ssdp_location") if isinstance(discovery_info, dict) else None

        if not location:
            return self.async_abort(reason="not_wemo_device")

        parsed = urlparse(location)
        host = parsed.hostname or ""
        port = parsed.port or 49153

        # Friendly name from SSDP upnp data
        try:
            upnp = discovery_info.upnp  # type: ignore[union-attr]
        except AttributeError:
            upnp = discovery_info.get("upnp", {}) if isinstance(discovery_info, dict) else {}
        name = upnp.get("friendlyName") or host

        self._pending_host = host
        self._pending_port = port
        self._pending_name = name

        # We use a single config entry for the whole integration; if it already
        # exists, just notify it about the new device and abort the flow.
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        return await self.async_step_discovery_confirm()

    async def async_step_dhcp(self, discovery_info) -> FlowResult:
        """HA saw a device with a Belkin MAC OUI on the network — same flow as SSDP."""
        try:
            host = discovery_info.ip  # type: ignore[union-attr]
        except AttributeError:
            host = discovery_info.get("ip") if isinstance(discovery_info, dict) else None

        if not host:
            return self.async_abort(reason="not_wemo_device")

        self._pending_host = host
        self._pending_port = 49153
        self._pending_name = host

        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        return await self.async_step_discovery_confirm()

    async def async_step_discovery_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Confirmation step — user clicks through to create the integration."""
        if user_input is not None:
            # Run a full discovery scan now so the entry starts with all known devices
            try:
                self._discovered = await wemo_client.discover_devices(timeout_s=10.0)
            except Exception as e:
                _LOGGER.warning("Initial discovery scan failed: %s — entry will rely on HA SSDP", e)
                self._discovered = []

            return self.async_create_entry(
                title="Dibby Wemo",
                data={
                    CONF_DISCOVERY_TIMEOUT: DEFAULT_DISCOVERY_TIMEOUT_S,
                    CONF_POLL_INTERVAL: DEFAULT_POLL_INTERVAL_S,
                    CONF_HEARTBEAT_INTERVAL: HEARTBEAT_S,
                    CONF_MANUAL_DEVICES: [],
                },
            )

        return self.async_show_form(
            step_id="discovery_confirm",
            description_placeholders={
                "name": self._pending_name or "Wemo",
                "host": self._pending_host or "",
            },
        )

    # ── Manual / user-initiated setup ───────────────────────────────────────

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """User initiated setup via Add Integration UI."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            self._options = {
                CONF_DISCOVERY_TIMEOUT: user_input.get(CONF_DISCOVERY_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT_S),
                CONF_POLL_INTERVAL:     user_input.get(CONF_POLL_INTERVAL,     DEFAULT_POLL_INTERVAL_S),
                CONF_HEARTBEAT_INTERVAL: user_input.get(CONF_HEARTBEAT_INTERVAL, HEARTBEAT_S),
                CONF_MANUAL_DEVICES:    _parse_manual_devices(user_input.get(CONF_MANUAL_DEVICES, "")),
            }
            return await self.async_step_discover()

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            description_placeholders={
                "manual_hint": "Optional: comma-separated IP[:port] list if SSDP doesn't find your devices",
            },
        )

    async def async_step_discover(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Step 2 — run discovery, also probe manual entries, then create the entry."""
        if user_input is None:
            timeout = self._options.get(CONF_DISCOVERY_TIMEOUT, DEFAULT_DISCOVERY_TIMEOUT_S)
            try:
                ssdp_found = await wemo_client.discover_devices(timeout_s=float(timeout))
            except Exception as e:
                _LOGGER.warning("SSDP discovery failed: %s", e)
                ssdp_found = []

            # Merge with manual entries, dedup by host
            seen: set[str] = set()
            merged: list[dict] = []
            for d in ssdp_found + list(self._options.get(CONF_MANUAL_DEVICES, []) or []):
                key = f"{d.get('host')}:{d.get('port', 49153)}"
                if key in seen:
                    continue
                seen.add(key)
                merged.append(d)
            self._discovered = merged

            device_lines = "\n".join(
                f"• {d.get('name', d['host'])} ({d['host']}:{d.get('port', 49153)})"
                for d in self._discovered
            ) or (
                "No devices found yet. The integration will still be created and "
                "will pick up devices via Home Assistant's own SSDP / DHCP discovery "
                "automatically. You can also add IPs manually under Configure later."
            )

            return self.async_show_form(
                step_id="discover",
                data_schema=vol.Schema({}),
                description_placeholders={"devices": device_lines},
            )

        return self.async_create_entry(
            title="Dibby Wemo",
            data={
                **self._options,
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
            patched = {
                CONF_DISCOVERY_TIMEOUT: user_input[CONF_DISCOVERY_TIMEOUT],
                CONF_POLL_INTERVAL:     user_input[CONF_POLL_INTERVAL],
                CONF_HEARTBEAT_INTERVAL: user_input[CONF_HEARTBEAT_INTERVAL],
                CONF_MANUAL_DEVICES:    _parse_manual_devices(user_input.get(CONF_MANUAL_DEVICES, "")),
            }
            return self.async_create_entry(title="", data=patched)

        # Render current manual devices as comma-separated for the text field
        current_manual = self._entry.data.get(CONF_MANUAL_DEVICES, []) or []
        manual_str = ", ".join(
            f"{d.get('host')}:{d.get('port', 49153)}" if d.get('port') != 49153 else d.get('host', '')
            for d in current_manual
            if d.get('host')
        )

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
                vol.Optional(
                    CONF_HEARTBEAT_INTERVAL,
                    default=self._entry.data.get(CONF_HEARTBEAT_INTERVAL, HEARTBEAT_S),
                ): vol.All(int, vol.Range(min=1, max=300)),
                vol.Optional(CONF_MANUAL_DEVICES, default=manual_str): str,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
