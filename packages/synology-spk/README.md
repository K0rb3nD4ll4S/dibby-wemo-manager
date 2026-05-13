# Synology DSM 7 `.spk` packaging

This directory builds installable `.spk` packages for Synology Package Center on DSM 7+. Each `.spk` is a fully self-contained installer that bundles:

- Node 20 LTS binary for the target arch
- `docker/server.js` + the `homebridge-plugin/lib/` JS bundle (same code as the container image)
- DSM 7 lifecycle scripts (start/stop/upgrade/uninstall)
- Web UI from `apps/desktop/resources/web/`

The same scheduler, store, and HomeKit bridge that run in the Docker image run here — packaging is the only difference.

## Layout

```
packages/synology-spk/
├── INFO.tmpl                       — metadata template (filled per arch)
├── PACKAGE_ICON.PNG                — 72×72 (optional override; defaults to apps/desktop/resources/icon.png)
├── PACKAGE_ICON_256.PNG            — 256×256 (optional)
├── conf/
│   ├── resource                    — data-share + port config consumed by Package Center
│   └── privilege                   — run-as-user (DSM 7 mandatory; not root)
├── scripts/
│   ├── start-stop-status           — main daemon control (start / stop / restart / status / log)
│   ├── postinst                    — fresh-install setup
│   ├── postuninst                  — cleanup (preserves data unless PURGE)
│   ├── preupgrade  / postupgrade   — graceful version swap
├── ui/config                       — registers the web-UI shortcut in DSM's app launcher
└── build-spk.sh                    — per-arch builder
```

## Supported architectures

DSM 7 binary-compatible arch names — `build-spk.sh` defaults to all of them:

| DSM arch  | CPU family                 | Example NAS models                                       |
|-----------|----------------------------|----------------------------------------------------------|
| apollolake| Intel Celeron J3455        | DS418play, DS918+, DS1019+                               |
| geminilake| Intel Celeron J4115        | DS220+, DS420+, DS720+, DS920+, DS1520+                  |
| denverton | Intel Atom C3538           | DS1819+, DS3018xs, RS1619xs+                             |
| broadwell | Intel Xeon                 | DS3617xs, RS3617xs, RS18017xs+                           |
| rtd1296   | Realtek RTD1296 (aarch64)  | DS124, DS223j, DS223, DS423                              |

armv7 is intentionally **not** built — DSM 7 dropped most armv7 models.

## Build

From the repo root:

```bash
./packages/synology-spk/build-spk.sh
```

Outputs land in `packages/synology-spk/dist/`:

```
dibby-wemo-manager_apollolake_2.0.27.spk
dibby-wemo-manager_geminilake_2.0.27.spk
dibby-wemo-manager_denverton_2.0.27.spk
dibby-wemo-manager_broadwell_2.0.27.spk
dibby-wemo-manager_rtd1296_2.0.27.spk
```

Build a single arch only:

```bash
ARCHES="geminilake" ./packages/synology-spk/build-spk.sh
```

## Install on DSM 7

1. Download the `.spk` matching your NAS arch from the GitHub release.
2. **Package Center → ⋮ → Manual Install**.
3. Upload the `.spk` file → Next → Apply.
4. After install, open the package and click the URL — the Dibby Wemo web UI loads on port `3456`.

Data persists at `/volume1/@appstore/dibby-wemo-manager/data/`. Uninstalling preserves it unless you tick "purge data".

## How does this relate to the Docker image?

The Docker image (`ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager`) is the recommended path on Synology because it auto-updates, runs in Container Manager, and ships as a single multi-arch image. The `.spk` exists for users who prefer a native Package Center install or whose NAS can't run containers (very old models). Both deploy the **same** JS bundle.
