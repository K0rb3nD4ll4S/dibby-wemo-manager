'use strict';

const { ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const axios = require('axios');
const store = require('../store');
const wemo  = require('../wemo');
// Service management is Windows-only
const isWindows = process.platform === 'win32';
const svcMgr  = isWindows ? require('../service-manager')      : null;
const svcSync = isWindows ? require('../service-manager-sync') : null;

module.exports = function registerSystemIpc() {
  // Theme
  ipcMain.handle('get-theme', () => store.getTheme());
  ipcMain.handle('set-theme', (_e, theme) => store.setTheme(theme));

  // Location
  ipcMain.handle('get-location', () => store.getLocation());
  ipcMain.handle('set-location', (_e, loc) => {
    store.setLocation(loc);
    wemo.setLocation(loc);
  });

  // Geocoding via Nominatim (OpenStreetMap, no API key required)
  ipcMain.handle('search-location', async (_e, query) => {
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { q: query, format: 'json', limit: 8, addressdetails: 1 },
        headers: { 'User-Agent': 'WemoManager/2.0' },
        timeout: 8000,
      });
      return (res.data || []).map((r) => ({
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        label: r.display_name,
        city: r.address?.city || r.address?.town || r.address?.village || r.address?.county || '',
        country: r.address?.country || '',
        countryCode: (r.address?.country_code || '').toUpperCase(),
        region: r.address?.state || '',
      }));
    } catch { return []; }
  });

  ipcMain.handle('reverse-geocode', async (_e, { lat, lng }) => {
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
        params: { lat, lon: lng, format: 'json', addressdetails: 1 },
        headers: { 'User-Agent': 'WemoManager/2.0' },
        timeout: 8000,
      });
      const a = res.data.address || {};
      return {
        lat, lng,
        label: res.data.display_name || `${lat}, ${lng}`,
        city: a.city || a.town || a.village || a.county || '',
        country: a.country || '',
        countryCode: (a.country_code || '').toUpperCase(),
        region: a.state || '',
      };
    } catch { return { lat, lng, label: `${lat}, ${lng}`, city: '', country: '', countryCode: '', region: '' }; }
  });

  // Sun times
  ipcMain.handle('get-sun-times', (_e, { lat, lng }) => {
    const { sunTimes } = require('../core/sun');
    return sunTimes(lat, lng);
  });

  // File I/O
  ipcMain.handle('show-save-dialog', async (_e, opts) => {
    return dialog.showSaveDialog(opts);
  });

  ipcMain.handle('show-open-dialog', async (_e, opts) => {
    return dialog.showOpenDialog(opts);
  });

  ipcMain.handle('write-file', async (_e, { filePath, content }) => {
    fs.writeFileSync(filePath, content, 'utf8');
  });

  ipcMain.handle('read-file', async (_e, { filePath }) => {
    return fs.readFileSync(filePath, 'utf8');
  });

  ipcMain.handle('open-external', async (_e, url) => {
    await shell.openExternal(url);
  });

  // ── Windows Service management (Windows only) ────────────────────────────
  const notSupported = () => ({ installed: false, running: false, status: 'Not supported on this platform' });
  ipcMain.handle('service-status',    () => isWindows ? svcMgr.getServiceStatus() : notSupported());
  ipcMain.handle('service-install',   () => isWindows ? svcMgr.installService()   : { ok: false, msg: 'Windows only' });
  ipcMain.handle('service-uninstall', () => isWindows ? svcMgr.uninstallService() : { ok: false, msg: 'Windows only' });
  ipcMain.handle('service-start',     () => isWindows ? svcMgr.startService()     : { ok: false, msg: 'Windows only' });
  ipcMain.handle('service-stop',      () => isWindows ? svcMgr.stopService()      : { ok: false, msg: 'Windows only' });

  // ── Device sync to ProgramData (for service) ──────────────────────────────
  ipcMain.handle('sync-devices-to-service', (_e, devices) => {
    if (isWindows && svcSync) svcSync.syncDevices(devices);
  });
};
