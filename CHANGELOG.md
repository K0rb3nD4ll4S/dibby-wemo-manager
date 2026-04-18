# Changelog

All notable changes to Dibby Wemo Manager are documented here.

---

## [2.0.15] — 2026-04-17

### Countdown rule is now state-based, not transition-based

The DWM **Countdown** rule (auto-timer-off / auto-timer-on) is now level-triggered instead of edge-triggered. Previously the timer only started when the device *transitioned* into the trigger state — so if the device was already ON when Homebridge, Home Assistant, or the Desktop scheduler started, the auto-off timer would never run until someone manually toggled it off and back on.

**New behavior:**

- The timer runs **whenever the device is in the trigger state**, regardless of how it got there. If the device is already ON when the scheduler starts, the auto-OFF countdown starts immediately.
- If the device leaves the trigger state before the timer fires (e.g. you manually turn off an auto-off device early), the timer is **cancelled** — no surprise re-toggle.
- If the device re-enters the trigger state, a fresh countdown starts.
- If the active-window expires mid-countdown, the timer is cancelled.

**UI wording updated everywhere:**

- "If device turns ON → auto-OFF after duration" → **"If device is ON → auto-OFF after duration"**
- "If device turns OFF → auto-ON after duration" → **"If device is OFF → auto-ON after duration"**

Applied consistently to:
- Desktop app Countdown editor (`CountdownEditor.jsx`)
- Homebridge plugin rule editor + Help tab (`homebridge-ui/public/index.html`)
- Home Assistant integration scheduler (`custom_components/dibby_wemo/scheduler.py`)

Existing rules with `countdownAction: 'on_to_off'` or `'off_to_on'` continue to work unchanged — only the trigger semantics improved. No rule-store migration required.

### Affected packages
All monorepo packages bumped to **2.0.15** in unified versioning.

---

## [2.0.14] — 2026-04-13

### Unified Versioning + Node-RED Publish + Home Assistant + HOOBS + WiFi Provisioning Fix + Homebridge 2.0 Compatibility

All monorepo packages synced to a single version (**2.0.14**) for coherent release tracking. Desktop, Homebridge plugin, Home Assistant custom component, Node-RED contrib, MQTT bridge, core, and Android app now share one version across the board.

**Home Assistant custom component** — `custom_components/dibby_wemo/manifest.json` bumped to 2.0.14. HACS users on the existing repository will see the update automatically. Install via HACS → Custom Repositories → add this repo as an Integration.

**HOOBS compatibility documented** — the `homebridge-dibby-wemo` plugin is fully HOOBS-compatible (HOOBS installs any plugin from the Homebridge npm registry). Install via the HOOBS Plugins tab.

**`node-red-contrib-dibby-wemo` published to npm at 2.0.14** — four drag-and-drop Node-RED nodes (`wemo-config`, `wemo-control`, `wemo-state`, `wemo-discover`) for local Wemo control inside Node-RED flows. Install via Palette Manager or `npm install node-red-contrib-dibby-wemo`.


#### Desktop App — WiFi Setup (v2.0.9)

The **Set WiFi** feature in the desktop app was non-functional since release. When setting up a WeMo device on its setup AP (`WeMo.Switch.xxx` / 10.22.22.1), the `ConnectHomeNetwork` SOAP call always failed with HTTP 500 / UPnP 501 "Action Failed". All root causes have been identified and fixed. **Confirmed working on F7C027 firmware 2.00.11851.**

**Root causes fixed:**

- **AP scan not performed before connecting** — The WeMo firmware requires `GetApList` to be called first to prime its internal AP cache. `ConnectHomeNetwork` without a preceding scan fails on some firmware versions. The app now always scans first and uses the exact `auth`/`encrypt` strings the device reports (e.g. `WPA2PSK`/`AES`) rather than normalising them
- **ConnectHomeNetwork must be sent twice** — Confirmed from pywemo and direct device testing: the firmware only reliably accepts the connection on the second call. The app now sends the request twice in quick succession
- **Wrong network status polling logic** — Status `2` means "connecting (in progress)" and should keep polling, but was wrongly treated as "bad password". Status `1` = Connected (success), `3`/`4` = failed
- **CloseSetup never called after success** — After `GetNetworkStatus` returns `1` (Connected), `CloseSetup` must be called to let the device finalise and reboot onto the home network. This call was missing entirely
- **AES-128-CBC password encryption** — password is encrypted using the device's MAC + serial (from `MetaInfo`) as key material, exactly as the official WeMo Android app does
- **Signal bars showed dBm thresholds** — The WeMo device reports signal as 0–100% (not dBm). Signal bars and percentage labels now display correctly
- **Real-time communication log** — A live SOAP request/response log panel is now visible in the WiFi tab while connecting, showing every step with color-coded entries (blue = sent, green = received, gray = status, red = error)

