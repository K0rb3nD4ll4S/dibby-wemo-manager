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

// Path to the standalone scheduler script (works in both dev and packaged)
function getScriptPath() {
  // In packaged app: resources/app.asar.unpacked/... or alongside the exe
  // In dev: src/main/scheduler-standalone.js
  const devPath = path.join(__dirname, 'scheduler-standalone.js');
  if (fs.existsSync(devPath)) return devPath;
  // Packaged (electron-builder extraResources / asarUnpack)
  return path.join(process.resourcesPath, 'scheduler-standalone.js');
}

// Path to node.exe: use the bundled Electron node, or fall back to system node
function getNodePath() {
  // Electron exposes its own node as process.execPath only when running as node
  // For a service we need a real node.exe, not electron.exe
  // Check for bundled node next to the app executable
  const candidates = [
    path.join(path.dirname(process.execPath), 'node.exe'),
    path.join(process.resourcesPath || '', '..', 'node.exe'),
    'node', // system PATH
  ];
  for (const c of candidates) {
    try { if (c === 'node' || fs.existsSync(c)) return c; } catch { /* skip */ }
  }
  return 'node';
}

function makeService() {
  const { Service } = require('node-windows');
  return new Service({
    name:        SERVICE_NAME,
    description: SERVICE_DESC,
    script:      getScriptPath(),
    nodeOptions: [],
    execPath:    getNodePath(),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Install and start the Windows service. Returns a Promise. */
function installService() {
  return new Promise((resolve, reject) => {
    const svc = makeService();
    svc.on('install', () => {
      svc.start();
      resolve({ ok: true, msg: 'Service installed and started.' });
    });
    svc.on('alreadyinstalled', () => {
      svc.start();
      resolve({ ok: true, msg: 'Service was already installed — started.' });
    });
    svc.on('error', (e) => reject(new Error(e?.message || String(e))));
    svc.install();
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
