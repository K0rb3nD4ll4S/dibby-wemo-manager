'use strict';

/**
 * Windows Service manager for the Dibby Wemo Scheduler.
 *
 * Uses node-windows to register/unregister a Windows service that:
 *  - Starts automatically at boot (no user login required)
 *  - Runs under LocalSystem account
 *  - Reads devices from C:\ProgramData\DibbyWemoManager\devices.json
 */

const path = require('path');
const fs   = require('fs');

const SERVICE_NAME = 'DibbyWemoScheduler';
const SERVICE_DESC = 'Dibby Wemo Scheduler — fires Wemo device rules on schedule (local, no cloud)';

// Persistent, writable location for the deployed scheduler script. node-windows
// creates a `daemon/` directory next to the script for winsw.exe + service XML,
// so the script MUST live somewhere the service-install user can write to.
// ProgramData is writable by anyone in BUILTIN\Users by default.
const DEPLOY_DIR     = path.join('C:\\ProgramData', 'DibbyWemoManager');
const DEPLOY_SCRIPT  = path.join(DEPLOY_DIR, 'scheduler-standalone.js');

/**
 * Copy the bundled scheduler-standalone.js (from inside the app package) into
 * a writable ProgramData location and return that path. node-windows uses the
 * script's directory for daemon/winsw.exe storage, and that dir must be:
 *   - writable by the user installing the service (no admin write to Program Files)
 *   - readable by LocalSystem when the service runs
 *   - NOT inside app.asar (asar is a read-only virtual filesystem → ENOTDIR)
 *
 * Re-copies on every call so service-restart picks up scheduler updates from
 * the latest installed version of Dibby.
 */
function deployScript() {
  // Source candidates, tried in order:
  //   1. extraResources copy at <resourcesPath>/scheduler-standalone.js  (packaged)
  //   2. asarUnpack copy at <resourcesPath>/app.asar.unpacked/out/main/scheduler-standalone.js (packaged)
  //   3. dev path next to this module                                    (dev only)
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'scheduler-standalone.js'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'scheduler-standalone.js'));
  }
  candidates.push(path.join(__dirname, 'scheduler-standalone.js'));

  let source = null;
  for (const c of candidates) {
    // For asar paths fs.existsSync returns true via Electron's transparent asar
    // shim, but we explicitly want a real on-disk path for the daemon dir.
    if (c.includes('.asar' + path.sep) || c.includes(path.sep + 'app.asar' + path.sep + 'out')) continue;
    try { if (fs.existsSync(c)) { source = c; break; } } catch { /* skip */ }
  }
  if (!source) throw new Error('Could not locate bundled scheduler-standalone.js to deploy');

  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  // Copy only if source is newer or destination missing (avoid unnecessary disk write)
  let needsCopy = true;
  try {
    const dstStat = fs.statSync(DEPLOY_SCRIPT);
    const srcStat = fs.statSync(source);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) needsCopy = false;
  } catch { /* dest missing → copy */ }
  if (needsCopy) fs.copyFileSync(source, DEPLOY_SCRIPT);

  return DEPLOY_SCRIPT;
}

// Path to the standalone scheduler script (works in both dev and packaged).
// In packaged builds this deploys the script into ProgramData so node-windows
// can write its daemon/ directory next to it.
function getScriptPath() {
  // Dev mode: src/main/scheduler-standalone.js sits next to this file
  const devPath = path.join(__dirname, 'scheduler-standalone.js');
  if (!__dirname.includes('.asar') && fs.existsSync(devPath)) return devPath;
  // Packaged: deploy a writable copy into ProgramData
  return deployScript();
}

/**
 * Path to a Node-capable executable for the service to run scheduler-standalone.js.
 *
 * We CANNOT use Electron-as-Node here, even though it would save ~90 MB:
 * Electron's bundled Node uses BoringSSL which does not expose the
 * `chacha20-poly1305` cipher in a way `hap-nodejs` recognises. Without that
 * cipher the HAP TLS handshake can't initialise and the bridge crashes at
 * startup with "The cipher 'chacha20-poly1305' is not supported".
 *
 * Strategy:
 *   - Ship a real node.exe in extraResources (`<resources>/node.exe`)
 *   - DEPLOY it into ProgramData (`<DEPLOY_DIR>/node.exe`) on every install
 *     so the service config references a STABLE path even when running from
 *     the portable .exe (whose resourcesPath lives in TEMP and vanishes when
 *     the app closes — without this copy the service would die at first reboot)
 *   - Cache the deployed copy: re-copy only if the source is newer
 */
