'use strict';

/**
 * Thin helper: writes the device list to the shared OS-specific data dir
 * (ProgramData on Windows, /Library/Application Support on macOS,
 * /var/lib/dibby-wemo-manager on Linux) so the headless service / launchd
 * daemon / systemd unit always has up-to-date host/port/udn mappings.
 *
 * Kept separate so it can be required without pulling in node-windows
 * (which is Windows-only and would blow up at require time on macOS/Linux).
 */

const path  = require('path');
const fs    = require('fs');
const PATHS = require('./core/paths');

function syncDevices(devices) {
  try {
    fs.mkdirSync(PATHS.SHARED_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      PATHS.DEVICES_FILE,
      JSON.stringify({ devices, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (e) {
    console.warn('[service-sync] Could not write devices.json:', e.message);
  }
}

module.exports = { syncDevices };
