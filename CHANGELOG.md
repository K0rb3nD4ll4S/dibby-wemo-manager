# Changelog

All notable changes to Dibby Wemo Manager are documented here.

---

## [2.0.10] — 2026-04-04

### Bug Fix — Heartbeat Interval setting fails to save in Homebridge UI

Added missing `"maximum": 300` to the `heartbeatInterval` field in `config.schema.json`. Homebridge's schema validator requires both `minimum` and `maximum` on integer fields — without `maximum` the config would fail to save when `heartbeatInterval` was manually added.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.7** (npm)

---

## [2.0.9] — 2026-04-04

### Bug Fix — Infinite scroll on Devices and Rules tabs

The Homebridge UI panel no longer scrolls endlessly when there are few or no devices/rules. Removed `min-height: 100vh` from the UI body which was forcing the page to always fill the full viewport height.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.6** (npm)

---

## [2.0.8] — 2026-04-04

### Homebridge Verified + Donate Button

- Plugin is now **Verified by Homebridge** — badge added to README.
- Added PayPal **donate button** (`funding` field in `package.json`) — visible on the plugin tile in the Homebridge UI.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.5** (npm)

---

## [2.0.7] — 2026-04-01

### New Feature — Configurable Scheduler Heartbeat Interval

The DWM scheduler heartbeat is now decoupled from the 30-second tick and runs on its own independent timer (default: **1 second**). The interval is user-configurable from 1 to 300 seconds. The stale-detection threshold in the UI scales automatically with the configured interval (3× interval + 5 s grace).

**Why this matters:** IFTTT and HomeKit automations triggered by device state changes now reflect scheduler status within 1 second instead of waiting up to 90 seconds for the next tick cycle.

**Homebridge** — add to `config.json` platform block (or set via Homebridge UI):
```json
"heartbeatInterval": 1
```

**Home Assistant** — configurable in the integration Options flow (Settings → Devices & Services → Dibby Wemo → Configure).

### Affected packages
- `homebridge-dibby-wemo` → **2.0.4** (npm)
- `custom_components/dibby_wemo` → **2.0.5** (Home Assistant / HACS)
- `node-red-contrib-dibby-wemo` → **2.0.1** (npm — README added)
- Desktop app (Windows / Linux / macOS) → **2.0.7**
- Android app → **2.0.7**
- Docker image → `ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager:2.0.7`

---

## [2.0.6] — 2026-04-01

### New Feature — Node-RED Contrib Package

New `node-red-contrib-dibby-wemo` package published to npm — drag-and-drop Wemo nodes for Node-RED flows. Auto-indexed at flows.nodered.org.

**Four nodes included:**

| Node | Description |
|------|-------------|
| `wemo-config` | Shared config node — device IP + port |
| `wemo-control` | Send ON/OFF/toggle → get confirmed state back |
| `wemo-state` | Poll device state on interval → emit on change |
| `wemo-discover` | Trigger SSDP scan → one msg per device found |

**Install in Node-RED:**
```
Palette Manager → search: node-red-contrib-dibby-wemo → Install
```

### Affected packages
- `node-red-contrib-dibby-wemo` → **2.0.0** (new, npm)

---

## [2.0.5] — 2026-04-01

### New Feature — MQTT Bridge

New `packages/mqtt-bridge` workspace package: a lightweight Node.js service that bridges all Wemo devices to any MQTT broker, with Home Assistant MQTT Auto-Discovery built in.

**What it does:**
- Discovers Wemo devices via SSDP (+ optional manual device list)
- Publishes `ON`/`OFF` state to `dibby-wemo/{device}/state` on every change
- Subscribes to `dibby-wemo/{device}/set` for remote control
- Publishes `online`/`offline` availability per device and bridge LWT
- Registers all devices with Home Assistant automatically via `homeassistant/switch/{device}/config`
- Re-scans for new devices every 2 minutes

**Ships with:**
- `Dockerfile` — `ghcr.io/k0rb3nd4ll4s/dibby-wemo-mqtt:latest` (linux/amd64 + arm64)
- `docker-compose.yml` — one `docker compose up` starts both Mosquitto broker + bridge
- `mosquitto.conf` — minimal broker config included
- `build-mqtt.yml` — GitHub Actions workflow for multi-platform Docker build

