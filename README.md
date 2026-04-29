# Dibby Wemo Manager

**Local Wemo control — no Belkin cloud required.**

Dibby Wemo Manager gives you full local control of Belkin Wemo smart switches and plugs from five interfaces:

| Component | Description |
|---|---|
| 🖥️ **Desktop App** | Cross-platform Electron app (Windows + Linux) — device dashboard, power control, scheduling |
| 🏠 **Homebridge Plugin** | HomeKit integration with custom scheduling UI inside Homebridge (and HOOBS) |
| 🏡 **Home Assistant Integration** | Native HACS integration with full DWM scheduling engine inside HA |
| 🔴 **Node-RED Nodes** | Drag-and-drop nodes for Node-RED flows — discover, control, and monitor Wemo devices |
| 📡 **MQTT Bridge** | Publishes Wemo state to any MQTT broker with Home Assistant auto-discovery |

All five share the same local-network Wemo protocol (UPnP/SOAP) and the same DWM scheduling engine. No Belkin account, no cloud dependency, no internet required.

---

## 🏠 Apple Home / HomeKit — built-in headless bridge

Dibby ships an embedded HAP (HomeKit Accessory Protocol) bridge that **runs inside the `DibbyWemoScheduler` background service**. Pair the bridge with Apple Home once, and **every Wemo on your network** appears in Home as a HomeKit Switch — including older Wemos that have no native HomeKit firmware, and newer ones whose setup-code sticker has been lost.

Because the bridge runs in the always-on service, it stays alive after you close the desktop app and across reboots. **No need to keep the desktop GUI open.**

**To enable:**

1. Open Dibby Desktop → **Settings** (gear icon) → **🏠 HomeKit Bridge**
2. Click **⚙ Install DibbyWemoScheduler service** (one-time, requires admin via UAC prompt)
3. The bridge auto-starts. Scan the QR code shown in Settings with your iPhone Home app, or type the manual pincode
4. Done — every Wemo Dibby has discovered now appears under "Dibby Wemo Bridge" in Apple Home

**To stop / uninstall the service** (also from Settings → 🏠 HomeKit Bridge):

- **■ Stop service** — pauses the bridge; pairing trust + pincode are preserved so you can start again later without re-pairing
- **🗑 Uninstall service** — fully removes the service from Windows + deletes bridge pairing data + deployed node-windows + bundled node.exe (~91 MB freed). Your devices.json and DWM rules are kept. Re-pair from scratch on next install
- The same buttons are also in the Sidebar's Scheduler panel for quick access without opening Settings

**Auto-sync:** when you discover new Wemos in Dibby, the bridge automatically adds them as HomeKit accessories. Removed devices are removed from Home too.

**No always-on PC?** The same service runs on a $35 Raspberry Pi (`.deb` package) or any always-on Linux host. Pi 4 + Dibby = the cheapest "every Wemo in Apple Home + scheduler running 24/7" setup.

**Already running Homebridge?** The standalone `homebridge-dibby-wemo` plugin is still published — same pairing model, runs inside Homebridge instead. Either path works; the embedded bridge just removes the Homebridge-install step.

---

## ⚠️ Important: rules need an always-on host

**Wemo on-device firmware schedulers stopped firing rules autonomously after Belkin shut down their cloud (2024).** The device still accepts rule writes (`StoreRules`, `UpdateWeeklyCalendar`) and stores them in its memory, but its internal scheduler no longer wakes up to fire them — it was designed around a cloud-pushed nudge that no longer exists, and the TLS pipe to `api.xbcs.net` is pinned so the nudge can't be faked locally.

To fire rules on schedule, **at least one always-on host on your network must run a Dibby scheduler**. Any one of these works for an entire household:

