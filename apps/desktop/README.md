# Dibby Wemo Manager — Desktop App

**Windows desktop application for local Belkin Wemo control.**

Full device dashboard, power control, scheduling engine, Windows background service, and optional web remote — all communicating directly with your Wemo devices over your local network. No Belkin cloud account required.

---

## Installation

Download the latest release from [GitHub Releases](../../releases):

| File | Description |
|---|---|
| `Dibby Wemo Manager Setup 2.0.0.exe` | **NSIS installer** — recommended, installs to Program Files, adds Start Menu shortcut |
| `Dibby Wemo Manager 2.0.0.exe` | **Portable** — single executable, no installation, runs from any folder |

Run the installer or portable exe. The app opens and immediately begins discovering Wemo devices on your network.

---

## Features

### 🔍 Device Discovery & Control

- Automatically discovers all Wemo devices on your LAN via SSDP
- Displays device name, model, firmware version, and IP address
- Toggle any device on or off with a single click
- Real-time status polling

### ⏰ DWM Rules — Scheduling Engine

Create automation rules across one or multiple devices:

| Rule Type | Description |
|---|---|
| **📅 Schedule** | Turn devices on/off at fixed times on selected days of the week |
| **⏱ Countdown** | Active window — turns on at window start, off at window end (handles cross-midnight windows) |
| **🏠 Away Mode** | Simulates occupancy during a time window by randomly toggling devices on (30–90 min) then off (1–15 min) |
| **🔒 Always On** | Continuously enforces a device stays on; detects and corrects any off-state within 10 seconds |
| **⚡ Trigger** | IFTTT-style automation: when a source device changes state, control target devices (mirror, opposite, force on/off) |

**Multi-device rules** — every rule can target multiple devices simultaneously.

**Times use 12-hour AM/PM format** (e.g. `8:30 PM`, `6 AM`).

**Rules reload live** — the scheduler picks up edits within 30 seconds. No restart needed.

### 🔌 Native Firmware Rules

Read and manage rules stored directly on the Wemo device's own firmware:

- View all rules on a selected device
- Toggle rules on or off
- Delete rules
- Add new native firmware rules

> Wemo Dimmer V2 (WDS060) with newer RTOS firmware does not support firmware rule editing.

### 🛠️ Windows Background Service

The DWM scheduler can run as a **Windows service** (`DibbyWemoService`) so rules continue to fire even when the GUI is closed or the user logs out.

- Install/uninstall the service from the app's System tab
- The service reads rules from the shared data directory and syncs automatically when rules are saved in the GUI
- Service uses `node-windows` for reliable Windows service registration

### 🌐 Web Remote

Optional local web interface accessible from any device on your network (phone, tablet, another PC):

- View device status
- Toggle devices on/off
- QR code for easy mobile access
- Configurable port; firewall rule created automatically (UAC prompt)

### 📍 Sunrise/Sunset Scheduling

Set your city in the Settings tab. Schedule rules can then use local sunrise and sunset times as start/end points.

---

## Data Storage

All app data is stored in `%APPDATA%\DibbyWemoManager\` (typically `C:\Users\<you>\AppData\Roaming\DibbyWemoManager\`):

| File | Description |
|---|---|
| `wemo-manager.json` | App settings, discovered devices, DWM rules |
| `dwm-rules.json` | DWM rules shared with the Windows background service |

The standalone service reads `C:\ProgramData\DibbyWemoManager\dwm-rules.json`. The GUI syncs rules to this location after every create, update, or delete.

---

## Architecture

```
Electron Main Process
├── wemo.js           — Wemo UPnP/SOAP client + SSDP discovery
├── scheduler.js      — DWM rule scheduling engine (tick every 30s)
├── store.js          — JSON persistence layer
├── firewall.js       — Windows Firewall rule management (elevated)
├── web-server.js     — Express web remote server
├── service-manager.js— node-windows service install/uninstall
└── ipc/
    ├── devices.ipc.js
    ├── rules.ipc.js
    ├── scheduler.ipc.js
    ├── system.ipc.js
    └── wifi.ipc.js

Electron Renderer (React 18 + Zustand)
├── DeviceCard        — per-device power button + status
├── RulesTab          — DWM rules list + inline editor
├── AllRulesTab       — Native firmware rules per device
└── Settings          — location, service, web remote config

Standalone Service (scheduler-standalone.js)
└── Runs headless; reads dwm-rules.json; same scheduling logic
```

### Wemo Protocol Details

| Operation | Protocol |
|---|---|
| Discovery | SSDP UDP multicast to `239.255.255.250:1900` |
| Device info | HTTP GET `/setup.xml` |
| Power on/off | UPnP SOAP `SetBinaryState` to `/upnp/control/basicevent1` |
| State query | UPnP SOAP `GetBinaryState` |
| Rules fetch | UPnP SOAP `FetchRules` → download ZIP → extract SQLite |
| Rules save | Modify SQLite → re-ZIP → base64 → `StoreRules` |

Native firmware rules are stored in a SQLite database (`temppluginRules.db`) inside a ZIP archive. The app uses `sql.js` (WebAssembly SQLite) to read and write rules without any native compilation.

---

## Building from Source

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- Windows (for Windows builds)

### Install dependencies

```bash
# From repo root
npm install

# Or just for the desktop app
cd apps/desktop
npm install
```

### Development mode

```bash
cd apps/desktop
npm run dev
```

Opens the Electron app with hot-reload for the renderer.

### Production build

```bash
cd apps/desktop
npm run build:win
```

This:
1. Compiles the renderer with `electron-vite`
2. Bundles the standalone service script
3. Runs `electron-builder` to produce the NSIS installer and portable exe

Output appears in `apps/desktop/dist/`.

> **Code signing:** The build configuration expects a PFX certificate at `resources/srsit-codesign.pfx`. Remove the `win.certificateFile` entry from `package.json` if you don't have a certificate.

---

## Requirements

- Windows 10 or later (x64)
- Node.js ≥ 18 (only needed for building from source)
- Wemo devices on the same LAN

---

## License

MIT
