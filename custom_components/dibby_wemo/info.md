# Dibby Wemo

Local Belkin Wemo control for Home Assistant — no cloud, no Belkin account required.

## Features

- **Auto-discovery** — finds all Wemo devices on your network via SSDP
- **Switch entities** — control any Wemo switch, plug, or light switch from HA
- **DWM Scheduling Engine** — built-in automation rules that run inside HA:
  - **Schedule** — turn devices on/off at fixed times or sunrise/sunset
  - **Countdown** — auto turn off/on after N minutes of being in a state
  - **Away Mode** — randomised on/off simulation within a time window
  - **Always On** — device kept ON at all times, corrected within 10 seconds
  - **Trigger** — when device A changes state, control device B
- **Firmware rules** — read and manage native Wemo device rules (FetchRules/StoreRules)
- **Sunrise/sunset** — set your location for sun-based scheduling
- **No dependencies** — pure Python stdlib, no pip packages required

## Installation

1. In HACS → Integrations → search **Dibby Wemo** → Install
2. Restart Home Assistant
3. Settings → Integrations → Add Integration → search **Dibby Wemo**
4. HA will scan your network and add all found Wemo devices automatically

## Manual Installation

Copy the `dibby_wemo` folder into your `<config>/custom_components/` directory and restart Home Assistant.

## Managing Rules

Rules are stored in `<config>/dibby-wemo.json` and are fully compatible with the companion apps:
- **Windows/Linux/macOS** desktop app
- **Homebridge plugin** (`homebridge-dibby-wemo`)
- **Android app**

---

*Dedicated to Dibby ❤️*