**Confirmed provisioning sequence (F7C027 firmware 2.00.11851):**
1. `GetApList` — scan to prime device cache and get exact auth/encrypt strings
2. `GetMetaInfo` — fetch MAC + serial for AES-128-CBC password key derivation
3. `ConnectHomeNetwork` (flat params, CDATA-wrapped SSID, encrypted password) — sent twice
4. Poll `GetNetworkStatus` every 3 s until `1` (Connected)
5. `CloseSetup` — device finalises and reboots onto the home network

#### Homebridge Plugin — Homebridge 2.0 Compatibility (v2.0.10)

- **Homebridge 2.0 beta declared compatible** — `engines.homebridge` updated to `^1.6.0 || ^2.0.0-beta.0`. Without this declaration Homebridge 2.0 logs a compatibility warning even though the plugin works correctly
- **Node.js 22 / 24 explicitly supported** — `engines.node` updated to `^18.20.4 || ^20.15.1 || ^22 || ^24`. Homebridge 2.0 beta requires Node.js 22 or 24
- Full audit confirmed: zero usage of any APIs removed in Homebridge 2.0 (`BatteryService`, `Characteristic.getValue()`, `getServiceByUUIDAndSubType()`, `updateReachability()`, `setPrimaryService()`, enum access via `Characteristic.*` — none present)

### Affected packages
- Desktop app (Windows) → **2.0.9**
- `homebridge-dibby-wemo` → **2.0.10** (npm)

---

## [2.0.13] — 2026-04-08

### Bug Fixes & New Features — Homebridge Rules UI

**Bug fixes:**
- **Rules toggle/edit/delete now work in Homebridge UI** — Inline `onclick`/`onchange` event handlers in dynamically rendered rule cards were silently blocked by the Homebridge UI iframe's Content Security Policy. All rule card buttons (toggle, edit, delete) now use `addEventListener` after rendering, which is CSP-safe.
- **Wemo device rules delete no longer silently fails** — `confirm()` is blocked in cross-origin iframes and always returns false. The delete button for on-device Wemo rules now uses the same inline confirm row pattern already used by DWM rules.

**New features:**
- **Delete All DWM Rules** — New "🗑 Delete All" button in the DWM Rules tab header. Shows an inline confirm bar before deleting.
- **Delete All Wemo Device Rules** — New "🗑 Delete All" button in the Wemo Device Rules tab (shown after a device is selected and rules are loaded). Deletes all firmware rules from the device one-by-one.
- **Copy Wemo Rules to DWM** — New "📋 Copy to DWM" button in the Wemo Device Rules tab. Converts each on-device firmware Schedule rule to a DWM Schedule rule targeting the same device, then reloads the DWM Rules tab.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.9** (npm)

---

## [2.0.12] — 2026-04-08

### Bug Fix — Windows SSDP Device Discovery

Fixed device discovery failing on Windows when multiple network adapters are present (WiFi, VPN, Hyper-V virtual adapters, etc.).

**Root cause:** `socket.addMembership()` was called without specifying a local interface, causing the OS to pick the wrong adapter for multicast. M-SEARCH packets went out the wrong interface and Wemo devices never responded.

**Fix:** SSDP discovery now enumerates all non-internal IPv4 interfaces and creates one UDP socket per adapter, each explicitly bound to that interface's IP with `addMembership` and `setMulticastInterface`. Applied to both the desktop app and the Homebridge plugin.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)
- Desktop app (Windows) → **2.0.8**

---

## [2.0.11] — 2026-04-05

### Version sync — all packages bumped to 2.0.8

All packages aligned to v2.0.8. Windows desktop rebuilt and signed. Linux packages built via GitHub Actions. node-red-contrib published to npm.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)
- `node-red-contrib-dibby-wemo` → **2.0.8** (npm)
- Desktop app (Windows) → **2.0.8**
- Desktop app (Linux — AppImage/deb/rpm) → **2.0.8** (built via GitHub Actions)
- Android app → **2.0.8**
- Home Assistant custom component → **2.0.8**
- Docker / MQTT bridge → **2.0.8**

---

## [2.0.11] — 2026-04-05

### Feature — Heartbeat, Poll & Discovery settings now in the Settings tab

The **Settings** tab in the Homebridge UI now shows three configurable fields:
- **Scheduler Heartbeat Interval** (1–300 s) — how often the scheduler writes its status heartbeat
- **Device Poll Interval** (10–300 s) — how often device state is polled for HomeKit updates
- **Discovery Timeout** (3000–60000 ms) — how long to wait for SSDP discovery responses

Changes are saved directly to `config.json` via the **Save Settings** button. No manual JSON editing required.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)

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
