'use strict';

/**
 * IPC bridge for the embedded HomeKit (HAP) bridge.
 *
 * Architecture (v2.0.18+):
 *   The bridge runs HEADLESS inside the DibbyWemoScheduler service so users
 *   without an always-on desktop app still get HomeKit. The desktop app's
 *   role is just to display status (pincode + QR + paired controllers) by
 *   reading a shared status file the service writes every 30 seconds.
 *
 * Two operating modes:
 *   "service" — the headless service hosts the bridge. Desktop reads status
 *               from C:\ProgramData\DibbyWemoManager\homekit-bridge\status.json
 *   "app"     — the service is not installed/running; the desktop app hosts
 *               the bridge in-process as a fallback. Bridge state lives under
 *               <userData>/homekit-bridge/.
 *
 * The desktop UI prefers the service mode whenever the status file is fresh
 * (updated within the last 90 seconds). Otherwise it offers to host in-app.
 */

const { ipcMain, app } = require('electron');
const path  = require('path');
const fs    = require('fs');
const wemo  = require('../wemo');
const store = require('../store');
const bridge = require('../homekit-bridge');

const SERVICE_DATA_DIR    = path.join('C:\\ProgramData', 'DibbyWemoManager');
const SERVICE_BRIDGE_DIR  = path.join(SERVICE_DATA_DIR, 'homekit-bridge');
const SERVICE_STATUS_FILE = path.join(SERVICE_BRIDGE_DIR, 'status.json');
const SERVICE_PREFS_FILE  = path.join(SERVICE_DATA_DIR, 'homekit-bridge-prefs.json');
const SERVICE_STATUS_FRESH_MS = 90_000; // status older than 90 s = service not running

let _appBridgeStarted = false;
let _appBridgeStarting = false;

function _appBridgeStorageDir() {
  return path.join(app.getPath('userData'), 'homekit-bridge');
}

function _appPrefsFile() {
  return path.join(app.getPath('userData'), 'homekit-bridge-prefs.json');
}

// ── Service-mode status (preferred) ────────────────────────────────────────

function _readServiceStatus() {
  try {
    const stat = fs.statSync(SERVICE_STATUS_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > SERVICE_STATUS_FRESH_MS) return null;  // stale — service is dead
    return JSON.parse(fs.readFileSync(SERVICE_STATUS_FILE, 'utf8'));
  } catch { return null; }
}

