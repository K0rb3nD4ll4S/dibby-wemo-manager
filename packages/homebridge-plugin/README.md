# homebridge-dibby-wemo

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm version](https://img.shields.io/npm/v/homebridge-dibby-wemo?color=blue)](https://www.npmjs.com/package/homebridge-dibby-wemo)
[![npm downloads](https://img.shields.io/npm/dw/homebridge-dibby-wemo)](https://www.npmjs.com/package/homebridge-dibby-wemo)
[![Homebridge 1.x](https://img.shields.io/badge/homebridge-1.x-brightgreen)](https://github.com/homebridge/homebridge)
[![Homebridge 2.x](https://img.shields.io/badge/homebridge-2.x%20beta-brightgreen)](https://github.com/homebridge/homebridge)

**Local Belkin Wemo control for HomeKit — no cloud, no Belkin account required.**

Registers all Wemo devices on your local network as HomeKit switches and provides a full automation scheduling engine via a built-in custom UI panel inside Homebridge. All device communication is direct local UPnP/SOAP.

---

## Features

| Feature | Description |
|---|---|
| 🔌 **HomeKit switches** | All Wemo devices registered automatically via SSDP discovery |
| 📅 **DWM Scheduler** | 5 rule types: Schedule, Countdown, Away Mode, Always On, Trigger |
| 🌅 **Sunrise / sunset** | Location-aware scheduling — NOAA algorithm, no API key needed |
| 🔌 **Native firmware rules** | Read, toggle, delete, and create rules stored on the Wemo device itself |
| 📤 **Import / Export** | Backup and restore DWM rules as JSON |
| 🩺 **Scheduler health bar** | Live green / amber / red status showing scheduler state |
| 🔄 **Copy firmware → DWM** | One-click conversion of on-device Schedule rules to DWM rules |
| 🏠 **Homebridge 1.x + 2.x** | Compatible with Homebridge 1.6+ and 2.0 beta (Node.js 18–24) |
| ⚡ **No cloud** | All communication stays on your local network |

---

## Supported Devices

| Model | Name | On/Off | Native Rules |
|---|---|---|---|
| WLS0403 | Wemo 3-Way Smart Switch | ✅ | ✅ |
| WLS040 | Wemo Light Switch | ✅ | ✅ |
| F7C030 | Wemo Light Switch (older) | ✅ | ✅ |
| F7C027 | Wemo Switch | ✅ | ✅ |
| F7C029 | Wemo Insight Smart Plug | ✅ | ✅ |
| F7C063 | Wemo Mini Smart Plug v2 | ✅ | ✅ |
| WDS060 | Wemo WiFi Smart Dimmer | ✅ | ⚠️ newer RTOS firmware only |

---

## Installation

### Via Homebridge UI (recommended)

1. Open Homebridge UI → **Plugins**
2. Search for `homebridge-dibby-wemo`
3. Click **Install**
4. Restart Homebridge

### Via npm

```bash
npm install -g homebridge-dibby-wemo
```

---

## Configuration

Add to your Homebridge `config.json`:

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

Restart Homebridge. All Wemo devices on your network are discovered automatically and appear in HomeKit.

### Optional config properties

```json
{
  "platform": "DibbyWemo",
  "name": "DibbyWemo",
  "discoveryTimeout": 10000,
  "pollInterval": 30,
  "manualDevices": [
    { "host": "192.168.1.50", "port": 49153 }
  ]
}
```

| Property | Type | Default | Description |
|---|---|---|---|
| `discoveryTimeout` | number | `10000` | SSDP discovery window in milliseconds |
| `pollInterval` | number | `30` | How often (seconds) to poll device state for HomeKit |
| `heartbeatInterval` | number | `1` | Scheduler heartbeat write interval in seconds (1–300). Lower = faster status response. |
| `manualDevices` | array | `[]` | Devices to add by IP if SSDP discovery misses them |

---

## Custom UI

Once installed, click the **Settings** icon (⚙) on the plugin tile in Homebridge UI to open the full custom panel.

### 📱 Devices Tab

- Lists all discovered Wemo devices with their model, firmware version, and IP address
- Toggle any device on or off directly from the UI
- **Discover** button re-runs SSDP discovery and updates the device list

### ⏰ DWM Rules Tab

Create and manage automation rules that run entirely inside Homebridge, independent of the Wemo device firmware.

**Scheduler status bar** (top of tab):

| Indicator | Meaning |
|---|---|
| 🟢 Green | Scheduler running — shows total schedule entries and next upcoming rule |
| 🟠 Amber | No heartbeat received — scheduler may have stopped; restart Homebridge |
| 🔴 Red | Scheduler not running — check `DibbyWemo` platform is in `config.json` |

**Rule types:**

| Type | Icon | Description |
|---|---|---|
| **Schedule** | 📅 | Turn on/off at fixed times or sunrise/sunset ± offset on selected days |
| **Countdown** | ⏱ | Triggered by a device state change — runs for N minutes then reverses. Optional active window. |
| **Away Mode** | 🏠 | Randomised on/off cycles within a time window to simulate occupancy |
| **Always On** | 🔒 | Enforces a device stays ON; any off-state corrected within 10 seconds |
| **Trigger** | ⚡ | When device A changes state, control device B (mirror, opposite, or specific on/off) |

**Creating a rule:**
1. Click **+ ADD RULE**
2. Enter a name and select the rule type
3. Select target device(s) and configure times/options
4. Click **Save Rule** — active within 30 seconds, no restart needed

**Editing / deleting:**
- Click **Edit** to open the inline form
- Click **Delete** → confirm with the inline bar that appears (no browser popups)

**Import / Export:**
- **📤 Export** — downloads all DWM rules as a dated `.json` backup file
- **📥 Import** — loads rules from a `.json` file; choose **merge** (skip duplicates) or **replace** (overwrite all)
- **🗑 Delete All** — removes all DWM rules after inline confirmation

**Times:** 12-hour AM/PM format — e.g. `8:30 PM`, `6:00 AM`, `12:00 AM`, `9 PM`.

### 🔌 Device Rules Tab

Manage rules stored directly on the Wemo device's own firmware (not in Homebridge):

1. Select a device from the dropdown
2. Click **Load Rules** to fetch the device's SQLite rule database
3. Toggle rules on/off, delete individually, or **🗑 Delete All**
4. **Add Rule** — create a new native firmware rule
5. **📋 Copy to DWM** — converts all firmware Schedule rules to DWM rules in one click

> **DWM Rules are recommended** over native firmware rules — they support more rule types, work across multiple devices simultaneously, and are stored in Homebridge rather than on the device.

> **Wemo Dimmer V2 (WDS060)** with newer RTOS firmware does not expose `FetchRules`/`StoreRules`. On/off control works fine; the Device Rules tab shows a warning for these devices.

### ⚙️ Settings Tab

Configure timing values (written directly to `config.json`):
- **Scheduler Heartbeat Interval** (1–300 s)
- **Device Poll Interval** (10+ s)
- **Discovery Timeout** (3000+ ms)

Set your **location** for sunrise/sunset scheduling:
1. Type a city name in the search box
2. Select from the results
3. Click **Save Location**

Once a location is saved, rule start/end times can use **Sunrise** or **Sunset** ± a minute offset.

### ❓ Help Tab

Built-in documentation covering all features, rule types, time format, and troubleshooting.

---

## How It Works

### Device Discovery

At startup the plugin broadcasts an SSDP M-SEARCH multicast to `239.255.255.250:1900`. Wemo devices respond with a location URL; the plugin fetches `/setup.xml` for device details and registers each as a HomeKit Switch accessory.

Previously cached devices are restored immediately on the next restart — HomeKit doesn't time out waiting for SSDP.

On Windows with multiple network adapters (WiFi + VPN + Hyper-V), one UDP socket is bound per adapter so M-SEARCH packets go out on the correct interface.

### HomeKit Control

All on/off commands use direct UPnP SOAP:

| Action | SOAP call |
|---|---|
| Turn on/off | `SetBinaryState` (`BinaryState`: `1` / `0`) |
| Read state | `GetBinaryState` |

State is polled every `pollInterval` seconds and pushed to HomeKit when it changes.

### DWM Scheduler

Runs inside the Homebridge process:

- **30-second tick** — reloads rules from the JSON store; live edits take effect within one tick
- **65-second look-ahead** — pre-schedules `setTimeout` callbacks for sub-minute precision
- **10-minute catch-up** — fires any rules missed during a restart
- **Health monitor** — polls devices every 10 s for Always On and Trigger enforcement
- **Heartbeat** — writes status every `heartbeatInterval` seconds on an independent timer; the UI reads this for the status bar

Rules are stored in `<homebridgeStoragePath>/dibby-wemo.json`.

### Native Firmware Rules (SQLite over ZIP)

Wemo devices store rules in a SQLite database inside a ZIP archive:

1. `FetchRules` → download URL for the ZIP
2. Unzip → `temppluginRules.db` (SQLite)
3. Open with `sql.js` (WebAssembly — no native compilation needed)
4. Modify → re-ZIP → base64-encode
5. `StoreRules` → upload encoded database

> The base64 body must be wrapped in entity-encoded CDATA (`&lt;![CDATA[...]]&gt;`) — the SOAP envelope is hand-crafted since standard XML builders cannot produce this format.

### Sunrise/Sunset

Computed using the NOAA Solar Calculator algorithm — no internet access or API key required. Location (lat/lng) is set via the Settings tab and stored locally in `dibby-wemo.json`.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No devices found | Ensure PC and Wemo devices are on the same network. Some routers block SSDP multicast — add devices manually via `manualDevices` in config. |
| HomeKit switch unresponsive | Restart Homebridge. The device must be discovered at least once to register. Check Homebridge logs for SOAP errors. |
| Rules not firing | Check the scheduler status bar in the DWM Rules tab. 🔴 Red = DibbyWemo platform missing from config. 🟠 Amber = restart Homebridge. |
| Settings gear icon missing | Ensure `homebridge-config-ui-x` is ≥ 5.0.0. |
| Dimmer shows native rules warning | Wemo Dimmer V2 (WDS060) newer firmware does not support FetchRules. On/off control still works. |
| Rule not showing after creation | Switch away from DWM Rules tab and back, or hard-refresh the browser (Ctrl+Shift+R). |
| Homebridge 2.0 compatibility warning | Update to `homebridge-dibby-wemo@2.0.10` — this version declares `^2.0.0-beta.0` in `engines`. |

---

## Data Storage

All plugin data is stored in the Homebridge storage directory (default `~/.homebridge/`):

**`dibby-wemo.json`** — main plugin store:
```json
{
  "location": { "lat": 0, "lng": 0, "city": "...", "country": "..." },
  "devices": [...],
  "dwmRules": [...],
  "schedulerHeartbeat": { "running": true, "ts": "...", "upcoming": [...] }
}
```

No data is sent outside your local network.

---

## Requirements

- Homebridge ≥ 1.6.0 **or** 2.0 beta
- Node.js 18, 20, 22, or 24
- homebridge-config-ui-x ≥ 5.0.0 (for custom UI panel)
- Wemo devices on the same LAN as the Homebridge host

---

## Changelog

See [CHANGELOG.md](../../CHANGELOG.md) in the repository root for full release history.

---

## License

MIT

---

*Dedicated to Dibby ❤️*