function deployNodeExe() {
  const dst = path.join(DEPLOY_DIR, 'node.exe');
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'node.exe'));
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'node.exe'));
  candidates.push('C:\\Program Files\\nodejs\\node.exe');
  let src = null;
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { src = c; break; } } catch { /* skip */ }
  }
  if (!src) {
    // Last resort — defer to PATH lookup. Service may fail at runtime if
    // user has no system Node.
    return 'node.exe';
  }
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  let needsCopy = true;
  try {
    const dstStat = fs.statSync(dst);
    const srcStat = fs.statSync(src);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) needsCopy = false;
  } catch { /* dst missing → copy */ }
  if (needsCopy) {
    try { fs.copyFileSync(src, dst); _stage('deployNodeExe:copied:' + src); }
    catch (e) {
      // If the destination is locked (service running from a previous install),
      // we can still use whatever's already there — it's the same binary.
      _stage('deployNodeExe:copy-failed:' + e.message);
      if (!fs.existsSync(dst)) return src;  // fall back to source path
    }
  }
  return dst;
}

function getNodePath() {
  return deployNodeExe();
}

/**
 * Copy node-windows out of app.asar into a writable, real-on-disk location.
 *
 * Why: node-windows internally calls
 *   path.join(__dirname, '..', 'bin', 'elevate', 'elevate.cmd')
 * and spawns that path via child_process.exec. Electron's asar shim makes
 * `__dirname` look like a real path even when the package lives inside
 * `app.asar`, but child_process / cmd.exe / spawned processes do NOT
 * understand asar — they see the literal asar-internal path and fail with
 * an undefined error (visible to the user as
 * "A JavaScript error occurred in the main process: undefined: undefined").
 *
 * Copying the whole node-windows tree to a real directory and `require`ing
 * from there resolves __dirname to the on-disk copy, and every bundled
 * helper (elevate.cmd, winsw.exe, sudo.exe, wrapper.js) becomes spawnable.
 */
/**
 * Manual recursive copy. Uses fs.readdirSync + fs.copyFileSync because the
 * faster fs.cpSync uses fs.opendir internally, and opendir does NOT work on
 * paths inside an asar archive (whereas readdirSync DOES — Electron's asar
 * shim covers it). When deploying node-windows + its transitive deps, some
 * sources may live inside `app.asar` and we still need to copy them out.
 */
function _copyDirRecursive(src, dst) {
  let stat;
  try { stat = fs.statSync(src); } catch (e) { throw new Error(`copy src missing: ${src}: ${e.message}`); }
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); }
    catch (e) {
      // Some asar dirent reads return strings instead of Dirents — fall back
      const names = fs.readdirSync(src);
      entries = names.map((n) => ({ name: n, isDirectory: () => fs.statSync(path.join(src, n)).isDirectory() }));
    }
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) _copyDirRecursive(s, d);
      else fs.copyFileSync(s, d);
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/**
 * Locate a sibling package that node-windows depends on. In a hoisted
 * workspace install (which this monorepo uses), node-windows itself sits at
 * `<workspace>/node_modules/node-windows` and its deps (`xml`, `yargs`, …)
 * are also hoisted to `<workspace>/node_modules/<dep>` rather than nested
 * inside node-windows. When we copy node-windows out of the asar, those
 * sibling deps must come with it or the require chain breaks at runtime
 * with `Cannot find module 'xml'`.
 */
function _findSiblingPackage(name) {
  // Try real on-disk locations first (asar.unpacked, sibling node_modules,
  // dev fallbacks). Fall back to inside-asar paths last — fs.cpSync reads
  // transparently through Electron's asar shim, and the COPY destination is
  // a real ProgramData path, so an asar source still works as a copy source.
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', name));
    candidates.push(path.join(process.resourcesPath, '..', 'node_modules', name));
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'node_modules', name));
    // Nested node_modules locations (npm sometimes nests instead of hoisting
    // when there are version conflicts between siblings)
    for (const parent of ['yargs', 'cliui', 'string-width', 'wrap-ansi', 'node-windows']) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', parent, 'node_modules', name));
      candidates.push(path.join(process.resourcesPath, 'app.asar', 'node_modules', parent, 'node_modules', name));
    }
  }
  // Workspace-root hoist locations + nested fallbacks
  for (const root of [
    path.join(__dirname, '..', '..', '..', '..', 'node_modules'),
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'node_modules'),
  ]) {
    candidates.push(path.join(root, name));
    for (const parent of ['yargs', 'cliui', 'string-width', 'wrap-ansi', 'node-windows']) {
      candidates.push(path.join(root, parent, 'node_modules', name));
    }
  }
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch { /* skip */ }
  }
  return null;
}

