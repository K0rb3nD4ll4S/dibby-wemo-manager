# Bundled node binaries for the headless scheduler

The `DibbyWemoScheduler` service / `com.srsit.dibbywemoscheduler` LaunchDaemon
spawns a Node.js process to run `scheduler-standalone.js`. Electron's bundled
Node uses BoringSSL which does **not** expose `chacha20-poly1305` in a way
`hap-nodejs` (the HomeKit bridge dep) accepts, so we ship a real Node binary
per platform.

## Required files (each ~70–95 MB)

| File | Platform | Build / source |
|---|---|---|
| `node.exe` | Windows x64 | Download from https://nodejs.org/dist/latest-v20.x/win-x64/node.exe |
| `node-macos` | macOS universal (x64 + arm64) | Universal lipo'd binary built from nodejs.org pkg installs |
| `node-linux` | Linux x64 | Download from https://nodejs.org/dist/latest-v20.x/node-v20.x.x-linux-x64.tar.xz, extract `bin/node` |

These files are **gitignored** (each is ~70-95 MB; trade-off vs git LFS). The
CI build workflow (`.github/workflows/build.yml`, when set up) downloads them
on demand.

## Local dev: copy from system Node

If you have Node 20.x installed on your system:

```bash
# Windows (cmd.exe)
copy "C:\Program Files\nodejs\node.exe" apps\desktop\resources\node.exe

# macOS
cp /usr/local/bin/node apps/desktop/resources/node-macos
# (or /opt/homebrew/bin/node on Apple Silicon; lipo to make universal if needed)

# Linux
cp /usr/bin/node apps/desktop/resources/node-linux
```

If the binary is missing, the service install falls back to `/usr/bin/node`
(or `node.exe` on Windows PATH) at runtime — the service still works, it
just relies on the user having Node installed.

## Why not just bundle the source?

Node.js source is ~50 MB compressed and would need a C++ compiler in the
build pipeline. Pre-built binaries are smaller, signed by Node.js
Foundation, and well-tested.
