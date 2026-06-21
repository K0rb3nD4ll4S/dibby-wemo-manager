# Changelog

All notable changes to Dibby Wemo Manager are documented here.

---

## [2.0.40] — 2026-06-21

### New: Windows add-on tool — "Clear Wemo Firmware Rules"

A standalone Node script ships with the **Windows installer only** that wipes every native Wemo firmware rule across all devices Dibby has discovered. Useful for cleaning up the legacy rules that stopped firing autonomously after Belkin shut down the cloud — they sit dead in each Wemo's on-device SQLite database, sometimes visible in the official Wemo app, often a source of confusion.

**DWM rules are not touched.** Only the firmware-side rules in each device's own `rules1` SOAP service.

#### How to use

1. **Start menu → Dibby Wemo Manager → Clear Wemo Firmware Rules** (NSIS installer adds this shortcut automatically; the portable `.exe` doesn't have a Start-menu entry but the tool lives next to it).
2. The script prints the device list it found in `C:\ProgramData\DibbyWemoManager\devices.json`.
3. Type `yes` to confirm. Anything else cancels.
4. The script iterates each device, calls `FetchRules` + per-rule `DeleteRule` SOAP, and prints a summary:
   ```
   ── Summary ───────────────────────────────────────────────────────
     Devices processed:           33
     Devices cleared:             29
     Devices already empty:        2
     Devices on unsupported f/w:   2  (Lightswitch-3_0 / Dimmer V2)
     Total firmware rules wiped:  41
   ── ────────────────────────────────────────────────────────────────
   ```

#### Implementation

- `apps/desktop/tools/clear-wemo-rules/clear-wemo-rules.js` — main script. Uses the same `wemo-client.js` `fetchRules` + `deleteRule` SOAP path the Homebridge plugin uses.
- `apps/desktop/tools/clear-wemo-rules/Clear Wemo Rules.cmd` — Windows batch wrapper that invokes the bundled `node.exe` (under `<install>\resources\node.exe`) on the script and pauses on completion so the user can read the summary.
- `apps/desktop/tools/clear-wemo-rules/wemo-client.js` + `types.js` — vendored copies of the homebridge plugin lib files so the tool is self-contained.
- `apps/desktop/scripts/bundle-standalone.js` — extended to run `npm install --omit=dev` in the tool directory at build time so the tool ships with its own `node_modules`.
- `apps/desktop/resources/nsis-installer.nsh` — `customInstall` adds the Start menu shortcut; `customUnInstall` removes it.

Loads either the bare-array device-list shape (older Dibby builds) **or** `{devices: [...]}` (current desktop service shape) — same JSON file the desktop app and headless service both write.

#### Devices on the latest Lightswitch-3_0 / Dimmer V2 firmware

These don't expose `FetchRules` (the SOAP action returns "Action Not Supported"). The tool detects this and skips them with a clear log line — not a failure, just an explicit "this firmware doesn't have firmware rules to wipe."

### Affected packages

All monorepo packages bumped to **2.0.40** in unified versioning. Functional change is in the **Windows desktop installer only** — the npm Homebridge plugin, npm Node-RED package, Synology Docker image, Synology `.spk`, HA integration, macOS `.dmg`, and Linux packages get the version bump but no functional change beyond carrying forward v2.0.39's bounded Schedule-rule enforcement.

### Upgrade

- **Windows desktop:** download `Dibby Wemo Manager Setup 2.0.40.exe` from the release page → run installer → look in the Start menu for the new shortcut.
- All other surfaces: version bump only.

---

## [2.0.39] — 2026-06-08

### Refine: Schedule-rule enforcement is now bounded to a 5-minute window so humans can override

v2.0.38 introduced continuous enforcement that re-asserted a Schedule rule's intended state on every 10-second health poll **until the next Schedule entry for that device flipped the intention**. In practice that was too aggressive — if your 10:30 PM OFF rule fired and you walked back into the kitchen at 11 PM to turn the light on, the scheduler turned it off again 10 seconds later and kept doing so until the next morning's ON rule, treating every manual toggle as drift to be corrected.

**Fix in `packages/homebridge-plugin/lib/scheduler.js`:**

- New constant `ENFORCEMENT_WINDOW_MS = 5 * 60 * 1000`.
- `_pollDeviceHealth` now checks `Date.now() - intended.since < ENFORCEMENT_WINDOW_MS` before enforcing. Past the window, the `_intendedState` entry is deleted so it isn't even re-examined on subsequent polls.
- `_seedIntendedState` (called from `start()`) now records `since` as the **actual fire time today** (`dayStart + entry.targetSecs * 1000`), not `Date.now()`. Entries already past the 5-minute window aren't seeded at all. This means a Homebridge restart at 11 PM after a 10:30 PM OFF rule no longer re-engages enforcement — the restart respects whatever state the human chose during those 30 minutes.

**Behaviour now:**

- Schedule rule fires OFF at 22:30 → device(s) go off.
- 22:30 → 22:35 (the 5-min window): if a device drifts (SOAP failure, confirm-read race, fast manual flip), it's auto-corrected back to OFF every 10 s. Catches every realistic transient failure mode without entangling user choice.
- After 22:35: human authority. Anyone can flip the light back on and it stays on until they (or the next Schedule entry) change it. The scheduler stops watching that device until the next Schedule fire for it.

The window is intentionally generous enough to mop up real failures (a Wemo's radio asleep, an SOAP timeout, a confirm-read race) and tight enough that a deliberate human override is honored quickly. AlwaysOn rules retain their unbounded enforcement (turn-on is unambiguous).

### Affected packages

All monorepo packages bumped to **2.0.39** in unified versioning. Functional change is confined to **`homebridge-dibby-wemo@2.0.39`** — every other surface gets the version bump and the same carry-forward of v2.0.37's location-search hybrid response shape, v2.0.36's `DwmStore` atomic writes, and v2.0.35's Synology Docker root-fallback.

### Upgrade

- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.39` → restart Homebridge. Same `[enforce] ...` log lines on a drift inside the window, no log noise outside it.
- All other surfaces: version bump only.

---

## [2.0.38] — 2026-06-03

### Fix: scheduled OFF rules now self-enforce instead of giving up after one shot

**Symptom (user-reported):** A scheduled rule had Family Room Lamp + Kitchen Island Light as targets, both set to turn off at the same time each evening. Two nights in a row, the Lamp went off correctly but the Kitchen Island Light stayed on overnight.

**Root cause** in `packages/homebridge-plugin/lib/scheduler.js`: a Schedule rule fired a single `setBinaryState` per target device, confirmed once after 3 s, retried once if the confirm came back wrong, then **walked away forever**. Once `_fire()` returned and the device was marked in `_firedToday`, nothing in the scheduler ever compared the device's actual state to the rule's intended state again. Three real-world failure paths produced the user's exact symptom:

1. **Silent manual re-toggle.** Someone presses the physical Wemo button, taps it in Apple Home, or hits it from the Wemo app between the rule firing and morning. No enforcement layer = device stays in the wrong state.
2. **Past-retry failure.** The single retry happens 5 s after the initial confirm fails. If that retry also throws (network blip, switch radio asleep, SOAP timeout), the catch block swallows the error and the device is stuck.
3. **Confirm-read race.** Wemo's `GetBinaryState` occasionally reports stale state for a second or two after `SetBinaryState`. The current code accepts the confirm as authoritative and never re-checks.

**Fix — continuous state enforcement via the existing 10-second health poll, Schedule rules only:**

- **`_intendedState: Map<host:port, {on, ruleId, ruleName, since}>`** is populated by `_fire()` immediately for any entry flagged `isSchedule: true`. The map records the intended state up-front, so even if the SOAP call throws the scheduler still knows the correct target.
- **`_pollDeviceHealth()`** (which already polls every 10 s) now consults `_intendedState` after each `getBinaryState`. If the actual state differs from the intended state and the device is not under an AlwaysOn rule, it issues a corrective `setBinaryState` and emits a log line:

  ```
  [enforce] Kitchen Island Light was ON — turned OFF (rule "Evening Off") ✓
  ```

- **`_seedIntendedState()`** runs at scheduler start, walking today's past-fired Schedule entries in chronological order and seeding `_intendedState` with the most recent one per device. This catches drift that accumulated while Homebridge was stopped — restart Homebridge at 11 PM after a 9:30 PM OFF rule, and the very first health poll corrects any device a manual toggle (or silent SOAP failure) left in the wrong state.

**What's deliberately NOT enforced:**

- **Countdown rules** — they have a fluctuating intended state (on-for-N-minutes-then-off) and their own scheduler tick handles the off side.
- **Away rules** — randomised on/off by design; enforcement would defeat the purpose.
- **Trigger rules** — driven reactively by other devices' state changes.
- **AlwaysOn rules** — already enforced via the existing `alwaysOnSet` path; the new enforcement defers to it for any device that has an AlwaysOn target.

So **manual toggles on non-scheduled devices still work normally** — only devices that have a Schedule entry today get auto-corrected back to the rule's intended state.

### What this means in practice

- After a 9:30 PM OFF rule fires for two devices, if anyone turns one of them back on (physical button, Apple Home, Wemo app, voice command via Siri), the scheduler notices within 10 s and turns it off again. The "off" stays off until the next Schedule entry for that device flips the intended state (e.g. a 6 AM ON rule the next morning).
- If you want a device to stay ON after a Schedule OFF rule fired, the right answer is to disable or edit the rule — not to fight the system from another UI. The behaviour matches the user's stated expectation: *"it should always turn the device off."*

### Affected packages

All monorepo packages bumped to **2.0.38** in unified versioning. Functional change is **confined to `homebridge-dibby-wemo@2.0.38`**. The desktop apps, Synology Docker, Synology `.spk`, HA integration, and Node-RED package get the version bump only — they carry forward v2.0.37's location-search fix, v2.0.36's `DwmStore` atomic-write protection, and v2.0.35's Synology container root-fallback.

The desktop / standalone / HA schedulers have the same one-shot pattern in their own codepaths; if the same symptom shows up there, the fix pattern ports directly. Scoped to Homebridge for v2.0.38 to limit blast radius until the user confirms the fix works for the reported regression.

### Upgrade

- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.38` → restart Homebridge. Watch the log: when a Schedule rule fires you'll see `"Evening Off" → OFF (192.168.x.y) ✓` as before; if anything drifts later you'll see a follow-up `[enforce] DeviceName was ON — turned OFF (rule "Evening Off") ✓` from the next 10-second poll.
- All other surfaces: version bump only.

---

## [2.0.37] — 2026-06-03

### Fix: location search still appeared broken after v2.0.36 (client-cache regression)

v2.0.36 changed the `/location/search` response shape from a bare `Array` to `{ results, error, count }` so the UI could distinguish "no matches" from "upstream error." That change broke users whose browser had cached the v2.0.35 client code against the now-v2.0.36 server: the old client called `if (!results.length)` on the response object — `length` is `undefined` on a plain object — so the autocomplete dropdown was always hidden and search appeared dead, identical to the original v2.0.35 bug.

Two fixes:

1. **Backwards-compatible hybrid response** — `homebridge-ui/server.js` now returns an `Array` (which is what every cached client expects when reading `.length`), with `.error` and `.count` attached as bonus enumerable properties. Both old cached clients and new clients work; new clients still get the actionable error message via `resp.error`.

2. **Permanent cache-busting on the script tag** — `homebridge-ui/public/index.html` no longer hard-codes `<script src="index.js">`. It now `document.write`s the tag with `?cb=<Date.now()>` so every fresh open of the Settings panel pulls the latest `index.js` even when the browser would otherwise re-use a stale copy from before the most recent plugin upgrade. Homebridge UI iframes share the browser cache and `@homebridge/plugin-ui-utils`' static-file server sends no cache-control header — without this guard, any future response-shape change between versions would silently break the UI for users who left the Settings tab open across the upgrade.

### Affected packages

All monorepo packages bumped to **2.0.37** in unified versioning. Functional changes are confined to **`homebridge-dibby-wemo@2.0.37`**; carries forward v2.0.36's atomic `DwmStore` writes + rolling `.bak` + empty-write guard (the actual data-loss fix), plus v2.0.35's Synology Docker root-fallback.

### Upgrade

- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.37` → restart Homebridge. The cache-busting now ships in the bundle, so no manual browser hard-refresh should be needed; opening the Settings panel after the restart always loads fresh JS.
- All other surfaces: version bump only.

---

## [2.0.36] — 2026-05-28

### Critical: stop the Homebridge plugin from destroying DWM rules + device list on upgrade

User-reported regression on the Homebridge plugin: after upgrading the npm package via the Homebridge UI, DWM rules and the cached device list **disappear**. Investigation traced this to two compounding bugs in `packages/homebridge-plugin/lib/store.js`:

1. **Silent catch-all in `_load()`** — every read error (file locked, partial write, EBUSY, JSON parse failure) was caught and turned into `{ ...DEFAULTS }`. The very next mutation (`saveHeartbeat`, a device toggle, a discovery merge — anything) then persisted those empty defaults via `_save()`, **permanently overwriting the user's real data**.

2. **Non-atomic writes** — `_save()` was a single `fs.writeFileSync()`. The Homebridge plugin runtime and the Settings UI process both have their own `DwmStore` instance pointing at the same file; on slow disks (NAS, SD card) or under any concurrent-write race, a reader can catch the file mid-write, get partial JSON, fall into the silent catch-all above, and trigger the destruction cycle.

The fix in `lib/store.js` is comprehensive:

- **`_load()` distinguishes the three failure modes:**
  - File missing (`ENOENT`) → return `DEFAULTS`, mark safe to save.
  - File unreadable (`EACCES`, `EBUSY`, `EIO`, etc.) → return `DEFAULTS` **but flip `_safeToSave = false`**, refusing all subsequent writes until a clean read succeeds. Cannot destroy data we couldn't read.
  - File present but unparseable JSON → quarantine it to `dibby-wemo.json.corrupt-<unix-ts>`, attempt recovery from `dibby-wemo.json.bak`, and only fall through to `DEFAULTS` if both are bad.

- **Atomic `_save()` via tmp + rename:** writes to `dibby-wemo.json.tmp`, then `fs.renameSync()` over the target. Renames are atomic on POSIX and effectively-atomic on NTFS, so readers never see a partially-written file again.

- **`.bak` rolling backup:** the previous-good file is `copyFileSync`'d to `dibby-wemo.json.bak` immediately before every successful rename. One rename away from disaster recovery if the main file ever gets damaged.

- **Empty-write guard:** if the in-memory state about to be persisted is empty (no devices, no rules, no location, no groups, no order) **and** the last known on-disk state was non-empty, the save is **blocked** with a console warning naming the most likely cause (plugin-runtime/UI-server process race). This is the single most effective protection against the original symptom.

### Fix: location search in Homebridge plugin Settings panel

Two bugs in `homebridge-ui/server.js`'s `/location/search` handler:

1. User-Agent header had a typo (`homebrige-dibby-wemo`) which Nominatim's anti-abuse filter occasionally rejected, causing the search to fail silently.
2. Errors were swallowed by `catch { return []; }`, so the user saw an apparently-dead input field with no clue why nothing appeared.

Fix:
- Corrected User-Agent to `homebridge-dibby-wemo (+https://github.com/K0rb3nD4ll4S/dibby-wemo-manager)` per Nominatim's usage policy (must identify the application + contact URL).
- Response shape changed from a bare array to `{ results, error, count }` so the UI can distinguish "no matches" from "upstream error" and show specific, actionable error messages (no internet on the Homebridge host, rate-limited by Nominatim, timeout, etc.). The UI client (`public/index.js`) now normalises both shapes for backwards compatibility.

### Recovery for already-affected users

Users whose Homebridge `dibby-wemo.json` was already overwritten by the v2.0.35-and-earlier bug have no in-place recovery — the wipe happens silently and there's no pre-fix `.bak` to roll back to. Workaround:

- If you have a Homebridge config backup (Homebridge UI → Backup), restore it; the backup ZIP includes the storage directory and therefore the pre-wipe `dibby-wemo.json`.
- Otherwise, recreate rules manually one time; from v2.0.36 onward they're protected by atomic writes + the `.bak` rolling backup, so this cannot happen again.

### Affected packages

All monorepo packages bumped to **2.0.36** in unified versioning. Functional changes are isolated to **`homebridge-dibby-wemo@2.0.36`**; the desktop apps, Synology `.spk`, Docker image, Node-RED package, MQTT bridge, and HA integration get the version bump but no functional change beyond carrying forward v2.0.35's Synology root-fallback fix.

### Upgrade

- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.36` → restart Homebridge. Watch the log for `[Store] Loaded from /var/lib/homebridge/dibby-wemo.json — N device(s), M DWM rule(s).` to confirm.
- All other surfaces: version bump only; upgrade at your convenience.

---

## [2.0.35] — 2026-05-18

### Fix: Synology / Docker "EACCES: permission denied, open '/data/dibby-wemo.json'" on Scan

Synology DSM bind-mounted shared folders frequently carry filesystem ACLs that block the container from `chown`-ing the mount — even as root. The previous `docker/entrypoint.sh` chowned `/data` best-effort, swallowed the failure (`2>/dev/null || true`), then unconditionally dropped privileges to the unprivileged `dibby` user via `su-exec`. When the chown silently failed, `/data` stayed root-owned and the dropped-privilege Node process couldn't write — so the first **Scan** (which persists discovered devices to `/data/dibby-wemo.json`) failed with:

```
Scan failed: {"error":"EACCES: permission denied, open '/data/dibby-wemo.json'"}
```

The container also appeared to "not create the data folder" because the write that would have populated it never succeeded.

Fix — `docker/entrypoint.sh` now **probes writability and falls back to root**:

1. `mkdir -p $DATA_DIR` (handles Docker auto-creating a bind-mount source as root).
2. Remap the `dibby` user to `PUID`/`PGID` and best-effort `chown` as before.
3. **Probe**: attempt `touch $DATA_DIR/.dwm-write-test` as `dibby`. If it works, run unprivileged as before.
4. If the probe fails, retry after a `chmod`, then re-probe. If still not writable (the Synology ACL case), **run the server as root** so the data store is always writable — a working root-owned install beats a "secure" install that can't save anything.
5. Final guard: if even root can't write `$DATA_DIR`, exit with a clear message pointing at the host bind-mount permissions instead of letting Node throw the cryptic EACCES at Scan time.

`docker/synology-compose.yml` updated with: a clearer instruction to pre-create the `data` folder in File Station (so it's owned by your DSM user), a sixth step confirming where settings persist, and a "Permissions note" explaining the root fallback.

No change to the unprivileged path on normal Linux Docker hosts — the probe passes there and the server still runs as `dibby`.

### Affected packages

All monorepo packages bumped to **2.0.35** in unified versioning. The fix is in the **Docker image entrypoint only** (rebuilt by CI on this tag); desktop installers, npm packages, and the HA integration are unchanged beyond the version bump and carry forward v2.0.34's hand-authored icon.

### Upgrade

- **Synology Container Manager / Docker:** Project → `dibby-wemo` → **Stop → Build → Start** to pull the rebuilt `:latest` (now 2.0.35). After it restarts, click **Scan** — discovery now persists to `/volume1/docker/dibby-wemo/data/dibby-wemo.json` without the EACCES error.
- All other surfaces: version bump only; upgrade at your convenience.

---

## [2.0.34] — 2026-05-18

### Visual: hand-authored `icon.ico` replaces the auto-generated 7G_green_bg variant

User-supplied `icon.ico` (432 KB, RGBA, **nine** embedded layers — 16 / 24 / 32 / 48 / 64 / 72 / 96 / 128 / 256) is now the canonical Dibby Wemo mark on every surface. SHA-256 of the in-repo copy at `apps/desktop/resources/icon.ico` matches the source byte-for-byte (`1174600D…E107`), so the embedded artwork is exactly the user-authored mark — no Pillow downscale, no LANCZOS resample, no alpha conversion.

Every other surface (HA card, Synology `.spk` 72 + 256, Homebridge / Node-RED / MQTT-bridge npm tarballs, Docker bundle, `brand/`) is rendered from the .ico's own 256 × 256 layer extracted via Pillow, so the cross-platform PNGs are pixel-identical to what Windows displays.

| Path | Source |
|------|--------|
| `apps/desktop/resources/icon.ico` | **direct binary copy** of user's hand-authored `icon.ico` — all 9 layers preserved |
| `apps/desktop/resources/icon.png` (512 × 512) | 256-layer upscale via LANCZOS |
| Everything else (10 PNG paths across HA / SPK / Homebridge / Node-RED / MQTT) | derived from the .ico's own 256 × 256 layer |

Verified via `Get-FileHash`: the 432 254-byte `.ico` on disk and the source on Desktop have identical SHA-256, and the built `dist\win-unpacked\Dibby Wemo Manager.exe` was `rcedit`-stamped with this exact .ico (electron-builder `win.icon` field). The installer .exe, the portable .exe, the installed app .exe, and the desktop + Start-menu shortcuts NSIS creates all derive from this one source.

### Affected packages

All monorepo packages bumped to **2.0.34** in unified versioning. Pure asset refresh — no functional code changes; carries forward the v2.0.33 desktop-launch fix (critical missing `core/paths.js` bundle), voice commands, sticky devices, manual add, Synology support, etc.

### Upgrade

- **Desktop (Windows):** download `Dibby Wemo Manager Setup 2.0.34.exe` (NSIS) or `Dibby Wemo Manager 2.0.34.exe` (portable). **Uninstall the prior version first** so Windows refreshes its icon cache for this app — Windows caches icons aggressively by file path.
- **macOS:** download the new `.dmg` from this release.
- **Docker / Synology Container Manager:** Stop → Build → Start (`:latest` now points at 2.0.34).
- **Synology `.spk`:** download the new `.spk` for your arch → Package Center → Manual Install.
- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.34` then restart Homebridge.
- **Node-RED:** `npm install -g node-red-contrib-dibby-wemo@2.0.34`.
- **HACS:** ⋮ → Reload data → Dibby Wemo → ⋮ → Redownload → 2.0.34 → restart HA.

---

## [2.0.33] — 2026-05-17

### Critical fix: desktop app now actually launches its window (regression dating back to v2.0.30)

A latent build-pipeline bug was silently shipping every desktop installer since **v2.0.30** without the `out/main/core/paths.js` module. The bug was: `electron.vite.config.js`'s `rollupOptions.input` map listed `core/sun` and `core/types` as explicit entries, but **omitted `core/paths`**. Five main-process files (`ipc/homekit.ipc.js`, `ipc/rules.ipc.js`, `scheduler-standalone.js`, `service-manager.js`, `service-manager-sync.js`) do a runtime `require('./core/paths')`; without an explicit input entry the tree-shaker dropped the module from the bundled output.

Symptom: install completed cleanly, the .exe ran (Task Manager showed three Electron processes), but the **main window never appeared**. Root cause was an unhandled rejection during IPC handler registration:

```
[main] unhandledRejection: Error: Cannot find module '../core/paths'
Require stack:
  - out/main/ipc/rules.ipc.js
  - out/main/index.js
```

The BrowserWindow was constructed with `show: false` waiting on the `ready-to-show` event that the crashed renderer never fired, so the window stayed hidden forever.

Fix — single line in `apps/desktop/electron.vite.config.js`:

```js
'core/paths':           resolve(__dirname, 'src/main/core/paths.js'),
```

Verified end-to-end: `npm run dev` produces a window titled "Dibby Wemo Manager" with a valid `MainWindowHandle`; freshly-built `Dibby Wemo Manager Setup 2.0.33.exe` installs and launches on Windows 11 with no further intervention.

This bug affected **every** desktop installer published since v2.0.30 — Windows / macOS / Linux. Users on v2.0.30 or v2.0.31 should upgrade to v2.0.33.

### Visual: switched icon to the 7G `green_bg` variant for full-canvas fill

Earlier feedback was that the icon looked smaller than its neighbours on the Windows desktop. Investigation showed the previously-chosen `7G_dark_flat` variant only fills **42 %** of its 1024 × 1024 canvas — the bright badge sits in the middle, the surrounding 58 % is transparent / dark padding. Three variants in the icon pack fill the entire canvas:

| Variant | Visible badge | Vertical fill |
|---------|---------------|---------------|
| `7G_dark_flat` *(was)*  | 628 × 432 | **42 %** |
| `7G_glow_black`         | 628 × 432 | 42 % |
| `7G_soft_glow`          | 632 × 436 | 43 % |
| **`7G_green_bg`** *(now)* | 1020 × 1020 | **100 %** |
| `7G_purple_bg`          | 1020 × 1020 | 100 % |
| `7G_white_bg`           | 1020 × 1020 | 100 % |

`7G_green_bg` was picked — same artwork, on the lime-green background that matches the "wemo" wordmark already inside the badge. Every sized PNG (16, 24, 32, 48, 64, 72, 96, 128, 144, 192, 256, 512, 1024) and the multi-resolution `icon.ico` (16/24/32/48/64/128/256 layers) were regenerated from the 1024 × 1024 `green_bg` master via Pillow `LANCZOS`. Distributed to all 10 icon paths (desktop `.ico` + `.png`, HA + `brand/`, Synology `.spk` 72 × 72 + 256 × 256, Homebridge / Node-RED / MQTT bridge npm tarballs, Docker bundle).

Optical weight now matches every other Windows desktop icon (WinRAR, Git Bash, etc.).

### CI: Windows build auto-triggers on tag push + bundles real Node.exe + skips code-signing on the runner

Three workflow fixes from the v2.0.30 attempt that previously needed manual dispatch:

1. `.github/workflows/build-win.yml` now triggers on every `v*.*.*` tag push, the same way macOS / Docker / Synology workflows already did.
2. The job downloads the matching Node 20 LTS Windows x64 binary and places it at `apps/desktop/resources/node.exe` before `electron-builder` runs — needed so the headless `DibbyWemoService` ships with a real OpenSSL Node for HomeKit's chacha20-poly1305 cipher (Electron's BoringSSL doesn't expose it).
3. A PowerShell step strips the `build.win.signtoolOptions` block from `package.json` in place before `electron-builder` runs in CI — the real SRS IT PFX isn't on the runner and CLI overrides like `--config.win.certificateFile=""` don't take effect once `signtoolOptions` is set. CI produces an **unsigned** portable `.exe` + NSIS installer (Windows SmartScreen warns the first time the user runs it; the file works); locally-built releases keep the unmodified `package.json` and sign normally with the SRS IT cert.

### README — Quick Start updated

- Filenames bumped from `2.0.19` → `2.0.33` across every download example.
- New **"24/7 always-on host options"** subsection lists Synology (Docker + `.spk`), generic Linux Docker, Homebridge, and Home Assistant as alternatives to leaving a laptop running.
- "Headless 24/7 mode on Linux planned for v2.0.20" note removed — that functionality is delivered via the Synology / Docker path.

### Affected packages

All monorepo packages bumped to **2.0.33** in unified versioning. The desktop fix is in the **desktop installers only**; `homebridge-dibby-wemo@2.0.33` / `node-red-contrib-dibby-wemo@2.0.33` get the version bump + new icon but no functional change beyond that.

### Upgrade

- **Desktop (Windows / macOS / Linux):** **important** — upgrade from v2.0.30/v2.0.31 to v2.0.33 to actually be able to see the app window. Download the installer for your platform from the v2.0.33 release page once CI finishes attaching artifacts.
- **Synology Container Manager / Docker:** Stop → Build → Start (pulls `:latest`).
- **Synology `.spk`:** download the new `.spk` for your arch → Package Center → Manual Install.
- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.33` then restart Homebridge.
- **Node-RED:** `npm install -g node-red-contrib-dibby-wemo@2.0.33` then restart Node-RED.
- **HACS:** ⋮ → Reload data → Dibby Wemo → ⋮ → Redownload → 2.0.33 → restart HA.

---

## [2.0.31] — 2026-05-17

### Fix: Homebridge UI plugin tile now shows the 7G dark-flat icon

v2.0.30 shipped `icon.png` inside the npm tarball (verified via `npm pack --dry-run`), but Homebridge UI v5+ doesn't read images from the tarball. It looks for an explicit `icon` URL in the plugin's `package.json`, or falls back to the default house icon — which is what was rendering on every user's Plugins page.

Three fixes:

1. **`packages/homebridge-plugin/package.json`** — added a top-level `icon` field pointing to the raw-GitHub URL of the bundled `icon.png`:
   ```json
   "icon": "https://raw.githubusercontent.com/K0rb3nD4ll4S/dibby-wemo-manager/main/packages/homebridge-plugin/icon.png"
   ```
   Homebridge UI's plugin-tile renderer reads this field directly from the npm registry metadata, so the new icon appears on every user's Plugins page after the next plugin-metadata refresh.

2. **`displayName`** — set to `"Dibby Wemo"` so the plugin's friendly name on the tile says **Dibby Wemo** instead of the auto-derived **Homebridge Dibby Wemo**. Cleaner, matches the desktop / web / DSM / HA branding.

3. **`packages/homebridge-plugin/config.schema.json`** — `headerDisplay` now leads with the icon as a 96 px centred image plus the existing description text, so the settings dialog also shows the brand mark when users click into Configure.

### Affected packages
All monorepo packages bumped to **2.0.31** in unified versioning. Only `homebridge-dibby-wemo@2.0.31` ships functional metadata changes in this release; every other surface (desktop apps, Synology `.spk`, Docker image, HA integration, Node-RED, MQTT bridge) gets the version bump but already had the new icon from v2.0.30.

### Upgrade

- **Homebridge:** `npm install -g homebridge-dibby-wemo@2.0.31`, then in Homebridge UI: **Plugins → Search → Dibby Wemo** (or refresh the page) — the icon updates after the next metadata fetch from the npm registry. May take 1–2 minutes for the npm CDN + Homebridge UI cache to pick up the new metadata.
- Everything else: no action required for this release.

---

## [2.0.30] — 2026-05-17

### Visual: unified 7G-dark-flat icon across every surface

The Dibby Wemo Manager artwork is refreshed to the new **7G dark flat** mark, and the same image is now distributed across every shipping surface so the brand looks consistent in Windows taskbars, DSM Package Center, Home Assistant entity cards, Homebridge plugin listings, npm package pages, and the in-app web UI alike.

**Where the new icon lives:**

| Path | Format / size | Used by |
|------|---------------|---------|
| `apps/desktop/resources/icon.ico` | Multi-resolution `.ico` | Windows installer, taskbar, exe-resource |
| `apps/desktop/resources/icon.png` | 512×512 PNG | Linux .deb / .rpm / AppImage, web UI fallback, Docker container `icon.png`, Homebridge plugin icon |
| `custom_components/dibby_wemo/icon.png` | 256×256 PNG | HACS card + HA Integrations tile |
| `custom_components/dibby_wemo/brand/icon.png` | 256×256 PNG | HA brands repo source-of-truth |
| `custom_components/dibby_wemo/brand/logo.png` | 256×256 PNG | HA brands repo wordmark slot |
| `packages/synology-spk/PACKAGE_ICON.PNG` | 72×72 PNG (downscaled via Pillow) | DSM Package Center thumbnail in the package list |
| `packages/synology-spk/PACKAGE_ICON_256.PNG` | 256×256 PNG | DSM Package Center full-size install screen |
| `packages/homebridge-plugin/icon.png` | 256×256 PNG | npm package page header + Homebridge UI plugin marketplace |
| `packages/node-red-contrib/icon.png` | 256×256 PNG | npm package page header + Node-RED palette browser |
| `packages/mqtt-bridge/icon.png` | 256×256 PNG | bundled in Docker image, available for future container-registry display |

**Why one image everywhere?** Verified via `npm pack --dry-run` for both `homebridge-dibby-wemo` and `node-red-contrib-dibby-wemo` that `icon.png` is now in the published tarballs (29 KB each). Verified via the Synology SPK build that both `PACKAGE_ICON.PNG` and `PACKAGE_ICON_256.PNG` are pulled into the archive at build time. The Docker image's `COPY apps/desktop/resources/icon.png ./icon.png` step picks up the new file automatically — no Dockerfile change needed.

The 7G dark flat artwork is sourced from the user-supplied complete icon pack at `Dibby_Wemo_Manager_7G_COMPLETE_ICON_PACK/7G_dark_flat/`; every output size is taken from that pack except the 72×72 SPK thumb which is downscaled from the pack's 128×128 PNG via Pillow's LANCZOS filter.

### Affected packages
All monorepo packages bumped to **2.0.30** in unified versioning. No code changes in this release — only branding assets and plugin README headers (which now show the icon at the top via `<p align="center"><img src="icon.png" width="128"/></p>` so npm and the GitHub repo display it).

---

## [2.0.29] — 2026-05-13

### Feature: voice commands + per-device voice training

Voice control of every Wemo from two surfaces — the **Windows desktop app** and the **Docker / Synology web UI** (which also runs on the macOS / Linux desktop builds via Electron's renderer). One shared library, two thin wrappers, zero new native dependencies.

#### How it works

- New `apps/desktop/resources/web/voice-commands.js` — a self-contained, vendor-cloud-aware speech-recognition wrapper plus a pure-function intent parser. Bound to `window.WemoVoice` so both vanilla-JS and React callers can use it. Mirrored at `apps/desktop/src/renderer/src/voice/voice-commands.js` so Vite can inline it under the desktop renderer's strict CSP.
- New `apps/desktop/resources/web/voice-trainer.js` — small "record one phrase, return the transcript" helper used by both UI surfaces for per-device alias training.
- Built on the browser-native `webkitSpeechRecognition` / `SpeechRecognition` API. Works in Electron's Chromium renderer, plus Chrome / Edge / Safari when accessing the web UI from any device on the LAN (phone, tablet, laptop). Firefox shows a disabled-mic button with a "try Chrome/Edge/Safari" tooltip — no broken state.

#### Command grammar

Continuous-listen mode picks up everything in the room, but only acts when a sentence starts with the wake-word **"dibby"** (configurable, can be disabled for push-to-talk only). Supported intents:

| Spoken | Action |
|--------|--------|
| `dibby turn on <device>` | Set device on |
| `dibby turn off <device>` | Set device off |
| `dibby toggle <device>` | Flip current state |
| `dibby <device> on` / `<device> off` | Terse form |
| `dibby turn everything on` / `all off` | Bulk command across every cached device |

Device names are matched **fuzzily** using Levenshtein distance against `device.friendlyName`. "deck mister" matches "Deck Master" (score ≤ 0.4 = at least 60% similar); "purple unicorn" doesn't and surfaces a "didn't recognise" toast instead of firing the wrong device.

#### Per-device voice training (the accent-friendly part)

Fuzzy matching against `friendlyName` is great for typos but breaks down on accents, nicknames, and language mismatches. Each device now carries an optional `voiceAliases: string[]` field that competes with `friendlyName` on equal footing during matching, and which the user populates by **recording phrases**:

1. Open the device detail panel (desktop) or expand the device card (web UI).
2. Click **🎤 add voice name**.
3. Say the phrase you'll use ("deck light", "outside switch", whatever feels natural).
4. The speech engine transcribes your recording and shows it back: *"Heard: deck light — save?"*.
5. On save the transcript is appended to that device's `voiceAliases` list. Multiple aliases per device are supported — Deck Master Switch can answer to "deck", "deck light", **and** "outside light" simultaneously.

The key insight: the alias is **whatever the user's own STT engine actually returned** when they spoke the phrase. If Chrome transcribes a user's "deck light" as "tek light" because of their accent, the stored alias becomes "tek light" — and that's exactly what comes back at command time. The alias and the live command go through the **same** transcription pipeline, so they match cleanly even when the literal English doesn't.

Algorithm at command time:

```
candidates = []
for each device:
    push { device, score = lev(spoken, friendlyName) / friendlyName.length, source: 'name' }
    for each alias in device.voiceAliases:
        push { device, score = lev(spoken, alias) / alias.length, source: 'alias' }
best = min(candidates)
if best.score <= 0.4: dispatch(best.device)   // 60%+ similar
else:                 toast("Didn't recognise that device")
```

Aliases compete with the friendlyName on equal footing — a perfect alias match wins over a slightly-fuzzy name and vice-versa. Aliases survive plugin upgrades because they're stored in the same `<homebridge-storage>/dibby-wemo.json` (Homebridge) or `<user-data>/devices.json` (desktop) file as the device list itself.

#### Backend additions

- `docker/server.js` — new endpoints:
  - `GET    /api/devices/<host>/<port>/voice-aliases` → list
  - `POST   /api/devices/<host>/<port>/voice-aliases` body `{alias}` → add
  - `DELETE /api/devices/<host>/<port>/voice-aliases/<index>` → remove
  - Plus explicit static handlers for `/voice-commands.js` and `/voice-trainer.js` with the right `Content-Type: application/javascript` header (the fallback `index.html` route would otherwise mis-serve them as HTML).
- `apps/desktop/src/main/ipc/devices.ipc.js` — new IPC channels `get-voice-aliases`, `add-voice-alias`, `remove-voice-alias` calling the existing `DwmStore.saveDevices` (additive — the `voiceAliases` field rides along with the rest of the device record).
- `apps/desktop/src/preload/index.js` — bridge exposes `window.wemoAPI.{getVoiceAliases, addVoiceAlias, removeVoiceAlias}`.

#### Privacy

The first time voice is enabled on a given browser/device, a one-shot modal explains the data flow:

> Chrome and Edge stream audio to Google/Microsoft to transcribe it; Safari uses on-device recognition. Dibby Wemo never records, stores, or transmits audio itself.

Dismissal is persisted in `localStorage` under `dwm.voice.privacyAck` so the modal shows once per browser, not once per session. `apps/desktop/resources/help.html` gains a permanent **Voice Commands & Privacy** section with the same disclosure plus the full command grammar and training walkthrough.

#### UI additions

- **Web UI** (`apps/desktop/resources/web/index.html`):
  - 🎤 toggle button in the Devices toolbar next to **⟳ Scan**
  - Live transcript bubble below the toolbar while listening (interim in muted text, final in white with a ✓)
  - Per-card voice-alias chips with × delete + "🎤 add voice name" link
  - Pulsing red glow on the toolbar button while the engine is active
- **Electron desktop renderer**:
  - `apps/desktop/src/renderer/src/components/voice/VoiceCommandButton.jsx` — Sidebar mic button with the same pulse animation
  - `apps/desktop/src/renderer/src/components/voice/VoiceAliasManager.jsx` — embedded in DeviceInfoTab; lists chips, records new aliases, deletes existing ones
- **Help doc** (`apps/desktop/resources/help.html`) — new section walks through enabling voice, the command grammar, training aliases, and the privacy story
- **README.md** — short blurb under Desktop App + Synology install sections

#### What's NOT in this release (deferred)

- Offline STT (whisper.cpp / vosk) — would bloat the install by 100+ MB. Re-evaluate when users specifically ask for offline mode.
- Voice authoring of DWM rules ("dibby schedule deck master on at sunset") — defer to a future release.
- Hardware-style always-on wake-word detection (Porcupine / picovoice) — needs a paid licence or a 30 MB tflite model. The current soft wake-word ("dibby ..." prefix) is a reasonable compromise.
- Voice in the Homebridge plugin UI — separate iframe sandbox + different mic-permission model. Add later if requested.

### Affected packages
All monorepo packages bumped to **2.0.29** in unified versioning. Functional changes ship in the desktop app and the Docker image / Synology `.spk`; npm Homebridge + Node-RED packages get the version bump but no functional change.

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
