# Dibby Wemo Manager

**Local Wemo control — no Belkin cloud required.**

Dibby Wemo Manager gives you full local control of Belkin Wemo smart switches and plugs from two interfaces:

| Component | Description |
|---|---|
| 🖥️ **Desktop App** | Windows Electron app — device dashboard, power control, scheduling |
| 🏠 **Homebridge Plugin** | HomeKit integration with custom scheduling UI inside Homebridge |

Both share the same local-network Wemo protocol (UPnP/SOAP) and the same DWM scheduling engine. No Belkin account, no cloud dependency, no internet required.

---

## Repository Layout

```
wemo-manager/
├── apps/
│   └── desktop/          # Electron desktop app (Windows)
├── packages/
│   ├── homebridge-plugin/ # homebridge-dibby-wemo Homebridge plugin
│   └── wemo-core/        # Shared Wemo protocol helpers
└── package.json          # npm workspaces root
```

---

## Quick Start

### Desktop App (Windows)

Download the latest installer from [Releases](../../releases):

- **`Dibby Wemo Manager Setup 2.0.0.exe`** — NSIS installer (recommended)
- **`Dibby Wemo Manager 2.0.0.exe`** — Portable single-file executable

Run the installer, launch the app. Wemo devices are discovered automatically via SSDP on your local network.

### Homebridge Plugin

```bash
npm install -g homebridge-dibby-wemo
```

Then add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "DibbyWemo",
      "name": "DibbyWemo"
    }
  ]
}
```

Restart Homebridge. Devices appear in HomeKit automatically.

---

## Features

### 🖥️ Desktop App

- **Device dashboard** — real-time on/off status for all Wemo devices on your network
- **One-click power control** — toggle any device instantly
- **DWM Rules** — cross-device scheduling engine:
  - **Schedule** — turn devices on/off at specific times on selected days
  - **Countdown** — active-window timer (on at sunset, off at midnight, etc.)
  - **Away Mode** — randomised on/off simulation while you're away
  - **Always On** — enforce a device stays on; auto-corrects within 10 seconds
  - **Trigger** — IFTTT-style: when device A changes state, control device B
- **Native firmware rules** — read, toggle and delete rules stored on the Wemo device itself
- **Standalone service** — Windows background service that enforces rules even when the GUI is closed
- **Web remote** — optional local web interface accessible from your phone
- **Sunrise/sunset support** — location-aware scheduling via city search

### 🏠 Homebridge Plugin

- All Wemo devices registered as **HomeKit switches**
- Custom Homebridge UI panel with five tabs:
  - **Devices** — live device list with on/off toggle
  - **DWM Rules** — full scheduling CRUD (same rule types as desktop)
  - **Device Rules** — native firmware rule management
  - **Settings** — city/location search for sunrise/sunset times
  - **Help** — built-in documentation
- **Scheduler health monitor** — green/amber/red status bar shows scheduler state in real time
- **Catch-up on restart** — rules missed while Homebridge was restarting fire automatically on startup
- No cloud required; all communication is local SOAP/UPnP

---

## Supported Devices

Tested and confirmed working:

| Model | Name |
|---|---|
| WLS0403 | Wemo 3-Way Smart Switch |
| WLS040 | Wemo Light Switch |
| F7C030 | Wemo Light Switch (older) |
| F7C027 | Wemo Switch / Mini Smart Plug |
| F7C029 | Wemo Insight Smart Plug |
| F7C063 | Wemo Mini Smart Plug v2 |

> **Note:** Wemo Dimmer V2 (WDS060) with newer RTOS firmware does not expose the `FetchRules`/`StoreRules` UPnP service. These devices are detected and support on/off control but native firmware rule editing is unavailable.

---

## Architecture

### Wemo Protocol

All communication is local UPnP/SOAP over HTTP — no Belkin cloud:

| Operation | Method |
|---|---|
| Discovery | SSDP M-SEARCH multicast to `239.255.255.250:1900` |
| Device info | HTTP GET `http://<ip>:<port>/setup.xml` |
| On/Off | UPnP SOAP `SetBinaryState` / `GetBinaryState` |
| State query | UPnP SOAP `GetBinaryState` |
| Native rules | UPnP SOAP `FetchRules` / `StoreRules` (ZIP + SQLite) |

### Native Firmware Rules Database

The Wemo device stores rules in a SQLite database inside a ZIP archive:

1. `FetchRules` returns a URL to download the ZIP
2. The ZIP contains `temppluginRules.db` (SQLite)
3. Modify the SQLite, re-ZIP, base64-encode
4. `StoreRules` uploads the encoded database

> **Critical:** `StoreRules` requires the base64 body wrapped in entity-encoded CDATA:
> `&lt;![CDATA[base64data]]&gt;`
> Standard XML builders cannot produce this format — the SOAP envelope must be hand-crafted.

### DWM Scheduling Engine

The DWM (Dibby Wemo Manager) scheduler is a Node.js process that:

- Loads rules from a JSON store (`dibby-wemo.json`)
- Ticks every **30 seconds**, reloading rules on each tick (live edits take effect without restart)
- Pre-schedules events within a **65-second look-ahead window**
- On startup, catches up any rules missed within the last **10 minutes**
- Runs a **health monitor** every 10 seconds for AlwaysOn and Trigger rules
- Writes a **heartbeat** to the store on every tick so the UI can show scheduler status

---

## Development

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Install dependencies

```bash
# From repo root
npm install
```

### Desktop App — dev mode

```bash
cd apps/desktop
npm run dev
```

### Desktop App — build Windows installer

```bash
cd apps/desktop
npm run build:win
```

Output in `apps/desktop/dist/`:
- `Dibby Wemo Manager Setup 2.0.0.exe` — NSIS installer
- `Dibby Wemo Manager 2.0.0.exe` — portable EXE

### Homebridge Plugin — install locally

```bash
cd packages/homebridge-plugin
npm install -g .
```

Then restart Homebridge.

---

## Release Assets

Each [GitHub Release](../../releases) includes:

| File | Description |
|---|---|
| `Dibby Wemo Manager Setup 2.0.0.exe` | Windows NSIS installer (recommended) |
| `Dibby Wemo Manager 2.0.0.exe` | Windows portable executable |
| `homebridge-dibby-wemo-1.0.0.tgz` | Homebridge plugin npm package |

---

## License

MIT — see [LICENSE](LICENSE)

---

*Built by SRS IT. All Wemo communication is local — your device data never leaves your network.*
