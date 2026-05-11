'use strict';

/**
 * Cross-platform shared paths for Dibby Wemo Manager.
 *
 * Two distinct directory concepts:
 *
 *   SHARED_DATA_DIR  — system-wide writable dir that BOTH the GUI process AND
 *                      the headless service / launchd daemon must share. Used
 *                      for: devices.json, dwm-rules.json, scheduler.log,
 *                      deployed scheduler-standalone.js, deployed node binary,
 *                      deployed node-windows pkg (Windows), homekit-bridge/.
 *
 *   USER_DATA_DIR    — per-user dir resolved via electron's app.getPath('userData').
 *                      Used for the fallback in-app HomeKit bridge when no
 *                      service is installed. Not visible to a system daemon
 *                      under a different uid.
 *
 * Windows: SHARED is C:\ProgramData\DibbyWemoManager (everyone-writable)
 * macOS:   SHARED is /Library/Application Support/Dibby Wemo Manager
 *          (admin-writable; service install must `sudo` or use AuthorizationServices)
 * Linux:   SHARED is /var/lib/dibby-wemo-manager
 *          (admin-writable; service install uses sudo + systemd)
 */

const path = require('path');
const os   = require('os');

const APP_NAME = 'DibbyWemoManager';                 // Windows ProgramData / Linux /var/lib name
const APP_NAME_PRETTY = 'Dibby Wemo Manager';        // macOS Application Support name

function getSharedDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.ProgramData || 'C:\\ProgramData', APP_NAME);
    case 'darwin':
      return path.join('/Library', 'Application Support', APP_NAME_PRETTY);
    case 'linux':
    default:
      // /var/lib is the conventional Linux daemon-state dir
      return path.join('/var', 'lib', 'dibby-wemo-manager');
  }
}

const SHARED_DATA_DIR = getSharedDataDir();

// File path helpers — single source of truth across the codebase.
const PATHS = {
  SHARED_DATA_DIR,

  // Shared between GUI + service/daemon
  DEVICES_FILE:           path.join(SHARED_DATA_DIR, 'devices.json'),
  DWM_RULES_FILE:         path.join(SHARED_DATA_DIR, 'dwm-rules.json'),
  SCHEDULER_LOG:          path.join(SHARED_DATA_DIR, 'scheduler.log'),
  SERVICE_INSTALL_LOG:    path.join(SHARED_DATA_DIR, 'service-install.log'),

  // Deployed-by-installer files (live alongside SHARED_DATA_DIR so the daemon
  // can find them at a stable path regardless of the GUI's install location)
  SCHEDULER_SCRIPT:       path.join(SHARED_DATA_DIR, 'scheduler-standalone.js'),
  NODE_BINARY:            path.join(SHARED_DATA_DIR, process.platform === 'win32' ? 'node.exe' : 'node'),

  // Windows-only: node-windows package gets copied here so its bundled
  // elevate.cmd / winsw.exe / sudo.exe are spawnable from real disk paths.
  NODE_WINDOWS_DIR:       path.join(SHARED_DATA_DIR, 'node-windows'),

  // macOS-only: launchd plist destination
  LAUNCHD_PLIST_SYSTEM:   '/Library/LaunchDaemons/com.srsit.dibbywemoscheduler.plist',
  LAUNCHD_PLIST_USER:     path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.srsit.dibbywemoscheduler.plist'),

  // Linux-only: systemd unit destination
  SYSTEMD_UNIT_SYSTEM:    '/etc/systemd/system/dibby-wemo-scheduler.service',
  SYSTEMD_UNIT_USER:      path.join(os.homedir(), '.config', 'systemd', 'user', 'dibby-wemo-scheduler.service'),

  // HomeKit bridge state (shared so both service-mode and in-app fallback can find it)
  HK_BRIDGE_DIR:          path.join(SHARED_DATA_DIR, 'homekit-bridge'),
  HK_BRIDGE_STATUS_FILE:  path.join(SHARED_DATA_DIR, 'homekit-bridge', 'status.json'),
  HK_BRIDGE_PREFS_FILE:   path.join(SHARED_DATA_DIR, 'homekit-bridge-prefs.json'),

  // Service / daemon name (consistent across platforms; Service Control Manager
  // on Windows, launchd label on macOS, systemd unit on Linux all use this)
  SERVICE_NAME:           'DibbyWemoScheduler',
  SERVICE_LABEL:          'com.srsit.dibbywemoscheduler',
};

module.exports = PATHS;