**Works with:** Home Assistant, Node-RED, openHAB, Hubitat, Domoticz, and any MQTT-capable platform simultaneously.

**Usage:**
```bash
cd packages/mqtt-bridge
docker compose up -d
```

### Affected packages
- `@wemo-manager/mqtt-bridge` → **2.0.0** (new)
- Docker image: `ghcr.io/k0rb3nd4ll4s/dibby-wemo-mqtt:2.0.0`

---

## [2.0.4] — 2026-04-01

### Fixes & CI

- **manifest.json key order corrected** — `domain` and `name` first, then alphabetical. Required for hassfest validation.
- **Brand icon added** — `custom_components/dibby_wemo/icon.png` and `brand/icon.png` / `brand/logo.png` added for HACS validation.
- **HACS Action and hassfest workflows added** — Both CI checks now run on every push and both pass green.
- **HACS default PR resubmitted** (#6684) — From a feature branch with full checklist and all required links.

### Affected packages
- `custom_components/dibby_wemo` → **2.0.4** (Home Assistant / HACS)

---

## [2.0.3] — 2026-04-01

### Improvements

- **Devices registered in alphabetical order** — Homebridge and Home Assistant now register Wemo devices sorted by friendly name (A→Z). Affects newly added devices; existing devices already in the registry retain their current position unless removed and re-added.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.3** (npm)
- `custom_components/dibby_wemo` → **2.0.3** (Home Assistant / HACS)

---

## [2.0.2] — 2026-04-01

### Bug Fixes

- **Scheduler heartbeat always writes** — The DWM scheduler heartbeat was inside the tick's try/catch block. On Node.js v24 (Homebridge) and Python asyncio (Home Assistant), any tick-level error caused the heartbeat to be skipped, making the UI permanently show the orange "Scheduler may be unresponsive" warning even when the scheduler was running fine. The heartbeat now writes unconditionally after every tick.
- **Config form Save/Cancel buttons sticky** (Homebridge UI) — On Firefox and Safari, long rule forms (e.g. Schedule rules with many days selected) pushed the Save/Cancel buttons below the visible area with no scroll target. The buttons are now pinned to the bottom of the form with `position:sticky`.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.2** (npm)
- `custom_components/dibby_wemo` → **2.0.2** (Home Assistant / HACS)

---

## [2.0.1] — 2026-03-30

### Bug Fixes

- **Countdown rules now trigger when device is already in trigger state** — If a device was already ON (or OFF) when the scheduler started, the countdown rule never fired because the first health-poll was skipped by a `prevState !== undefined` guard. Removed the guard so the scheduler catches current device state on the first poll (~10 s after start).
- **Countdown state cleared on reload** — `_countdownStates` is now cleared when the scheduler reloads, so newly created or edited countdown rules take effect within one poll cycle without requiring a manual device toggle.

### New features

- **Home Assistant integration** — Full `custom_components/dibby_wemo` Python async integration. Supports all 5 DWM rule types (Schedule, Countdown, Away Mode, AlwaysOn, Trigger), SSDP device discovery, native Wemo firmware rules (FetchRules/StoreRules), sunrise/sunset scheduling, and HACS distribution. No pip dependencies — pure Python stdlib.
- **npm publication** — `homebridge-dibby-wemo` published to npm registry.
- Published to **HACS default** repository (PR #6680).
- Submitted for **Homebridge verified publisher** status (PR #988).

### Affected packages
- `homebridge-dibby-wemo` → **2.0.1** (npm)
- `custom_components/dibby_wemo` → **2.0.1** (Home Assistant / HACS)
- Desktop app (Windows / Linux / macOS) → **2.0.1**
- Android app → **2.0.1**
- Docker image → `ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager:2.0.1`

---

## [2.0.0] — 2026-03-28

### Initial public release

- Desktop app with full device discovery, power control, and DWM rules CRUD
- Homebridge plugin with custom UI rules tab
- DWM scheduling engine: Schedule, Countdown, Away Mode, AlwaysOn, Trigger
- Native Wemo firmware rule management (SQLite-over-ZIP via FetchRules/StoreRules)
- Sunrise/sunset scheduling (NOAA algorithm, no API key required)
- Cross-platform builds: Windows, Linux, macOS, Android, Docker
