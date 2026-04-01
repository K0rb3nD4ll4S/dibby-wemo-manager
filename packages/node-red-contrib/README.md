# node-red-contrib-dibby-wemo

**Node-RED nodes for local Belkin Wemo device control — no cloud required.**

Four drag-and-drop nodes let you discover, control, and monitor Wemo devices inside any Node-RED flow. All communication is direct local UPnP/SOAP — no Belkin account or internet connection needed.

---

## Installation

### Via Node-RED Palette Manager (recommended)

1. Open Node-RED → **Menu** → **Manage palette**
2. Click **Install**
3. Search for `node-red-contrib-dibby-wemo`
4. Click **Install**

### Via npm

```bash
cd ~/.node-red
npm install node-red-contrib-dibby-wemo
```

Restart Node-RED after installation.

---

## Nodes

### `wemo-config` — Shared device config

A **config node** (no inputs or outputs). Stores the IP address and port for a single Wemo device. Referenced by `wemo-control` and `wemo-state`.

| Property | Default | Description |
|---|---|---|
| Name | — | Label for this device |
| Host | — | Device IP address |
| Port | `49153` | UPnP port (usually 49153–49156) |

---

### `wemo-control` — Send ON/OFF

Send a command to a Wemo device and receive the confirmed state back.

**Input**

| `msg.payload` | Meaning |
|---|---|
| `'ON'` / `true` / `1` | Turn device on |
| `'OFF'` / `false` / `0` | Turn device off |
| `'toggle'` | Toggle current state |

**Output** — one message after the command is confirmed:

| Property | Type | Value |
|---|---|---|
| `msg.payload` | string | `'ON'` or `'OFF'` |
| `msg.topic` | string | Device name |
| `msg.device` | object | `{ host, port, name }` |

**Status indicators**

- 🟢 Green dot — device is ON
- ⚫ Grey ring — device is OFF
- 🔴 Red ring — error

---

### `wemo-state` — Poll device state

Polls a Wemo device on a configurable interval and emits a message when the state changes (or on every poll).

**Config**

| Property | Default | Description |
|---|---|---|
| Device | — | `wemo-config` node reference |
| Interval | `10` s | How often to poll |
| Only on change | ✓ | Only emit if state changed since last poll |

**Output** — one message per poll (or per change):

| Property | Type | Value |
|---|---|---|
| `msg.payload` | string | `'ON'` or `'OFF'` |
| `msg.topic` | string | Device name |
| `msg.device` | object | `{ host, port, name }` |

---

### `wemo-discover` — SSDP discovery

Triggers a network scan and emits one message per Wemo device found on your LAN.

**Input** — any message triggers a scan.

**Config**

| Property | Default | Description |
|---|---|---|
| Timeout | `8` s | How long to wait for SSDP responses |

**Output** — one message per discovered device:

| Property | Type | Value |
|---|---|---|
| `msg.payload` | object | `{ host, port, friendlyName, udn, productModel, firmwareVersion }` |
| `msg.topic` | string | Device friendly name |

**Tip:** Use the `host` and `port` values from discovery output to populate `wemo-config` nodes for the other node types.

---

## Quick-start Example

```
[inject (on deploy)] → [wemo-discover] → [debug]
```

1. Drop an **inject** node (set to fire once on deploy), a **wemo-discover** node, and a **debug** node
2. Wire them together
3. Click **Deploy** — one debug message per Wemo device appears in the sidebar

---

## Notes

- SSDP discovery requires the Node-RED host to be on the **same network segment** as the Wemo devices
- If running Node-RED in Docker, use `--network host` for SSDP to work
- `wemo-state` starts polling when Node-RED deploys and stops when the flow is redeployed or stopped

---

## Requirements

- Node-RED ≥ 2.0.0
- Node.js ≥ 18
- Wemo devices on the same LAN as the Node-RED host

---

## Links

- [GitHub](https://github.com/K0rb3nD4ll4S/dibby-wemo-manager)
- [Issues](https://github.com/K0rb3nD4ll4S/dibby-wemo-manager/issues)
- [flows.nodered.org](https://flows.nodered.org/node/node-red-contrib-dibby-wemo)

---

## License

MIT

---

*Part of the [Dibby Wemo Manager](https://github.com/K0rb3nD4ll4S/dibby-wemo-manager) project.*
