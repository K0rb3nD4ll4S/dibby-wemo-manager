'use strict';

/**
 * Thin helper: writes the device list to the shared ProgramData file so the
 * Windows service always has up-to-date host/port/udn mappings.
 * Kept separate so it can be required without pulling in node-windows.
 */

const path = require('path');
const fs   = require('fs');

const PROGRAMDATA_DIR     = path.join('C:\\ProgramData', 'DibbyWemoManager');
const PROGRAMDATA_DEVICES = path.join(PROGRAMDATA_DIR, 'devices.json');

function syncDevices(devices) {
  try {
    fs.mkdirSync(PROGRAMDATA_DIR, { recursive: true });
    fs.writeFileSync(
      PROGRAMDATA_DEVICES,
      JSON.stringify({ devices, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (e) {
    console.warn('[service-sync] Could not write devices.json:', e.message);
  }
}

module.exports = { syncDevices };