function _readServicePrefs() {
  try { return JSON.parse(fs.readFileSync(SERVICE_PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

function _writeServicePrefs(patch) {
  try {
    fs.mkdirSync(SERVICE_DATA_DIR, { recursive: true });
    const cur = _readServicePrefs();
    fs.writeFileSync(SERVICE_PREFS_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
  } catch { /* non-critical */ }
}

// ── App-mode bridge (fallback) ─────────────────────────────────────────────

async function _appBridgeStart() {
  if (_appBridgeStarted || _appBridgeStarting) return;
  _appBridgeStarting = true;
  try {
    await bridge.start({
      storagePath: _appBridgeStorageDir(),
      wemoClient:  wemo,
      log:         (msg) => console.log(msg),
    });
    bridge.syncDevices(store.getDevices() ?? []);
    _appBridgeStarted = true;
  } finally {
    _appBridgeStarting = false;
  }
}

async function _appBridgeStop() {
  if (!_appBridgeStarted) return;
  await bridge.stop();
  _appBridgeStarted = false;
}

function _readAppPrefs() {
  try { return JSON.parse(fs.readFileSync(_appPrefsFile(), 'utf8')); } catch { return {}; }
}
function _writeAppPrefs(patch) {
  try {
    fs.mkdirSync(path.dirname(_appPrefsFile()), { recursive: true });
    const cur = _readAppPrefs();
    fs.writeFileSync(_appPrefsFile(), JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
  } catch { /* non-critical */ }
}

/**
 * Called whenever the device list changes. If the in-process bridge is
 * running, reconcile its accessory list. If the bridge is in the service,
 * the service watches DEVICES_FILE itself — nothing to do here.
 */
function syncFromDeviceList(devices) {
  if (!_appBridgeStarted) return;
  try { bridge.syncDevices(devices ?? []); }
  catch (e) { console.error('[hk-bridge] syncDevices failed:', e.message); }
}

// ── Combined status ────────────────────────────────────────────────────────

async function _combinedStatus() {
  const svc = _readServiceStatus();
  if (svc && svc.running) {
    return {
      ...svc,
      mode:         'service',
      autoStart:    _readServicePrefs().autoStart !== false, // service defaults autostart=on
      serviceFresh: true,
    };
  }
  // Service not running — fall back to in-app bridge state
  const appS = _appBridgeStarted ? await bridge.getStatus() : { running: false };
  return {
    ...appS,
    mode:           'app',
    autoStart:      !!_readAppPrefs().autoStart,
    serviceFresh:   false,
  };
}

module.exports = function registerHomeKitIpc() {

  ipcMain.handle('hk-bridge-status', _combinedStatus);

  ipcMain.handle('hk-bridge-start', async () => {
    // If the service is running we don't start an in-process bridge — port
    // collision and confusing duplicate accessories. Tell renderer to open
    // the service install / start UI instead.
    const svc = _readServiceStatus();
    if (svc && svc.running) return { ...(await _combinedStatus()), msg: 'Bridge already running in service.' };
    await _appBridgeStart();
    return await _combinedStatus();
  });

  ipcMain.handle('hk-bridge-stop', async () => {
    const svc = _readServiceStatus();
    if (svc && svc.running) {
      // Service-side stop = flip the autoStart preference and tell user to restart service.
      _writeServicePrefs({ autoStart: false });
      return { ...(await _combinedStatus()), msg: 'Set service-side bridge to OFF — restart DibbyWemoScheduler to apply.' };
    }
    await _appBridgeStop();
    return await _combinedStatus();
  });

  ipcMain.handle('hk-bridge-set-autostart', async (_e, value) => {
    const v = !!value;
    // Mirror the preference to BOTH locations: the service reads from
    // ProgramData, and the desktop's in-app fallback uses userData.
    _writeServicePrefs({ autoStart: v });
    _writeAppPrefs({ autoStart: v });
    if (v && !_readServiceStatus()?.running && !_appBridgeStarted) {
      await _appBridgeStart();
    }
    return await _combinedStatus();
  });

  ipcMain.handle('hk-bridge-reset-pairings', async () => {
    const svc = _readServiceStatus();
    if (svc && svc.running) {
      // Wipe service-side bridge directory so next service restart re-pairs from scratch
      try { fs.rmSync(SERVICE_BRIDGE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ...(await _combinedStatus()), msg: 'Bridge data wiped — restart DibbyWemoScheduler to re-pair.' };
    }
    await bridge.resetPairings();
    _appBridgeStarted = false;
    if (_readAppPrefs().autoStart) await _appBridgeStart();
    return await _combinedStatus();
  });

  ipcMain.handle('hk-bridge-sync', async () => {
    const svc = _readServiceStatus();
    if (svc && svc.running) {
      // Touch DEVICES_FILE so the service's fs.watch fires and re-syncs accessories
      try {
        const devicesFile = path.join(SERVICE_DATA_DIR, 'devices.json');
        const now = new Date();
        fs.utimesSync(devicesFile, now, now);
      } catch { /* file may not exist yet */ }
      return await _combinedStatus();
    }
    if (_appBridgeStarted) bridge.syncDevices(store.getDevices() ?? []);
    return await _combinedStatus();
  });

  // App-mode autostart on launch (only fires if service isn't running)
  setTimeout(async () => {
    const svc = _readServiceStatus();
    if (svc && svc.running) return;  // service has it
    if (_readAppPrefs().autoStart) {
      _appBridgeStart().catch((e) => console.error('[hk-bridge] app autostart failed:', e.message));
    }
  }, 1500);

  app.on('before-quit', async () => {
    try { await _appBridgeStop(); } catch { /* ignore */ }
  });
};

module.exports.syncFromDeviceList = syncFromDeviceList;
