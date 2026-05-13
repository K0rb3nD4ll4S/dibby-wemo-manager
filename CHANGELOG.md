# Changelog

All notable changes to Dibby Wemo Manager are documented here.

---

## [2.0.28] — 2026-05-13

### Homebridge plugin — three UI improvements + persistence guarantee

#### 1. Configurable discovery timeout on the Discover button

The Discover button on the **Devices** tab now exposes a per-scan timeout dropdown (10 / 20 / 30 / 45 / 60 s, default 30 s) right next to it. Previously the button was hardcoded to 10 s, which was too short on busy LANs or networks with slow-responding Wemos. The button's status line also reflects the chosen budget so users see what they're waiting on.

`packages/homebridge-plugin/homebridge-ui/public/index.html` + `index.js`.

#### 2. Manual IP add — for VLAN-isolated or SSDP-unfriendly Wemos

A new **Add by IP** row sits below the Discover button on the same Devices tab: enter `192.168.x.y` + optional port (default 49153), click **+ Add Device**, and the server probes `/setup.xml` on the supplied IP via the existing `wemoClient.getDeviceInfo()`. On success the device is merged into the cached list and appears immediately as a switch tile.

This is the path for Wemos on a different VLAN, behind a Docker bridge, or otherwise unreachable by multicast SSDP — exactly the same problem the HA integration's manual-fallback solves.

New `/devices/addManual` handler in `packages/homebridge-plugin/homebridge-ui/server.js`.

#### 3. Card title legibility + green "Wemo Devices" heading

The **Bonus Room Pot Light** / **Deck Master** etc. titles on each device card were rendering near-black on dark blue because the Homebridge UI host stylesheet (Bootstrap utility classes) was overriding `.card-title`. CSS now uses explicit `color: #ffffff !important`, font-size `1.05rem`, weight `700`, and a brighter `#cbd5e1` for the subtitle — high contrast on every Homebridge UI theme.

The **Wemo Devices** section heading at the top of the Devices tab is now rendered in bold green (`#4ade80`, weight 700) so it pops against the navy background and matches the on-state accent used elsewhere.

`packages/homebridge-plugin/homebridge-ui/public/index.html`.

#### 4. Sticky devices + DWM rules survive plugin upgrades

Both the device list **and** DWM rules now have an explicit upgrade-survival guarantee:

- **Storage location** — `<homebridge-storage>/dibby-wemo.json`. This path is in Homebridge's storagePath, **outside** the npm package directory, so `npm update -g homebridge-dibby-wemo` has never touched it and never will.
- **Sticky-device rule** — `DwmStore.mergeDevices()` now carries an explicit doc-comment guarantee: once a Wemo has been detected, it stays in the cached list permanently. A re-scan only refreshes host/port/name/firmware on existing records — offline or unreachable devices are kept exactly as cached, so a network blip during a Discover never wipes anything. Manual-add additions are merged the same way.
- **Verification log** — `WemoPlatform` now logs the rule + device count loaded from the store on every Homebridge startup, e.g.:

  ```
  [Store] Loaded from /var/lib/homebridge/dibby-wemo.json — 12 device(s), 7 DWM rule(s).
  ```

  If either number changes unexpectedly after an upgrade, that log line surfaces the regression immediately.

`packages/homebridge-plugin/lib/platform.js`, `packages/homebridge-plugin/lib/store.js`.

### Affected packages
All monorepo packages bumped to **2.0.28** in unified versioning. Only `homebridge-dibby-wemo@2.0.28` ships functional changes in this release.

---

## [2.0.27] — 2026-05-13

### Feature: Synology NAS support (DSM 7+) — Docker image + native `.spk`

A Synology NAS is now a first-class always-on host for Dibby Wemo. Two install paths are shipped with this release, both fully compatible with DSM 7:

#### Path A — Container Manager / Docker (recommended)

Multi-arch image (`linux/amd64` + `linux/arm64`) published to GitHub Container Registry on every `v*.*.*` tag.

