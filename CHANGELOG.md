# Changelog

All notable changes to Dibby Wemo Manager are documented here.

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
