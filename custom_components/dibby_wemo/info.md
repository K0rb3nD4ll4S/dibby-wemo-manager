# Dibby Wemo

Local Belkin Wemo control for Home Assistant — no cloud, no Belkin account required.

## Features

- **Auto-discovery** — SSDP multicast + unicast `/24` subnet fallback that works on bare-metal HA, HAOS-in-a-VM, and HA-in-Docker (bridge mode).
- **Switch entities** — every Wemo plug, switch, light switch, or insight appears as a HA `switch` entity with on/off state and live updates.
- **DWM Scheduling Engine** — full automation rules running inside HA:
  - **Schedule** — turn devices on/off at fixed times or sunrise/sunset
  - **Countdown** — auto-revert after N minutes
  - **Away Mode** — randomised on/off simulation within a window
  - **Always On** — device kept ON at all times, corrected within 10 seconds
  - **Trigger** — when device A changes state, control device B
- **Firmware rules** — read and manage native Wemo device rules (`FetchRules` / `StoreRules`).
- **Sunrise/sunset** — set your location for sun-based scheduling.
- **No dependencies** — pure Python stdlib, no pip packages required.

## Before you install — remove HA's built-in `wemo` integration

⚠️ Home Assistant ships a built-in `wemo` integration that uses the **same SSDP / DHCP discovery patterns** as Dibby Wemo. Running both at the same time causes:

- Duplicate switch entities (`switch.family_room_lamp` and `switch.family_room_lamp_2`)
- Competing pollers — extra LAN traffic and occasional state-flapping
- Discovery hijack — the built-in integration may claim the SSDP packet before Dibby Wemo's config flow sees it, leaving Dibby's setup dialog empty

**Remove it before installing Dibby Wemo:** Settings → Devices & Services → click the **Belkin Wemo** card (if present) → ⋮ → **Delete**. If you've never set it up, there's nothing to remove.

## Installation

1. HACS → Integrations → search **Dibby Wemo** → Install
2. Restart Home Assistant
3. Settings → Devices & Services → **+ Add Integration** → search **Dibby Wemo** → Submit
4. The **Devices Found** dialog lists every Wemo discovered on your network — click Submit to register them all as switch entities

## Discovery on every network type

The integration tries two discovery methods in sequence on every scan:

1. **SSDP M-SEARCH** to `239.255.255.250:1900` — works on bare-metal HA and HAOS with the VM bridged + Promiscuous mode = Allow All.
2. **Unicast `/24` subnet scan** — falls back automatically when SSDP returns zero. Probes every IP on every local subnet for `/setup.xml` on Wemo ports 49152–49156 using a 32–96-worker thread pool. Completes in ~5–6 seconds and works inside Docker bridge networking where multicast can't reach.

The **default discovery timeout is 60 seconds** so the scan has plenty of budget even on busy LANs.

## Adding more Wemos later — without restarting HA

When you plug a new Wemo into your network after the integration is already set up:

1. Plug the device in and pair it with Wi-Fi (Belkin app, or any normal Wemo setup method). Wait ~30 seconds for it to come online.
2. In Home Assistant, go to **Settings → Devices & Services → Dibby Wemo card → Configure**.
3. Choose **Discover devices now** from the two-button menu.
4. After ~15–30 seconds the **Scan results** dialog lists every Wemo found, including the new one.
5. Click **Submit**. The integration reloads in place — no HA restart — and the new device appears as a switch entity within seconds.

If a device still doesn't show up: **Configure → Edit settings → Manual device IPs** accepts a comma-separated list like `192.168.1.42, 192.168.1.43:49153`. Manual entries are merged with discovery results on every reload.

## Rule persistence

Rules are stored in `<config>/dibby-wemo.json` (alongside your `configuration.yaml`). The file is fully cross-compatible with the companion apps so you can author rules anywhere and they show up everywhere:

- **Windows / Linux / macOS** desktop app
- **Homebridge plugin** (`homebridge-dibby-wemo`)
- **Synology NAS** (Docker image or native `.spk`)
- **Android** companion app

HACS upgrades preserve this file — it lives in your HA config dir, not inside the integration's Python package, so `Redownload` and version bumps never wipe your rules.

---

*Dedicated to Dibby ❤️*