- `docker/Dockerfile` — multi-stage Alpine build using **real** Node 20 LTS (not Electron's BoringSSL, which lacks the `chacha20-poly1305` cipher needed by `hap-nodejs` for HomeKit). Stage 1 assembles the bundle from `docker/server.js`, `packages/homebridge-plugin/lib/`, and `apps/desktop/resources/web/`; stage 2 is a minimal runtime image with `tini`, `su-exec`, and `curl` for healthchecks.
- `docker/entrypoint.sh` — honours `PUID`/`PGID` envs so a bind-mounted `/volume1/docker/dibby-wemo/data` is writable by the DSM user (Synology defaults to UID 1026 / GID 100). Drops privileges to the non-root `dibby` user before exec'ing the Node server.
- `docker/synology-compose.yml` — Synology-tuned Compose template with the mandatory `network_mode: host` (required for HomeKit's mDNS and Wemo's SSDP multicast — Docker's bridge network filters both).
- `docker/build-multiarch.sh` — local `docker buildx` wrapper for amd64 + arm64.
- `.github/workflows/build-docker.yml` — updated to use the new `docker/Dockerfile` path, build multi-arch via QEMU, and push to `ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager:<version>` on every tag.

#### Path B — Native Package Center `.spk`

Installable directly from DSM 7 **Package Center → Manual Install** for users who prefer native packages or whose NAS can't run containers.

- `packages/synology-spk/` — full DSM 7 package skeleton: `INFO.tmpl`, `conf/{resource,privilege}` for the DSM-7-mandatory non-root run user, lifecycle scripts (`start-stop-status`, `postinst`, `postuninst`, `preupgrade`, `postupgrade`), and a `ui/config` shortcut that registers the web UI in DSM's app launcher.
- `packages/synology-spk/build-spk.sh` — per-arch builder that downloads the matching Node 20 LTS binary, installs runtime deps via `npm install --omit=dev`, and packages everything into a `.spk` tarball for each supported DSM arch:
  - `apollolake` (DS418play, DS918+, DS1019+)
  - `geminilake` (DS220+, DS420+, DS720+, DS920+, DS1520+)
  - `denverton` (DS1819+, DS3018xs, RS1619xs+)
  - `broadwell` (DS3617xs, RS3617xs, RS18017xs+)
  - `rtd1296` (DS124, DS223, DS223j, DS423)
- `.github/workflows/build-synology-spk.yml` — builds all arches on tag push and attaches the `.spk` artifacts to the matching GitHub release.

Both paths deploy the **same** JS bundle (scheduler, store, HomeKit bridge, web UI) — packaging is the only difference, so feature parity is guaranteed.

### Docs

- `README.md` — new **Synology NAS (DSM 7+)** section under the install paths, with a copy-paste-ready Compose template, an arch-to-NAS-model lookup table for the `.spk` path, the "why `network_mode: host`" explanation, and first-run setup steps.
- `packages/synology-spk/README.md` — packaging-internals doc for contributors who need to rebuild `.spk` files locally.

### Affected packages
All monorepo packages bumped to **2.0.27** in unified versioning.

---

## [2.0.26] — 2026-05-12

### Fix: HA integration now actually registers discovered Wemos as entities

After v2.0.23/.24 got SSDP working in the HAOS VM (9 locations returned), the integration still showed zero entities. Cause: `setup.xml` was being fetched and XML-parsed successfully, but every field lookup returned an empty string — including `UDN`, which we use as the unique key. Devices without a UDN were silently dropped, so the coordinator started with 0 devices and no switch entities were registered.

Root cause: Wemo's `setup.xml` declares `xmlns="urn:Belkin:device-1-0"`, **not** the UPnP standard `urn:schemas-upnp-org:device-1-0` that the parser was looking up. Every `find(".//d:UDN", ns)` returned `None`.

Fix — `custom_components/dibby_wemo/wemo_client.py`:
- `_fetch_setup_xml_sync` now matches tags via the `{*}` wildcard namespace (Python 3.8+), so any namespace Belkin's firmware uses (current or future) resolves correctly.
- Added warning-level logs when `setup.xml` parses but UDN is empty, plus a summary `discover_devices: N raw -> M device(s) (failed_fetch=…, missing_udn=…)` line so the path from SSDP packet to registered entity is visible.
- `async_setup_entry` now logs the device count handed to the coordinator and the list of `name@host` entries, making any future "discovery worked but entities didn't appear" issue trivially diagnosable.

### Tweak: default discovery timeout raised to 60 s

`DEFAULT_DISCOVERY_TIMEOUT_S` bumped from 10 → 60 in `const.py`. Wemos can take a while to respond on busy or noisy LANs, and the unicast subnet scan benefits from the extra budget when multiple /24s have to be swept. Existing installs keep whatever value they already saved; only new setups get the new default.

### Docs: README rewrite for the HA integration

- "Remove HA's built-in `wemo` integration" is now a numbered **Step 1 prerequisite** above the HACS install steps, with explicit consequences listed (duplicate entities, racing pollers, discovery hijack).
- New section **"Adding more Wemos later — the Discover devices now button"** walks through the seven-step Configure flow for picking up new Wemos without restarting Home Assistant.

### Affected packages
All monorepo packages bumped to **2.0.26** in unified versioning.

---

## [2.0.25] — 2026-05-12

### Fix: HA store I/O no longer blocks the event loop

Home Assistant's loop watchdog reported two blocking `open()` calls inside `DwmStore`:

- `store.py:30` — initial JSON load called synchronously from `__init__`, which itself was called from `async_setup_entry`
- `store.py:40` — JSON save called from every `_set()`, which fires on every heartbeat (~once/second) and on every rule mutation

Both ran on the asyncio loop thread and stalled HA's scheduler under load.

Fix — `custom_components/dibby_wemo/store.py`:
- `DwmStore.__init__` no longer reads the file. New `async_create(hass, config_dir)` classmethod-factory dispatches the initial read to `hass.async_add_executor_job`.
- `_save()` now `deepcopy`s the in-memory dict and fires `hass.async_add_executor_job(_sync_save, snapshot)` — the loop returns immediately and the actual disk write happens on the executor pool. Concurrent mutations are safe because each save operates on its own immutable snapshot.
- `_sync_load` / `_sync_save` are clearly marked as executor-only sync primitives.

`__init__.py`'s `async_setup_entry` updated to `await DwmStore.async_create(...)`.

### Affected packages
All monorepo packages bumped to **2.0.25** in unified versioning.

---

## [2.0.24] — 2026-05-12

### Feature: "Discover devices now" button in HA integration options

After Dibby Wemo is set up, adding a new Wemo to the network required either restarting Home Assistant or waiting for HA's passive SSDP/DHCP discovery to catch the device — neither path is obvious or fast. Now the integration's **Configure** dialog opens to a menu with two paths:

- **Discover devices now** — re-runs the full SSDP + multi-subnet unicast scan, shows what was found, and on Submit reloads the config entry so the coordinator picks up any newly online Wemos without an HA restart.
- **Edit settings** — the previous options form (timeouts, polling, heartbeat, manual IP list). Saving here also triggers an entry reload so manual device additions take effect immediately.

Files:
- `custom_components/dibby_wemo/config_flow.py` — `DibbyWemoOptionsFlow` refactored to a menu (`async_show_menu`) with `async_step_discover` and `async_step_settings` paths.
- `custom_components/dibby_wemo/strings.json` and `translations/en.json` — new menu labels and step descriptions.

### Affected packages
All monorepo packages bumped to **2.0.24** in unified versioning.

---

## [2.0.23] — 2026-05-12

### Fix: HA unicast scan now finds devices when the integration runs in a container

v2.0.22's unicast scan used a single "find my IP" trick (UDP connect to 8.8.8.8 → read local end). In HAOS-in-a-VM and HA-in-Docker layouts the integration's Python process often sits behind a docker-internal interface (172.x), so the trick returned an IP whose /24 has nothing to do with the user's Wemo LAN. Scanning 172.30.32.0/24 finds zero Wemos no matter how long the timeout.

Fix — `custom_components/dibby_wemo/wemo_client.py`:
- `_local_subnet_candidates()` (new) enumerates every plausible /24 the host has an interface on. Three strategies are union'd:
  1. UDP connect-trick (primary outbound IP)
  2. `socket.gethostbyname_ex(gethostname())` — picks up the LAN-side IP in HAOS
  3. `socket.getaddrinfo(gethostname(), None)` — last-resort
- Loopback (127.x) and link-local (169.254.x) are filtered out.
- `_unicast_subnet_scan_sync()` now scans **every** candidate /24 in parallel with a 32–96 worker thread pool; a 2-subnet sweep still completes in ~5–6 seconds.
- INFO log lines now report which subnets were scanned and how many Wemos were found — visible by enabling `logger: dibby_wemo: info` in `configuration.yaml`.

### Affected packages
All monorepo packages bumped to **2.0.23** in unified versioning.

---

## [2.0.22] — 2026-05-11

### Fix: Home Assistant integration discovers devices in Docker bridge mode

Many HA installs run inside a Docker container with `bridge` networking. SSDP multicast (`239.255.255.250:1900`) does not traverse the bridge, so both HA's own discovery framework and our internal M-SEARCH would return zero devices, leaving users with a "No devices found" dialog and no path forward except manual IP entry.

Fix — `custom_components/dibby_wemo/wemo_client.py`:
- `_local_subnet_base()` detects the container's outbound interface IP and derives the local `/24` base.
- `_probe_wemo_ip_sync(host)` performs a unicast `GET /setup.xml` against every Wemo port candidate (49152–49156) with a short timeout, accepting only responses containing "Belkin".
- `_unicast_subnet_scan_sync()` sweeps the full `/24` with a thread pool (32–64 workers) — a complete scan finishes in ~5 seconds.
- `discover_devices()` runs SSDP first as before; if SSDP returns nothing, automatically falls back to the unicast scan. On host-network and bare-metal installs the SSDP path still wins and nothing changes.

Bridge-mode users now see their Wemos in the initial setup dialog instead of an empty list.

### Affected packages
All monorepo packages bumped to **2.0.22** in unified versioning.

---

## [2.0.21] — 2026-05-11

### Fix: macOS window now appears

v2.0.20 set `hardenedRuntime: true` alongside ad-hoc signing (`identity: "-"`). On macOS that combination is unstable — hardened runtime needs strict entitlements + signed library inheritance that ad-hoc identities don't satisfy cleanly, and the renderer process gets killed before the window can show, leaving the user looking at a launched-but-invisible app.

Fix:
- `hardenedRuntime: false` — no strict sandbox, entitlements aren't applied (and aren't needed for an unsigned/ad-hoc app)
- Removed `entitlements` + `entitlementsInherit` references (orphaned without hardened runtime; kept the .plist file on disk for future Apple Developer ID upgrades)
- `extendInfo.LSUIElement: false` explicitly tells macOS this IS a regular foreground app with a dock icon, not a menu-bar utility (some Electron builds inherit `LSUIElement: true` by accident)
- `extendInfo.NSHighResolutionCapable: true` for Retina display support

Future Apple Developer ID releases can re-enable hardened runtime + re-link the entitlements file.

### Affected packages
All monorepo packages bumped to **2.0.21** in unified versioning.

---

## [2.0.20] — 2026-05-11

### Fix: macOS .dmg now opens on macOS 15 (Sequoia)

v2.0.19 shipped with `identity: null` in the macOS build config, which tells electron-builder to **skip signing entirely**. On macOS 15+ Gatekeeper refuses to launch unsigned apps even via right-click → Open — so the v2.0.19 .dmg files would not open on current macOS at all.

Fix: switch to **ad-hoc signing** (`identity: "-"`). The `codesign -s -` invocation on the macOS CI runner generates a runtime-only identity that Gatekeeper accepts via right-click → Open on every macOS version, including Sequoia. Still not Apple-notarised (would require a $99/yr Apple Developer account); future releases can upgrade by setting `CSC_LINK` + `CSC_KEY_PASSWORD` secrets in repo settings and changing `identity: "-"` to `identity: "Developer ID Application: ..."`.

### Fix: HA hassfest validation passes (manifest key order)

The `custom_components/dibby_wemo/manifest.json` now sorts keys as `domain, name, then alphabetical` per Home Assistant's `hassfest` convention. v2.0.19 was functional but failed CI validation; no user-visible difference.

### Affected packages
All monorepo packages bumped to **2.0.20** in unified versioning.

---

## [2.0.19] — 2026-05-11

### macOS support — desktop app + headless LaunchDaemon

Dibby Wemo Manager now runs on macOS with full feature parity to the Windows build:

- **Cross-platform path refactor.** All hardcoded `C:\ProgramData\DibbyWemoManager\` references replaced with a new `apps/desktop/src/main/core/paths.js` module that resolves to:
  - Windows: `C:\ProgramData\DibbyWemoManager\`
  - macOS:   `/Library/Application Support/Dibby Wemo Manager/`
  - Linux:   `/var/lib/dibby-wemo-manager/`
- **macOS headless service** via LaunchDaemon (`/Library/LaunchDaemons/com.srsit.dibbywemoscheduler.plist`):
  - Install/uninstall/start/stop wired through `launchctl` via AppleScript's `do shell script with administrator privileges` (native macOS auth dialog — no extra dependencies)
  - Service runs at boot under `root` via launchd, keeps the bridge + scheduler alive even when the desktop app is closed and across reboots
  - Same architectural model as Windows: deployed scripts + node binary in shared data dir, GUI process and daemon share state via JSON files
- **Universal `node` binary** shipped via `extraResources` so the LaunchDaemon has a Node interpreter that supports `chacha20-poly1305` (Electron's BoringSSL doesn't expose it — same constraint as on Windows)
- **Hardened-runtime + entitlements** for macOS code signing & notarisation (`resources/entitlements.mac.plist`):
  - `allow-jit` + `allow-unsigned-executable-memory` for Electron V8
  - `disable-library-validation` because the bundled node binary is signed with a different Developer ID than Electron itself
  - `network.server` / `network.client` for HAP + SOAP/SSDP traffic
- **Platform-aware UI labels.** "DibbyWemoScheduler service" on Windows, "Dibby Wemo LaunchDaemon" on macOS, "dibby-wemo-scheduler systemd unit" on Linux (planned for v2.0.20). All references in the HomeKit Bridge panel and confirm dialogs follow `navigator.platform`.

#### Files added / changed for macOS support
- `apps/desktop/src/main/core/paths.js` — new shared paths module
- `apps/desktop/src/main/service-manager.js` — added `_macInstall`, `_macUninstall`, `_macStart`, `_macStop`, `_macStatus`, AppleScript-based privileged shell helper, platform dispatcher wraps the existing Windows code
- `apps/desktop/src/main/scheduler-standalone.js` / `service-manager-sync.js` / `homekit.ipc.js` / `ipc/rules.ipc.js` — all now use `PATHS.*` constants from `core/paths.js` instead of hardcoded `C:\ProgramData`
- `apps/desktop/package.json` — per-platform `extraResources` (Windows `node.exe`, macOS `node`, Linux `node`); `mac.hardenedRuntime`, `mac.entitlements`, `mac.category`
- `apps/desktop/resources/entitlements.mac.plist` — new entitlements file
- `apps/desktop/resources/NODE_BINARY_README.md` — doc for placing platform Node binaries
- `apps/desktop/src/renderer/src/App.jsx` — `_platformServiceLabel()` helper + label substitutions throughout HomeKit Bridge panel

#### Linux support
- Cross-platform paths work; service install (`systemd` unit) is **scaffolded but not implemented in this release** — `_linuxNotImplemented()` returns a clear error. Target: v2.0.20.

### Home Assistant integration — proper discovery via HA's own SSDP / DHCP framework

The HA integration previously relied on raw `socket` multicast in its config flow to find Wemos. That works in Home Assistant Core / HAOS but **fails silently** in Home Assistant Container (Docker bridge networking) — the most common install style — because the container's network namespace can't bind multicast sockets the way HA's privileged supervisor can.

This release switches to **Home Assistant's built-in SSDP and DHCP discovery framework**:

- `manifest.json` now declares SSDP `deviceType` patterns for every Wemo product line (`controllee`, `lightswitch:1`/`:2`, `sensor`, `Lighting`, `bridge`, `insight`, `Maker`, `dimmer`, `Crockpot`, `Coffee`, `HeaterB`, `HumidifierB`, `AirPurifier`, `NetCamSensor`) plus the catch-all manufacturer `Belkin International Inc.`
- `manifest.json` also declares DHCP `macaddress` patterns for 18 known Belkin OUIs (94:10:3E, AC:9C:81, EC:1A:59, 14:91:82, 24:F5:A2, B4:75:0E, A4:08:F5, 7C:8B:B5, C0:56:27, 64:62:5A, 24:E5:0F, 38:43:7D, 68:DB:F5, 90:CD:B6, 80:69:1A, F4:F5:A8, 08:86:3B), so a new Wemo joining the network triggers HA's auto-discovery
- `config_flow.py` adds `async_step_ssdp` and `async_step_dhcp` handlers; the user just clicks confirm on the popup HA shows them when a Wemo is detected
- The legacy `async_step_user` flow is kept as a fallback and now accepts a **comma-separated manual device list** for environments where neither SSDP nor DHCP discovery works
- Options flow also exposes manual-device editing post-install
- Single-instance unique ID — one Dibby Wemo integration covers every device on the LAN
- `strings.json` updated with new dialog copy + per-field hints

This brings Dibby Wemo's HA discovery behaviour in line with Home Assistant's built-in `wemo` integration, but without losing any of Dibby's DWM scheduling features.

### What users will see
- **Existing installs** — restart HA after updating via HACS. Existing config entries stay; new devices auto-appear via SSDP.
- **Fresh installs** — within seconds of adding the integration, HA's own SSDP service surfaces any Wemo as an auto-discovery suggestion. No more "0 devices found" dead end.
- **Docker bridge users** — discovery still works because HA's supervisor handles SSDP, not the integration's container.

### Affected packages
All monorepo packages bumped to **2.0.19** in unified versioning. Desktop, Homebridge plugin, Node-RED, MQTT bridge, and Android share the version; the meaningful code change is in `custom_components/dibby_wemo/`.

---

## [2.0.18] — 2026-04-28

### Embedded HomeKit bridge — runs HEADLESS in the scheduler service

Dibby now ships its own HAP (HomeKit Accessory Protocol) bridge using `hap-nodejs`, and it runs **inside the `DibbyWemoScheduler` background service** — not in the desktop app. Pair Dibby once with Apple Home and **every Wemo on your network** appears as a HomeKit Switch, including older Wemos with no native HomeKit firmware. Because the bridge is in the always-on service, it stays alive when the desktop app is closed and across reboots — perfect for users without an always-on PC.

#### How it's wired up

- **Service hosts bridge.** When `DibbyWemoScheduler` starts, it loads `homekit-bridge.js` and publishes the bridge on mDNS. The bridge runs in the same Node process as the rule scheduler.
- **Bridge identity is persistent and shared.** Username MAC, pincode, and pairing trust live in `C:\ProgramData\DibbyWemoManager\homekit-bridge\` so the bridge survives service restarts AND reboots without re-prompting Apple Home.
- **Service writes a status snapshot every 30 s** to `homekit-bridge\status.json` (running flag, pincode, X-HM:// URI, QR data URL, paired-controller count, accessory count). The desktop app's Settings UI reads this file to display status — the desktop never runs the bridge itself when the service is hosting it (avoids port collision).
- **In-app fallback.** If the service is NOT installed, the desktop app can host the bridge in-process (Settings → "Start in-app fallback"). Storage in this case is `<userData>/homekit-bridge/`. Bridge stops when the desktop app is closed — recommended only for evaluation.
- **Live device sync.** The service watches `devices.json`; whenever the desktop app saves a new device list, the bridge reconciles its HAP accessory list (adds new, removes vanished) without any user intervention.
- **State polling** every 30 s pushes live on/off changes to HomeKit so automations driven by Wemo state changes are responsive. HomeKit reads return cached state instantly to avoid `SLOW_WARNING`.

#### Settings UI

Settings → 🏠 HomeKit Bridge shows:
- **Mode banner** — "Headless mode" (service hosts) vs install/start CTAs vs in-app fallback
- **Live status** — running/stopped, paired-controller count, accessory count
- **Pairing QR** — scannable X-HM:// QR + manual pincode for fallback entry
- **Auto-start** toggle (mirrors to both service and app preference files)
- **Sync Devices** — touches `devices.json` so the service re-reconciles
- **Reset Pairings** — wipes pairing trust + identity for a fresh re-pair

#### What this means for users without a computer

Install `DibbyWemoScheduler` once (1-click in Settings, or via the NSIS installer). The service runs at boot under SYSTEM. The bridge is alive 24/7. Every Wemo appears in Apple Home. No desktop app needed after pairing. A $35 Pi running the Linux build does the same thing.

#### Files added / changed
- `apps/desktop/src/main/homekit-bridge.js` — encapsulated bridge module (start/stop/syncDevices/getStatus/resetPairings); uses hap-nodejs's official `bridge.setupURI()` for canonical X-HM:// QR encoding (the format Apple Home actually accepts — includes the 4-char setupID suffix)
- `apps/desktop/src/main/scheduler-standalone.js` — auto-starts and graceful-stops the bridge inside the headless service; writes `status.json` every 30 s
- `apps/desktop/src/main/ipc/homekit.ipc.js` — service-mode preferred, in-app fallback when service is absent; mirrors auto-start prefs to both locations
- `apps/desktop/src/main/service-manager.js` — copies bundled `node.exe`, `node-windows/`, and the scheduler script to `C:\ProgramData\DibbyWemoManager\` so service config references stable paths (works from both portable and installer); recursively walks node-windows' transitive dep tree (`xml`, `yargs`, `yargs-parser`, `cliui`, `string-width`, `strip-ansi`, `ansi-regex`, `ansi-styles`, `wrap-ansi`, `escalade`, `get-caller-file`, `require-directory`, `y18n`, `emoji-regex`, `is-fullwidth-code-point`); 45-s install timeout with stage-trace logging at `service-install.log`
- `apps/desktop/package.json` — `hap-nodejs ^0.14.3` added to dependencies; `extraResources` ships a real `node.exe` (~91 MB) so the service has a Node interpreter that supports `chacha20-poly1305` (Electron's bundled BoringSSL doesn't expose it in a hap-nodejs–compatible way); `nsis.perMachine: true` for all-users install default
- `apps/desktop/electron.vite.config.js` — `homekit.ipc.js` and `homekit-bridge.js` added to bundle entry points
- `apps/desktop/src/preload/index.js` — `hkBridge*` API exposed to renderer
- `apps/desktop/src/renderer/src/App.jsx` — `HomeKitBridgePanel` with mode-aware UI (headless/installed-not-running/in-app/no-service); install / start / stop / **uninstall** service buttons inline in the panel
- `apps/desktop/resources/nsis-installer.nsh` — `customInit` hook stops + cleans the previous install before file copy (no `ERROR_SHARING_VIOLATION` on upgrade); `customUnInstall` removes the service, `daemon/`, `node-windows/`, `homekit-bridge/`, `node.exe`, and `service-install.log`
- `apps/desktop/tools/uninstall-service.ps1` — standalone admin-elevating cleanup tool (also removes `node.exe` and `service-install.log`)

### Service management buttons in Settings (install / start / stop / uninstall)

The HomeKit Bridge panel in Settings now has the full service-management surface inline. Whatever state the service is in, the right buttons are visible:

| Service state | Buttons shown |
|---|---|
| Not installed | ⚙ Install DibbyWemoScheduler service |
| Installed, stopped | ▶ Start service · 🗑 Uninstall service |
| Installed, running | ■ Stop service · 🗑 Uninstall service |

The Uninstall button shows a confirm dialog explaining that bridge pairing data, deployed node-windows, and the bundled node.exe will be removed (devices and DWM rules are preserved). The same buttons exist in the Sidebar's Scheduler panel — both surfaces stay in sync via shared status polling.

### QR code for native HomeKit setup codes

For Wemos that DO have native HomeKit firmware, the per-device Info tab now shows a scannable X-HM:// QR alongside the setup code text. Open Apple Home → + → Add Accessory → scan and pair, no need to look up the physical sticker.

- `apps/desktop/src/main/wemo.js` — `buildHomeKitSetupURI()` and `homeKitCategoryFromModel()` helpers; `getHomeKitInfo()` now returns `setupURI` and `category` fields
- `apps/desktop/src/main/ipc/devices.ipc.js` — new `get-homekit-qr` IPC handler returns `{ setupCode, setupURI, qrDataURL, category }`
- `apps/desktop/src/renderer/src/components/device/DeviceInfoTab.jsx` — QR rendered next to setup code, with click-to-copy on URI; HAP category readout

### UX honesty: Wemo firmware schedulers no longer fire rules autonomously

After Belkin shut down their cloud (2024), the on-device autonomous scheduler in Wemo firmware no longer wakes up to fire scheduled rules. The rule data is stored on the device but never triggers — confirmed across Socket and LightSwitch firmware revisions through end-to-end testing in this house. This isn't a Dibby bug; the firmware was designed to receive a cloud-pushed "reload rules" nudge over the TLS pipe to `api.xbcs.net`, and that nudge no longer comes.

This release adds clear in-app warnings so users understand what's happening:

- **`RuleEditor` warning banner** (`apps/desktop/src/renderer/src/components/rules/RuleEditor.jsx`) — when editing a Wemo (firmware) device rule, a prominent banner explains that the rule is saved to the device's memory but won't fire without an external scheduler. Recommends DWM rules or running Dibby's scheduler service.
- **`AllRulesTab` system banner** (`apps/desktop/src/renderer/src/components/rules/AllRulesTab.jsx`) — if the system has any device-firmware rules but the `DibbyWemoScheduler` Windows service isn't running, a top-of-page banner says the rules aren't firing and points to the install/start flow.
- **Live scheduler status polling** — every 15 s the rules tab queries `serviceStatus()` so the banner appears/disappears as the service is started or stopped.

### What this proves and why it can't be "fixed at the firmware layer"

We did the full reverse-engineering loop and documented it here so future contributors don't repeat it:

- Tried `StoreRules` (SQLite-in-ZIP), `UpdateWeeklyCalendar` (simple per-day timer string), `EditWeeklycalendar` enable/disable/remove, fake `ServerEnvironment`, `SetSetupDoneStatus`, soft reboot — all accepted at the SOAP layer, none cause rules to fire
- Devices actively try to reach `api.xbcs.net:443` constantly (visible in proxy log) — they want the cloud nudge
- Belkin's real server `97.74.107.18:443` now times out (was alive in March 2026); `api.xbcs.net` returns NXDOMAIN
- TLS interception is blocked: device pins a specific GoDaddy intermediate cert chain and rejects forged certs with `unknown ca` alert
- Public web / dark web search for leaked Belkin TLS server private keys: nothing
- 2014 IOActive disclosure was about the GPG firmware-signing key, NOT the TLS server key; rotated by Belkin in their Jan 2024 patch anyway, irrelevant to current firmware revisions
- Firmware modification (custom build with cloud-pinning removed) requires per-device serial-port flash and breaks HomeKit pairing — multi-month embedded engineering project, not a viable v2.0.18 fix

The honest answer: **rules must be fired by an external scheduler.** Dibby already provides this — the `DibbyWemoScheduler` Windows service (and the Homebridge plugin, Home Assistant integration, Node-RED nodes, MQTT bridge) all act as external schedulers.

### Recommended setup for users without an always-on PC

- **Raspberry Pi running Dibby's Linux build** (~$35 hardware, low power)
- **Homebridge** on existing HomeKit hub
- **Home Assistant** on existing automation hub
- **Android phone** with the Dibby Android app in foreground mode (works on a phone left on a charger)

Even one of these covers an entire household of Wemo devices — the scheduler doesn't need to run on every device.

### Affected packages
All monorepo packages bumped to **2.0.18** in unified versioning.

---

## [2.0.17] — 2026-04-21

### Fix — Day-of-week off-by-one for rules from the Belkin WeMo app

Rules created by the **official Belkin WeMo phone app** (or any other source using Belkin's native firmware convention) were displaying with every day shifted +1 — a Friday rule appeared as Saturday, and so on. Rules created in Dibby Wemo itself were unaffected.

**Root cause:** Belkin's firmware encodes `RULEDEVICES.DayID` with a Sunday-first convention (`1=Sun, 2=Mon, …, 6=Fri, 7=Sat`), plus three special values: `0=Daily`, `8=Weekdays`, `9=Weekends`. Dibby was reading these values using its own ISO-8601 (Monday-first) convention, so every day was off by one and the bundle values (Daily / Weekdays / Weekends) were silently dropped.

This was confirmed by inspecting the official WeMo Android app's own `deCodeDays` function in the decompiled APK.

**Fix:** boundary translation at every Wemo-device I/O site — Dibby's internal day numbers stay Mon=1..Sun=7, but the firmware's Sunday-first `DayID` is translated on read and on write. Single-row "Daily / Weekdays / Weekends" bundles are now correctly expanded into their constituent days.

**Affected components, all patched in this release:**
- Desktop app (`apps/desktop`) — rules list, rule editor, standalone scheduler
- Homebridge plugin (`packages/homebridge-plugin`) — rules tab, copy-to-DWM, rule create/update
- Home Assistant integration (`custom_components/dibby_wemo`) — rule create/update API

**Round-trip with the Belkin app now works:** rules created in Dibby write `DayID` in Belkin's convention, so the WeMo phone app reads them back as the correct day.

### Affected packages
All monorepo packages bumped to **2.0.17** in unified versioning.

---

## [2.0.16] — 2026-04-21

### Homebridge: eliminate Characteristic SLOW_WARNING / TIMEOUT_WARNING

The Homebridge plugin was triggering [Characteristic Warnings](https://github.com/homebridge/homebridge/wiki/Characteristic-Warnings) in Homebridge logs — specifically `SLOW_WARNING` (>3 s) and occasionally `TIMEOUT_WARNING` (>10 s) on the `On` characteristic.

**Root cause:** the `onGet` handler for the `On` characteristic was making a live SOAP call to the Wemo device on every HomeKit read. Wemo UPnP responses are usually 150–400 ms on a healthy device, but can easily reach 3–10 s when the device is busy, on wifi, or momentarily unreachable — which HomeKit treats as a slow handler.

**Fix:** `onGet` now returns the cached state instantly. The background poll (running every `pollInterval` seconds, default 30 s) keeps the cache fresh and pushes real state changes to HomeKit via `updateCharacteristic`. This is the pattern the Homebridge docs explicitly recommend — HomeKit gets an instant response on every read, and state stays accurate because the poll already notifies HomeKit whenever the device's real state changes.

**Impact for users:** no more "slow read" warnings in Homebridge logs, faster HomeKit app response, and no change to how quickly state updates appear (still governed by `pollInterval`). Existing configs continue to work unchanged — no migration needed.

### Affected packages
All monorepo packages bumped to **2.0.16** in unified versioning.

---

## [2.0.15] — 2026-04-17

### Countdown rule is now state-based, not transition-based

The DWM **Countdown** rule (auto-timer-off / auto-timer-on) is now level-triggered instead of edge-triggered. Previously the timer only started when the device *transitioned* into the trigger state — so if the device was already ON when Homebridge, Home Assistant, or the Desktop scheduler started, the auto-off timer would never run until someone manually toggled it off and back on.

**New behavior:**

- The timer runs **whenever the device is in the trigger state**, regardless of how it got there. If the device is already ON when the scheduler starts, the auto-OFF countdown starts immediately.
- If the device leaves the trigger state before the timer fires (e.g. you manually turn off an auto-off device early), the timer is **cancelled** — no surprise re-toggle.
- If the device re-enters the trigger state, a fresh countdown starts.
- If the active-window expires mid-countdown, the timer is cancelled.

**UI wording updated everywhere:**

- "If device turns ON → auto-OFF after duration" → **"If device is ON → auto-OFF after duration"**
- "If device turns OFF → auto-ON after duration" → **"If device is OFF → auto-ON after duration"**

Applied consistently to:
- Desktop app Countdown editor (`CountdownEditor.jsx`)
- Homebridge plugin rule editor + Help tab (`homebridge-ui/public/index.html`)
- Home Assistant integration scheduler (`custom_components/dibby_wemo/scheduler.py`)

Existing rules with `countdownAction: 'on_to_off'` or `'off_to_on'` continue to work unchanged — only the trigger semantics improved. No rule-store migration required.

### Affected packages
All monorepo packages bumped to **2.0.15** in unified versioning.

---

## [2.0.14] — 2026-04-13

### Unified Versioning + Node-RED Publish + Home Assistant + HOOBS + WiFi Provisioning Fix + Homebridge 2.0 Compatibility

All monorepo packages synced to a single version (**2.0.14**) for coherent release tracking. Desktop, Homebridge plugin, Home Assistant custom component, Node-RED contrib, MQTT bridge, core, and Android app now share one version across the board.

**Home Assistant custom component** — `custom_components/dibby_wemo/manifest.json` bumped to 2.0.14. HACS users on the existing repository will see the update automatically. Install via HACS → Custom Repositories → add this repo as an Integration.

**HOOBS compatibility documented** — the `homebridge-dibby-wemo` plugin is fully HOOBS-compatible (HOOBS installs any plugin from the Homebridge npm registry). Install via the HOOBS Plugins tab.

**`node-red-contrib-dibby-wemo` published to npm at 2.0.14** — four drag-and-drop Node-RED nodes (`wemo-config`, `wemo-control`, `wemo-state`, `wemo-discover`) for local Wemo control inside Node-RED flows. Install via Palette Manager or `npm install node-red-contrib-dibby-wemo`.


#### Desktop App — WiFi Setup (v2.0.9)

The **Set WiFi** feature in the desktop app was non-functional since release. When setting up a WeMo device on its setup AP (`WeMo.Switch.xxx` / 10.22.22.1), the `ConnectHomeNetwork` SOAP call always failed with HTTP 500 / UPnP 501 "Action Failed". All root causes have been identified and fixed. **Confirmed working on F7C027 firmware 2.00.11851.**

**Root causes fixed:**

- **AP scan not performed before connecting** — The WeMo firmware requires `GetApList` to be called first to prime its internal AP cache. `ConnectHomeNetwork` without a preceding scan fails on some firmware versions. The app now always scans first and uses the exact `auth`/`encrypt` strings the device reports (e.g. `WPA2PSK`/`AES`) rather than normalising them
- **ConnectHomeNetwork must be sent twice** — Confirmed from pywemo and direct device testing: the firmware only reliably accepts the connection on the second call. The app now sends the request twice in quick succession
- **Wrong network status polling logic** — Status `2` means "connecting (in progress)" and should keep polling, but was wrongly treated as "bad password". Status `1` = Connected (success), `3`/`4` = failed
- **CloseSetup never called after success** — After `GetNetworkStatus` returns `1` (Connected), `CloseSetup` must be called to let the device finalise and reboot onto the home network. This call was missing entirely
- **AES-128-CBC password encryption** — password is encrypted using the device's MAC + serial (from `MetaInfo`) as key material, exactly as the official WeMo Android app does
- **Signal bars showed dBm thresholds** — The WeMo device reports signal as 0–100% (not dBm). Signal bars and percentage labels now display correctly
- **Real-time communication log** — A live SOAP request/response log panel is now visible in the WiFi tab while connecting, showing every step with color-coded entries (blue = sent, green = received, gray = status, red = error)

**Confirmed provisioning sequence (F7C027 firmware 2.00.11851):**
1. `GetApList` — scan to prime device cache and get exact auth/encrypt strings
2. `GetMetaInfo` — fetch MAC + serial for AES-128-CBC password key derivation
3. `ConnectHomeNetwork` (flat params, CDATA-wrapped SSID, encrypted password) — sent twice
4. Poll `GetNetworkStatus` every 3 s until `1` (Connected)
5. `CloseSetup` — device finalises and reboots onto the home network

#### Homebridge Plugin — Homebridge 2.0 Compatibility (v2.0.10)

- **Homebridge 2.0 beta declared compatible** — `engines.homebridge` updated to `^1.6.0 || ^2.0.0-beta.0`. Without this declaration Homebridge 2.0 logs a compatibility warning even though the plugin works correctly
- **Node.js 22 / 24 explicitly supported** — `engines.node` updated to `^18.20.4 || ^20.15.1 || ^22 || ^24`. Homebridge 2.0 beta requires Node.js 22 or 24
- Full audit confirmed: zero usage of any APIs removed in Homebridge 2.0 (`BatteryService`, `Characteristic.getValue()`, `getServiceByUUIDAndSubType()`, `updateReachability()`, `setPrimaryService()`, enum access via `Characteristic.*` — none present)

### Affected packages
- Desktop app (Windows) → **2.0.9**
- `homebridge-dibby-wemo` → **2.0.10** (npm)

---

## [2.0.13] — 2026-04-08

### Bug Fixes & New Features — Homebridge Rules UI

**Bug fixes:**
- **Rules toggle/edit/delete now work in Homebridge UI** — Inline `onclick`/`onchange` event handlers in dynamically rendered rule cards were silently blocked by the Homebridge UI iframe's Content Security Policy. All rule card buttons (toggle, edit, delete) now use `addEventListener` after rendering, which is CSP-safe.
- **Wemo device rules delete no longer silently fails** — `confirm()` is blocked in cross-origin iframes and always returns false. The delete button for on-device Wemo rules now uses the same inline confirm row pattern already used by DWM rules.

**New features:**
- **Delete All DWM Rules** — New "🗑 Delete All" button in the DWM Rules tab header. Shows an inline confirm bar before deleting.
- **Delete All Wemo Device Rules** — New "🗑 Delete All" button in the Wemo Device Rules tab (shown after a device is selected and rules are loaded). Deletes all firmware rules from the device one-by-one.
- **Copy Wemo Rules to DWM** — New "📋 Copy to DWM" button in the Wemo Device Rules tab. Converts each on-device firmware Schedule rule to a DWM Schedule rule targeting the same device, then reloads the DWM Rules tab.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.9** (npm)

---

## [2.0.12] — 2026-04-08

### Bug Fix — Windows SSDP Device Discovery

Fixed device discovery failing on Windows when multiple network adapters are present (WiFi, VPN, Hyper-V virtual adapters, etc.).

**Root cause:** `socket.addMembership()` was called without specifying a local interface, causing the OS to pick the wrong adapter for multicast. M-SEARCH packets went out the wrong interface and Wemo devices never responded.

**Fix:** SSDP discovery now enumerates all non-internal IPv4 interfaces and creates one UDP socket per adapter, each explicitly bound to that interface's IP with `addMembership` and `setMulticastInterface`. Applied to both the desktop app and the Homebridge plugin.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)
- Desktop app (Windows) → **2.0.8**

---

## [2.0.11] — 2026-04-05

### Version sync — all packages bumped to 2.0.8

All packages aligned to v2.0.8. Windows desktop rebuilt and signed. Linux packages built via GitHub Actions. node-red-contrib published to npm.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)
- `node-red-contrib-dibby-wemo` → **2.0.8** (npm)
- Desktop app (Windows) → **2.0.8**
- Desktop app (Linux — AppImage/deb/rpm) → **2.0.8** (built via GitHub Actions)
- Android app → **2.0.8**
- Home Assistant custom component → **2.0.8**
- Docker / MQTT bridge → **2.0.8**

---

## [2.0.11] — 2026-04-05

### Feature — Heartbeat, Poll & Discovery settings now in the Settings tab

The **Settings** tab in the Homebridge UI now shows three configurable fields:
- **Scheduler Heartbeat Interval** (1–300 s) — how often the scheduler writes its status heartbeat
- **Device Poll Interval** (10–300 s) — how often device state is polled for HomeKit updates
- **Discovery Timeout** (3000–60000 ms) — how long to wait for SSDP discovery responses

Changes are saved directly to `config.json` via the **Save Settings** button. No manual JSON editing required.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.8** (npm)

---

## [2.0.10] — 2026-04-04

### Bug Fix — Heartbeat Interval setting fails to save in Homebridge UI

Added missing `"maximum": 300` to the `heartbeatInterval` field in `config.schema.json`. Homebridge's schema validator requires both `minimum` and `maximum` on integer fields — without `maximum` the config would fail to save when `heartbeatInterval` was manually added.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.7** (npm)

---

## [2.0.9] — 2026-04-04

### Bug Fix — Infinite scroll on Devices and Rules tabs

The Homebridge UI panel no longer scrolls endlessly when there are few or no devices/rules. Removed `min-height: 100vh` from the UI body which was forcing the page to always fill the full viewport height.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.6** (npm)

---

## [2.0.8] — 2026-04-04

### Homebridge Verified + Donate Button

- Plugin is now **Verified by Homebridge** — badge added to README.
- Added PayPal **donate button** (`funding` field in `package.json`) — visible on the plugin tile in the Homebridge UI.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.5** (npm)

---

## [2.0.7] — 2026-04-01

### New Feature — Configurable Scheduler Heartbeat Interval

The DWM scheduler heartbeat is now decoupled from the 30-second tick and runs on its own independent timer (default: **1 second**). The interval is user-configurable from 1 to 300 seconds. The stale-detection threshold in the UI scales automatically with the configured interval (3× interval + 5 s grace).

**Why this matters:** IFTTT and HomeKit automations triggered by device state changes now reflect scheduler status within 1 second instead of waiting up to 90 seconds for the next tick cycle.

**Homebridge** — add to `config.json` platform block (or set via Homebridge UI):
```json
"heartbeatInterval": 1
```

**Home Assistant** — configurable in the integration Options flow (Settings → Devices & Services → Dibby Wemo → Configure).

### Affected packages
- `homebridge-dibby-wemo` → **2.0.4** (npm)
- `custom_components/dibby_wemo` → **2.0.5** (Home Assistant / HACS)
- `node-red-contrib-dibby-wemo` → **2.0.1** (npm — README added)
- Desktop app (Windows / Linux / macOS) → **2.0.7**
- Android app → **2.0.7**
- Docker image → `ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager:2.0.7`

---

## [2.0.6] — 2026-04-01

### New Feature — Node-RED Contrib Package

New `node-red-contrib-dibby-wemo` package published to npm — drag-and-drop Wemo nodes for Node-RED flows. Auto-indexed at flows.nodered.org.

**Four nodes included:**

| Node | Description |
|------|-------------|
| `wemo-config` | Shared config node — device IP + port |
| `wemo-control` | Send ON/OFF/toggle → get confirmed state back |
| `wemo-state` | Poll device state on interval → emit on change |
| `wemo-discover` | Trigger SSDP scan → one msg per device found |

**Install in Node-RED:**
```
Palette Manager → search: node-red-contrib-dibby-wemo → Install
```

### Affected packages
- `node-red-contrib-dibby-wemo` → **2.0.0** (new, npm)

---

## [2.0.5] — 2026-04-01

### New Feature — MQTT Bridge

New `packages/mqtt-bridge` workspace package: a lightweight Node.js service that bridges all Wemo devices to any MQTT broker, with Home Assistant MQTT Auto-Discovery built in.

**What it does:**
- Discovers Wemo devices via SSDP (+ optional manual device list)
- Publishes `ON`/`OFF` state to `dibby-wemo/{device}/state` on every change
- Subscribes to `dibby-wemo/{device}/set` for remote control
- Publishes `online`/`offline` availability per device and bridge LWT
- Registers all devices with Home Assistant automatically via `homeassistant/switch/{device}/config`
- Re-scans for new devices every 2 minutes

**Ships with:**
- `Dockerfile` — `ghcr.io/k0rb3nd4ll4s/dibby-wemo-mqtt:latest` (linux/amd64 + arm64)
- `docker-compose.yml` — one `docker compose up` starts both Mosquitto broker + bridge
- `mosquitto.conf` — minimal broker config included
- `build-mqtt.yml` — GitHub Actions workflow for multi-platform Docker build

**Works with:** Home Assistant, Node-RED, openHAB, Hubitat, Domoticz, and any MQTT-capable platform simultaneously.

**Usage:**
```bash
cd packages/mqtt-bridge
docker compose up -d
```

### Affected packages
- `@wemo-manager/mqtt-bridge` → **2.0.0** (new)
- Docker image: `ghcr.io/k0rb3nd4ll4s/dibby-wemo-mqtt:2.0.0`

---

## [2.0.4] — 2026-04-01

### Fixes & CI

- **manifest.json key order corrected** — `domain` and `name` first, then alphabetical. Required for hassfest validation.
- **Brand icon added** — `custom_components/dibby_wemo/icon.png` and `brand/icon.png` / `brand/logo.png` added for HACS validation.
- **HACS Action and hassfest workflows added** — Both CI checks now run on every push and both pass green.
- **HACS default PR resubmitted** (#6684) — From a feature branch with full checklist and all required links.

### Affected packages
- `custom_components/dibby_wemo` → **2.0.4** (Home Assistant / HACS)

---

## [2.0.3] — 2026-04-01

### Improvements

- **Devices registered in alphabetical order** — Homebridge and Home Assistant now register Wemo devices sorted by friendly name (A→Z). Affects newly added devices; existing devices already in the registry retain their current position unless removed and re-added.

### Affected packages
- `homebridge-dibby-wemo` → **2.0.3** (npm)
- `custom_components/dibby_wemo` → **2.0.3** (Home Assistant / HACS)

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
