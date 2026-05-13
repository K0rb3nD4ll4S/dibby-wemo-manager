# homebridge-dibby-wemo

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

**Homebridge plugin for local Belkin Wemo control — no cloud required.**

Registers all Wemo devices on your local network as HomeKit switches and provides a full scheduling engine via a custom Homebridge UI panel. All device communication is direct local UPnP/SOAP — no Belkin account needed.

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

Once installed, open the plugin settings in Homebridge UI. The plugin provides a full custom panel with five tabs:

### 📱 Devices Tab

Top-of-tab controls (new in v2.0.28):

- **Wemo Devices** heading rendered in bold green so the section is easy to find at a glance.
- **Timeout** dropdown right next to the Discover button — pick how long SSDP should listen for responses: **10 s, 20 s, 30 s (default), 45 s, or 60 s**. Longer values catch quieter / slower-responding Wemos on busy LANs. The previous fixed 10 s was too short on many networks; per-scan override now means you don't need to edit `config.json` between scans.
- 🔍 **Discover** button — broadcasts SSDP and merges the result into the cached device list. Already-known devices keep their HomeKit identity (UUIDs and rule references are preserved).

A dedicated **Add by IP** row sits directly below the Discover button. Use it whenever multicast SSDP can't reach a Wemo (VLAN isolation, Docker bridge networking, hostile router):

1. Enter the device IP (e.g. `192.168.1.42`).
2. Optionally change the port (default `49153`).
3. Click **+ Add Device**.

The server probes `/setup.xml` on that exact IP via the same client used by SSDP, so only a real Wemo answer is accepted — the device's UDN, model, friendly name, and firmware version are all read from the response. The new card appears immediately with the on/off toggle wired up.

Device list behaviour:

- Lists every Wemo currently in the store with its model, firmware version, host, and port. Device names are rendered in **bold white** with brighter subtitles for legibility on every Homebridge UI theme.
- Toggle any device on or off directly — the toggle reflects the live HomeKit state and the change propagates back to HomeKit immediately.
- **Sticky devices**: once a Wemo has been detected (via SSDP or manual add), it stays in the list permanently. A re-scan or a Homebridge restart never removes anything — devices that are offline, on a different VLAN, or unreachable for any reason keep their cached record verbatim. Their toggle is greyed-out while unreachable and re-lights as soon as the device responds again.
- Plugin upgrades preserve devices too — the store file lives outside the npm package (see [Data Storage](#data-storage)).

### ⏰ DWM Rules Tab

Create and manage automation rules that run inside Homebridge.

**Scheduler status bar** — shown at the top of the tab:
- 🟢 **Green** — scheduler is running, shows total schedule entries and next upcoming rule
- 🟠 **Amber** — scheduler may have stopped (no heartbeat received) — restart Homebridge
- 🔴 **Red** — scheduler is not running — check the `DibbyWemo` platform is in `config.json`

**Rule types:**

| Icon | Type | Description |
|---|---|---|
| 📅 | **Schedule** | Turn devices on/off at specific times on selected days |
| ⏱ | **Countdown** | Active window — on at start, off at end (cross-midnight aware) |
| 🏠 | **Away Mode** | Randomised on/off simulation during a time window |
| 🔒 | **Always On** | Device is kept ON at all times; any off-state is corrected within 10 seconds |
| ⚡ | **Trigger** | IFTTT-style: when one device changes state, control another |

**Creating a rule:**

1. Click **+ ADD RULE**
2. Enter a name, select the rule type
3. Select target device(s) and set times / options
4. Click **Save Rule**

Rules take effect on the next 30-second scheduler tick — no restart needed.

**Editing / deleting a rule:**

- Click **EDIT** to open the inline form
- Click **DELETE** → confirm with **Yes, delete** in the inline bar that appears

**Times use 12-hour AM/PM format.** Examples: `8:30 PM`, `6:00 AM`, `12:00 AM` (midnight), `9 PM`

### 🔌 Device Rules Tab

Manage rules stored directly on the Wemo device's own firmware:

1. Select a device from the dropdown
2. Click **Load Rules** to fetch the device's rule database
3. Toggle rules on/off or delete them
4. Click **Add Rule** to create a new native firmware rule

> Native firmware rules are separate from DWM Rules. DWM Rules are recommended as they support more features and work across multiple devices simultaneously.

> Wemo Dimmer V2 (WDS060) with newer RTOS firmware does not support `FetchRules`/`StoreRules`. These devices show a warning in the Device Rules tab.

### ⚙️ Settings Tab

Set your **location** for sunrise/sunset-based scheduling:

1. Type your city name in the search box
2. Select your city from the dropdown
3. Click **Save Location**

Once set, you can use Sunrise and Sunset as rule start/end times.

### ❓ Help Tab

Built-in documentation covering all features, rule types, time format, and troubleshooting.

---

## How It Works

### Device Discovery

At startup, the plugin broadcasts an SSDP M-SEARCH packet to `239.255.255.250:1900`. Wemo devices respond with their location URL, from which the plugin fetches device details (`/setup.xml`) and registers each device as a HomeKit switch accessory.

Cached devices are restored immediately on the next restart so HomeKit doesn't time out waiting for SSDP to complete.

### HomeKit Control

All on/off commands use direct UPnP SOAP requests to the device:

- `SetBinaryState` — set on (`1`) or off (`0`)
- `GetBinaryState` — read current state

The plugin polls each device every `pollInterval` seconds and pushes state changes to HomeKit.

### DWM Scheduler

The scheduler runs inside the Homebridge process:

- **30-second tick** — reloads rules from store, schedules upcoming events
- **65-second look-ahead window** — pre-schedules `setTimeout` callbacks for precise firing
- **10-minute catch-up** — on restart, fires any rules whose time fell within the last 10 minutes
- **Health monitor** — polls all referenced devices every 10 seconds for AlwaysOn and Trigger rule enforcement
- **Heartbeat** — writes scheduler status every `heartbeatInterval` seconds (default: 1 s) on an independent timer; the UI reads this to show the status bar

Rules are stored in `<homebridgeStoragePath>/dibby-wemo.json`. The scheduler reloads this file on every tick, so rules created or edited in the UI take effect within 30 seconds without a restart.

### Native Firmware Rules

Wemo devices store their own rules in a SQLite database inside a ZIP archive. The plugin:

1. Calls `FetchRules` to get the current database URL
2. Downloads and extracts the ZIP to get the SQLite file
3. Opens it with `sql.js` (WebAssembly SQLite — no native compilation)
4. Modifies the database
5. Re-ZIPs, base64-encodes, and uploads via `StoreRules`

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No devices found | Ensure PC and Wemo devices are on the same network. Some routers block SSDP multicast — add devices manually via `manualDevices` in config. |
| HomeKit switch unresponsive | Restart Homebridge. The device must be discovered at least once to register. Check Homebridge logs for SOAP errors. |
| Rules not firing | Check the scheduler status bar in the DWM Rules tab. 🔴 Red = DibbyWemo platform missing from config. 🟠 Amber = restart Homebridge. |
| Settings gear icon missing | Ensure `customUi: true` is in the plugin's `package.json` and `config.schema.json`. Upgrade `homebridge-config-ui-x` to v5+. |
| Dimmer device shows warning | Wemo Dimmer V2 (WDS060) newer firmware does not support FetchRules. Power control still works. |
| Rule was created but not showing | The UI data refreshes on tab open. Switch away and back to the DWM Rules tab, or restart Homebridge and hard-refresh the browser (Ctrl+Shift+R). |

---

## Data Storage

All plugin data is stored in the Homebridge storage directory (default `~/.homebridge/`):

**`dibby-wemo.json`** — main plugin store:
```json
{
  "location":     { "lat": 0, "lng": 0, "city": "...", "country": "..." },
  "devices":      [ /* sticky — never removed by a re-scan */ ],
  "deviceOrder":  [ /* UI ordering */ ],
  "deviceGroups": [ /* UI grouping */ ],
  "dwmRules":     [ /* every Schedule / Countdown / Away / AlwaysOn / Trigger rule */ ],
  "disabledRules": { /* per-device firmware-rule backups */ },
  "schedulerHeartbeat": { "running": true, "ts": "...", "upcoming": [...] }
}
```

### Upgrade-survival guarantee

This file lives **outside** the npm package directory, so `npm update -g homebridge-dibby-wemo` (and every UI-driven update) never touches it:

- ✅ Devices stay
- ✅ DWM rules stay
- ✅ Device ordering, groupings, location, and disabled-rule backups stay

To make this verifiable, the plugin emits a one-line summary on every Homebridge startup:

```
[Store] Loaded from /var/lib/homebridge/dibby-wemo.json — 12 device(s), 7 DWM rule(s).
```

If either count is unexpectedly different after an upgrade, that log line surfaces the regression immediately. (Devices that go offline don't change this count — they stay in the file until you manually delete them.)

No data is sent outside your local network.

---

## Requirements

- Homebridge ≥ 1.6.0
- Node.js ≥ 18
- homebridge-config-ui-x ≥ 5.0.0 (for custom UI panel)
- Wemo devices on the same LAN as the Homebridge host

---

## License

MIT

---

*Dedicated to Dibby ❤️ — built with love, and always being improved.*
