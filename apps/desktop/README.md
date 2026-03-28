# Dibby Wemo Manager — Desktop App

**Cross-platform desktop application for local Belkin Wemo control.**

Full device dashboard, power control, scheduling engine, and optional web remote — all communicating directly with your Wemo devices over your local network. No Belkin cloud account required.

On Windows the scheduler can run as a background service so rules keep firing after the GUI is closed. Linux uses a background process instead.

---

## Installation

Download the latest release from [GitHub Releases](../../releases):

### Windows

| File | Description |
|---|---|
| `Dibby Wemo Manager Setup 2.0.0.exe` | **NSIS installer** — recommended, installs to Program Files, adds Start Menu shortcut |
| `Dibby Wemo Manager 2.0.0.exe` | **Portable** — single executable, no installation, runs from any folder |

Run the installer or portable exe. The app opens and immediately begins discovering Wemo devices on your network.

### Linux

| File | Description |
|---|---|
| `Dibby Wemo Manager-2.0.0.AppImage` | **AppImage** — universal, runs on any modern Linux distro. No install needed. |
| `dibby-wemo-manager_2.0.0_amd64.deb` | **Debian / Ubuntu** package |
| `dibby-wemo-manager-2.0.0.x86_64.rpm` | **Fedora / RHEL / openSUSE** package |
| `Dibby Wemo Manager-2.0.0-arm64.AppImage` | **AppImage (ARM64)** — Raspberry Pi 4/5, Apple Silicon VMs |
| `dibby-wemo-manager_2.0.0_arm64.deb` | **Debian ARM64** — Raspberry Pi OS |

**AppImage:**
```bash
chmod +x "Dibby Wemo Manager-2.0.0.AppImage"
./"Dibby Wemo Manager-2.0.0.AppImage"
```

**Debian / Ubuntu (.deb):**
```bash
sudo dpkg -i dibby-wemo-manager_2.0.0_amd64.deb
```

**Fedora / RHEL (.rpm):**
```bash
sudo rpm -i dibby-wemo-manager-2.0.0.x86_64.rpm
```

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

### 🌐 Web Remote

Optional local web interface accessible from any device on your network (phone, tablet, another PC):

- View device status
- Toggle devices on/off
- Manage DWM rules
- QR code for easy mobile access
- Configurable port; firewall rule created automatically on Windows (UAC prompt)

### 📍 Sunrise/Sunset Scheduling

Set your city in the Settings tab. Schedule rules can then use local sunrise and sunset times as start/end points.

### 🛠️ Background Scheduler

The DWM scheduler continues running rules even when the main window is closed.

**Windows** — installs as a native **Windows Service** (`DibbyWemoService`) via `node-windows`:
- Install/uninstall from the System tab
- The service reads rules from `C:\ProgramData\DibbyWemoManager\dwm-rules.json`
- Syncs automatically when rules are saved in the GUI

**Linux** — the scheduler runs as a background process spawned from the main Electron process. It continues running while the app is in the system tray.

---

## Data Storage

All app data is stored in the OS user-data directory:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\DibbyWemoManager\` |
| Linux | `~/.config/DibbyWemoManager/` |

| File | Description |
|---|---|
| `wemo-manager.json` | App settings, discovered devices, DWM rules |
| `dwm-rules.json` | DWM rules shared with the background scheduler |

On Windows the standalone service reads `C:\ProgramData\DibbyWemoManager\dwm-rules.json`. The GUI syncs rules to this location after every create, update, or delete.

---

## Architecture

```
Electron Main Process
├── wemo.js           — Wemo UPnP/SOAP client + SSDP discovery
├── scheduler.js      — DWM rule scheduling engine (tick every 30s)
├── store.js          — JSON persistence layer
├── firewall.js       — Windows Firewall rule management (elevated)
├── web-server.js     — Express web remote server
├── service-manager.js— node-windows service install/uninstall (Windows)
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

Standalone Scheduler (scheduler-standalone.js)
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
- OS-specific toolchain (see below)

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

### Production builds

#### Windows (NSIS installer + portable exe)

Run on a Windows machine:

```bash
cd apps/desktop
npm run build:win
```

Output in `apps/desktop/dist/`:
- `Dibby Wemo Manager Setup 2.0.0.exe` — NSIS installer
- `Dibby Wemo Manager 2.0.0.exe` — portable exe

> **Code signing:** The build config expects a PFX certificate at `resources/srsit-codesign.pfx`. Remove the `win.certificateFile` entry from `package.json` if you don't have a certificate.

#### Linux x64 (AppImage + .deb + .rpm)

Run on a Linux machine or in WSL2 / CI:

```bash
cd apps/desktop
npm run build:linux
```

Output in `apps/desktop/dist/`:
- `Dibby Wemo Manager-2.0.0.AppImage`
- `dibby-wemo-manager_2.0.0_amd64.deb`
- `dibby-wemo-manager-2.0.0.x86_64.rpm`

#### Linux ARM64 (Raspberry Pi / Apple Silicon)

```bash
cd apps/desktop
npm run build:linux:arm64
```

Output in `apps/desktop/dist/`:
- `Dibby Wemo Manager-2.0.0-arm64.AppImage`
- `dibby-wemo-manager_2.0.0_arm64.deb`

#### All targets at once

```bash
cd apps/desktop
npm run build:all
```

Builds Windows x64 and Linux x64 targets in sequence. Requires the build host to have `wine` installed (for Windows cross-compilation on Linux), or run each command on its native OS.

---

## Requirements

| Component | Windows | Linux |
|---|---|---|
| OS | Windows 10 or later (x64) | Any modern distro (x64 or ARM64) |
| Node.js | ≥ 18 (build only) | ≥ 18 (build only) |
| Runtime deps | None — bundled | `libgtk-3`, `libnss3`, `libxss1` (auto via .deb) |
| Wemo devices | Same LAN | Same LAN |

---

## License

MIT