function _readPkgJson(pkgDir) {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); }
  catch { return null; }
}

/**
 * Recursively deploy a package and all its transitive runtime dependencies
 * into the target node_modules dir. Handles the hoisted-workspace layout
 * where deps are siblings rather than nested. Idempotent and cycle-safe.
 */
function _deployPackageTree(rootName, dstNodeModules, visited) {
  if (visited.has(rootName)) return;
  visited.add(rootName);

  const src = _findSiblingPackage(rootName);
  if (!src) { _stage('deployNodeWindows:dep-missing:' + rootName); return; }

  const dst = path.join(dstNodeModules, rootName);
  if (!fs.existsSync(path.join(dst, 'package.json'))) {
    _copyDirRecursive(src, dst);
    _stage('deployNodeWindows:dep-copied:' + rootName);
  }

  const pkg = _readPkgJson(src);
  if (!pkg) return;
  // Walk runtime deps (NOT devDependencies, NOT optionalDependencies — keeps
  // the deployed tree minimal and avoids dragging in build-time tooling).
  for (const childName of Object.keys(pkg.dependencies || {})) {
    _deployPackageTree(childName, dstNodeModules, visited);
  }
}

function deployNodeWindows() {
  const nwSrc = _findSiblingPackage('node-windows');
  if (!nwSrc) throw new Error('Could not locate node-windows package to deploy (asar paths only).');

  const dst = path.join(DEPLOY_DIR, 'node-windows');
  if (!fs.existsSync(path.join(dst, 'package.json'))) {
    fs.mkdirSync(DEPLOY_DIR, { recursive: true });
    _copyDirRecursive(nwSrc, dst);
    _stage('deployNodeWindows:nw-copied');
  }

  // Walk the entire dep tree of node-windows (xml, yargs, and all of yargs'
  // transitive deps like y18n, cliui, escalade, get-caller-file, …). Without
  // this, the daemon wrapper.js fails at runtime with "Cannot find module y18n"
  // and the Windows service immediately terminates with Error 1067.
  const dstNodeModules = path.join(dst, 'node_modules');
  fs.mkdirSync(dstNodeModules, { recursive: true });
  const nwPkg = _readPkgJson(nwSrc);
  const visited = new Set(['node-windows']); // node-windows itself is handled at top of dst
  for (const depName of Object.keys(nwPkg?.dependencies || {})) {
    _deployPackageTree(depName, dstNodeModules, visited);
  }

  return dst;
}