| Host | Notes |
|---|---|
| Windows PC | Install `DibbyWemoScheduler` Windows service from Settings — runs headless, survives reboots, no login required |
| macOS | Run Dibby desktop in Login Items, or install as a `launchd` daemon |
| Raspberry Pi (~$35) | Run the Linux ARM64 AppImage / `.deb` — boots up automatically, low power |
| Existing Homebridge / HOOBS | Install [`homebridge-dibby-wemo`](https://www.npmjs.com/package/homebridge-dibby-wemo) — scheduler runs inside Homebridge |
| Existing Home Assistant | Install via HACS — HA's automation engine fires the rules |
| Node-RED | Install [`node-red-contrib-dibby-wemo`](https://www.npmjs.com/package/node-red-contrib-dibby-wemo) — scheduler runs inside Node-RED |
| Old Android phone on a charger | Install Dibby Android app, foreground service runs in background |

**You do not need a host running on every device** — one always-on host fires rules for every Wemo on the LAN. A spare phone or a $35 Pi is enough.

If you want the simplest setup: a Pi 4 with Raspberry Pi OS + the Dibby ARM64 `.deb` package + `systemd` enable. Done in ~10 minutes, runs forever.

---

## Repository Layout

```
dibby-wemo-manager/
├── apps/
│   ├── desktop/             # Electron desktop app (Windows + Linux)
│   └── android/             # Android companion app
├── packages/
│   ├── homebridge-plugin/   # homebridge-dibby-wemo Homebridge plugin (works with HOOBS)
│   ├── node-red-contrib/    # node-red-contrib-dibby-wemo Node-RED nodes
│   ├── mqtt-bridge/         # MQTT bridge with Home Assistant auto-discovery
│   └── wemo-core/           # Shared Wemo protocol helpers (internal)
├── custom_components/
│   └── dibby_wemo/          # Home Assistant integration (HACS-compatible)
├── hacs.json                # HACS manifest
└── package.json             # npm workspaces root
```

---

## Quick Start

### Desktop App

Download the latest installer from [Releases](../../releases):

**Windows:**
- **`Dibby Wemo Manager Setup 2.0.18.exe`** — NSIS installer (recommended)
- **`Dibby Wemo Manager 2.0.18.exe`** — Portable single-file executable

**Linux (x64):**
- **`Dibby Wemo Manager-2.0.18.AppImage`** — Universal AppImage, runs anywhere
- **`dibby-wemo-manager_2.0.18_amd64.deb`** — Debian / Ubuntu
- **`dibby-wemo-manager-2.0.18.x86_64.rpm`** — Fedora / RHEL

**Linux (ARM64 — Raspberry Pi 4/5):**
- **`Dibby Wemo Manager-2.0.18-arm64.AppImage`**
- **`dibby-wemo-manager_2.0.18_arm64.deb`**

Run the installer (Windows) or AppImage (Linux). Wemo devices are discovered automatically via SSDP on your local network.

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

### HOOBS

The Homebridge plugin is fully HOOBS-compatible. In HOOBS:

1. Open the **Plugins** tab → search for **`homebridge-dibby-wemo`**
2. Click **Install**
3. Open **Config** and add the `DibbyWemo` platform block (same config as Homebridge above)
4. Restart HOOBS — devices appear in HomeKit automatically

### Home Assistant (HACS)

1. Open **HACS** → **Integrations** → **⋮** → **Custom repositories**
2. Add `https://github.com/K0rb3nD4ll4S/dibby-wemo-manager` as category **Integration**
3. Search for **Dibby Wemo** → Install → Restart Home Assistant
4. **Settings** → **Devices & Services** → **Add Integration** → search **Dibby Wemo**
5. HA will auto-discover all Wemo devices on your network

Once the HACS default repository picks up this integration, the custom-repository step will no longer be needed.

### Node-RED Nodes

From your Node-RED user directory:

```bash
cd ~/.node-red
npm install node-red-contrib-dibby-wemo
```

Or via the Node-RED Palette Manager: search for **`node-red-contrib-dibby-wemo`** and click Install. Restart Node-RED — four new nodes (`wemo-config`, `wemo-control`, `wemo-state`, `wemo-discover`) appear under the **wemo** category.

### MQTT Bridge

Run the MQTT bridge via Docker (from `packages/mqtt-bridge/`):

```bash
docker compose up -d
```

The bridge publishes each Wemo device's state to MQTT with Home Assistant auto-discovery topics — devices appear automatically in HA's MQTT integration without any config flow.

---

## Features

### 🖥️ Desktop App

- **Device dashboard** — real-time on/off status for all Wemo devices on your network
- **One-click power control** — toggle any device instantly
- **DWM Rules** — cross-device scheduling engine:
  - **Schedule** — turn devices on/off at specific times on selected days
  - **Countdown** — state-based auto-timer: turns the device OFF (or ON) after N minutes of being in that state, including if it was already in that state when the scheduler started
  - **Away Mode** — randomised on/off simulation while you're away
  - **Always On** — enforce a device stays on; auto-corrects within 10 seconds
  - **Trigger** — IFTTT-style: when device A changes state, control device B
- **Native firmware rules** — read, toggle and delete rules stored on the Wemo device itself
- **Background scheduler** — keeps rules firing even when the GUI is closed
  - Windows: native Windows service (`DibbyWemoService`)
  - Linux: background process, runs while app is in system tray
- **WiFi provisioning** — connect a WeMo device to your home network directly from the app (no WeMo app required):
  - Scans available networks with signal strength and security type
  - Real-time SOAP communication log shows every exchange during setup
  - Confirmed working on F7C027 firmware (flat params, AES-encrypted password, double-send)
- **Web remote** — optional local web interface accessible from your phone
- **Sunrise/sunset support** — location-aware scheduling via city search

**Platforms:** Windows 10+ (x64) · Linux x64 · Linux ARM64 (Raspberry Pi 4/5)

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

### 🏡 Home Assistant Integration

HACS-installable native integration (`custom_components/dibby_wemo/`):

- **Auto-discovery** via SSDP — all Wemo devices found and added automatically
- **Switch entities** for every Wemo device, fully controllable from HA
- **Full DWM scheduling engine** inside HA — all rule types (Schedule, Countdown, Away Mode, Always On, Trigger)
- **Firmware rule management** — read and manage native Wemo on-device rules
- **Sunrise/sunset scheduling** with location awareness
- **Local polling** only — no cloud, pure Python stdlib, no pip dependencies

### 🔴 Node-RED Nodes

Four drag-and-drop nodes for Node-RED flows:

- **`wemo-config`** — configure connection to a specific Wemo device by IP + UDN
- **`wemo-control`** — turn a device on/off or toggle via incoming message
- **`wemo-state`** — poll current on/off state, output via message payload
- **`wemo-discover`** — SSDP discovery of all Wemo devices on the network

All nodes run pure local UPnP/SOAP — no cloud, no Belkin account, no internet required. Published as [`node-red-contrib-dibby-wemo`](https://www.npmjs.com/package/node-red-contrib-dibby-wemo) on npm.

### 📡 MQTT Bridge

Dockerised bridge that publishes Wemo device state to any MQTT broker:

- **Home Assistant auto-discovery** — devices appear in HA's MQTT integration without manual config
- **Real-time state updates** — on/off changes published immediately
- **Command topics** — control any device by publishing to its command topic
- **Runs anywhere Docker runs** — Linux, Raspberry Pi, NAS, etc.

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
| WiFi setup | UPnP SOAP `GetApList` / `ConnectHomeNetwork` / `CloseSetup` on device AP at `10.22.22.1` |

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

- Loads rules from a JSON store
- Ticks every **30 seconds**, reloading rules on each tick (live edits take effect without restart)
- Pre-schedules events within a **65-second look-ahead window**
- On startup, catches up any rules missed within the last **10 minutes**
- Runs a **health monitor** every 10 seconds for AlwaysOn and Trigger rules
- Writes a **heartbeat** to the store on every tick so the UI can show scheduler status

### Shared Core

`packages/wemo-core` contains shared constants and utilities (day numbers, time conversions, sunrise/sunset calculator) used by both the desktop app and the Homebridge plugin without duplication. It is an internal npm workspace package, not published to npm.

---

## Development

### Prerequisites

- Node.js 18, 20, 22, or 24
- npm ≥ 9

### Install all dependencies

```bash
# From repo root — installs all workspaces
npm install
```

### Desktop App — dev mode

```bash
cd apps/desktop
npm run dev
```

### Desktop App — build

```bash
# Windows installer + portable exe
cd apps/desktop
npm run build:win

# Linux AppImage + .deb + .rpm (x64)
cd apps/desktop
npm run build:linux

# Linux ARM64 (Raspberry Pi)
cd apps/desktop
npm run build:linux:arm64

# Windows x64 + Linux x64 in one command
cd apps/desktop
npm run build:all
```

Output in `apps/desktop/dist/`.

### Homebridge Plugin — install locally

```bash
cd packages/homebridge-plugin
npm install -g .
```

Then restart Homebridge.

---

## Release Assets

Each [GitHub Release](../../releases) includes:

| File | OS | Description |
|---|---|---|
| `Dibby Wemo Manager Setup 2.0.18.exe` | Windows | NSIS installer (recommended) |
| `Dibby Wemo Manager 2.0.18.exe` | Windows | Portable executable |
| `Dibby Wemo Manager-2.0.18.AppImage` | Linux x64 | Universal AppImage |
| `dibby-wemo-manager_2.0.18_amd64.deb` | Linux x64 | Debian / Ubuntu package |
| `dibby-wemo-manager-2.0.18.x86_64.rpm` | Linux x64 | Fedora / RHEL package |
| `Dibby Wemo Manager-2.0.18-arm64.AppImage` | Linux ARM64 | Raspberry Pi 4/5 AppImage |
| `dibby-wemo-manager_2.0.18_arm64.deb` | Linux ARM64 | Raspberry Pi OS package |
| `homebridge-dibby-wemo-2.0.18.tgz` | Any | Homebridge plugin npm package |

---

## License

MIT — see [LICENSE](LICENSE)

---

*Built by SRS IT. All Wemo communication is local — your device data never leaves your network.*