function makeService() {
  const nwPath = deployNodeWindows();
  // Bypass any cached require so a stale asar-rooted instance can't sneak in
  delete require.cache[require.resolve(nwPath)];
  const { Service } = require(nwPath);
  return new Service({
    name:        SERVICE_NAME,
    description: SERVICE_DESC,
    script:      getScriptPath(),
    nodeOptions: [],
    execPath:    getNodePath(),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect whether we're running from the portable .exe (extracted to a
 * temp directory that vanishes when the app closes). Portable paths are
 * unstable, so installing a Windows service that references them breaks the
 * moment the user closes the portable. Refuse the install up-front rather
 * than letting node-windows write a service config full of stale paths.
 */
function isPortable() {
  // electron-builder sets PORTABLE_EXECUTABLE_DIR; also detect by execPath living in TEMP.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  try {
    const tmp = (process.env.TEMP || process.env.TMP || '').toLowerCase();
    if (tmp && process.execPath.toLowerCase().startsWith(tmp)) return true;
  } catch { /* ignore */ }
  return false;
}

// Stage tracker so a hung install reports back exactly where it died.
let _installLastStage = 'idle';
function _stage(s) {
  _installLastStage = s;
  try {
    const logPath = path.join('C:\\ProgramData', 'DibbyWemoManager', 'service-install.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${s}\n`);
  } catch { /* non-critical */ }
  console.log(`[service-install] ${s}`);
}

/** Install and start the Windows service. Returns a Promise. */
function installService() {
  return new Promise((resolve, reject) => {
    _stage('install:start');
    // Portable mode is now supported: every binary the service needs
    // (scheduler-standalone.js, node-windows, node.exe) is copied to the
    // STABLE C:\ProgramData\DibbyWemoManager\ tree on each install. Once
    // those copies exist, the service survives portable closing and reboots.
    // The portable's TEMP extraction dir is irrelevant to the running service.

    let settled = false;
    const safeReject = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const msg = e?.message || String(e || 'service install failed');
      _stage('install:reject:' + msg);
      reject(new Error(msg + ` (last stage: ${_installLastStage})`));
    };
    const safeResolve = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      _stage('install:resolve:' + (v?.msg || 'ok'));
      resolve(v);
    };

    // 45 s hard timeout: if node-windows hangs (async throw in a callback, AV
    // blocking winsw.exe, UAC prompt dismissed, etc.) we fail loudly with a
    // useful message instead of leaving the IPC hung forever.
    const timeoutId = setTimeout(() => {
      safeReject(new Error(
        'service install timed out after 45 s — likely causes: UAC prompt was dismissed, ' +
        'Windows Defender blocked winsw.exe, or node-windows threw inside an async callback. ' +
        'Check C:\\ProgramData\\DibbyWemoManager\\service-install.log for the last stage reached.'
      ));
    }, 45_000);

    // Briefly hook process-level uncaught errors so we can blame them on this
    // install attempt instead of letting them silently swallow.
    const onUncaught = (err) => safeReject(err instanceof Error ? err : new Error('uncaught: ' + String(err)));
    const onRejected = (reason) => safeReject(reason instanceof Error ? reason : new Error('unhandled rejection: ' + String(reason)));
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejected);
    const detachProcessHooks = () => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejected);
    };

    try {
      _stage('makeService:begin');
      const svc = makeService();
      _stage('makeService:done');

      svc.on('install', () => {
        _stage('event:install');
        try { svc.start(); _stage('svc.start:called'); } catch (e) { _stage('svc.start:err:' + e.message); }
        detachProcessHooks();
        safeResolve({ ok: true, msg: 'Service installed and started.' });
      });
      svc.on('alreadyinstalled', () => {
        _stage('event:alreadyinstalled');
        try { svc.start(); } catch { /* ignore */ }
        detachProcessHooks();
        safeResolve({ ok: true, msg: 'Service was already installed — started.' });
      });
      svc.on('invalidinstallation', () => {
        _stage('event:invalidinstallation');
        detachProcessHooks();
        safeReject(new Error('Service install reported an invalid installation (winsw or XML missing)'));
      });
      svc.on('error', (e) => {
        _stage('event:error:' + (e?.message || String(e)));
        detachProcessHooks();
        safeReject(e);
      });

      _stage('svc.install:calling');
      svc.install();
      _stage('svc.install:returned');
    } catch (e) {
      _stage('install:throw:' + e.message);
      detachProcessHooks();
      safeReject(e);
    }
  });
}

/** Stop and uninstall the Windows service. Returns a Promise. */
function uninstallService() {
  return new Promise((resolve, reject) => {
    const svc = makeService();
    svc.on('uninstall', () => resolve({ ok: true, msg: 'Service uninstalled.' }));
    svc.on('error', (e) => reject(new Error(e?.message || String(e))));
    svc.stop();
    setTimeout(() => svc.uninstall(), 2000);
  });
}

/** Start the service (if already installed). */
function startService() {
  return new Promise((resolve, reject) => {
    const svc = makeService();
    svc.on('start', () => resolve({ ok: true, msg: 'Service started.' }));
    svc.on('error', (e) => reject(new Error(e?.message || String(e))));
    svc.start();
  });
}

/** Stop the service. */
function stopService() {
  return new Promise((resolve, reject) => {
    const svc = makeService();
    svc.on('stop', () => resolve({ ok: true, msg: 'Service stopped.' }));
    svc.on('error', (e) => reject(new Error(e?.message || String(e))));
    svc.stop();
  });
}

/**
 * Check if the service is installed and running using sc.exe (no node-windows needed).
 * Returns { installed, running, status }
 */
function getServiceStatus() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`sc query "${SERVICE_NAME}"`, (err, stdout) => {
      if (err || stdout.includes('FAILED') || stdout.includes('does not exist')) {
        return resolve({ installed: false, running: false, status: 'Not installed' });
      }
      const running = stdout.includes('RUNNING');
      const stopped = stdout.includes('STOPPED');
      resolve({
        installed: true,
        running,
        status: running ? 'Running' : stopped ? 'Stopped' : 'Unknown',
      });
    });
  });
}

module.exports = { installService, uninstallService, startService, stopService, getServiceStatus };
