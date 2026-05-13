'use strict';

const { ipcMain } = require('electron');
const wemo  = require('../wemo');
const store = require('../store');

module.exports = function registerDeviceIpc() {
  ipcMain.handle('discover-devices', async (_e, opts = {}) => {
    const manual = store.getDevices().filter((d) => d.manual).map((d) => ({ host: d.host, port: d.port }));
    return wemo.discoverDevices(opts.timeout || 10_000, [...manual, ...(opts.manualEntries || [])]);
  });

  ipcMain.handle('get-device-state', async (_e, { host, port }) => {
    return wemo.getBinaryState(host, port);
  });

  ipcMain.handle('set-device-state', async (_e, { host, port, on }) => {
    return wemo.setBinaryState(host, port, on);
  });

  ipcMain.handle('get-device-info', async (_e, { host, port }) => {
    const [info, setup] = await Promise.allSettled([
      wemo.getDeviceInfo(host, port),
      wemo.fetchSetupXml(host, port),
    ]);
    const infoData  = info.status  === 'fulfilled' ? info.value  : {};
    const setupData = setup.status === 'fulfilled' ? setup.value : {};
    return { ...setupData, ...infoData };
  });

  ipcMain.handle('check-online', async (_e, { host, port }) => {
    try {
      await wemo.getBinaryState(host, port);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('set-device-time', async (_e, { host, port }) => {
    return wemo.setDeviceTime(host, port);
  });

  ipcMain.handle('rename-device', async (_e, { host, port, name }) => {
    return wemo.renameDevice(host, port, name);
  });

  ipcMain.handle('reset-data', async (_e, { host, port }) => {
    return wemo.resetData(host, port);
  });

  ipcMain.handle('factory-reset', async (_e, { host, port }) => {
    return wemo.factoryReset(host, port);
  });

  ipcMain.handle('reset-wifi', async (_e, { host, port }) => {
    return wemo.resetWifi(host, port);
  });

  ipcMain.handle('get-homekit-info', async (_e, { host, port, modelName }) => {
    return wemo.getHomeKitInfo(host, port, modelName);
  });

  /**
   * Returns the HomeKit setup info plus a PNG data URL of the X-HM:// QR code.
   * Renderer can drop the data URL straight into <img src=…>. The QR encoding
   * uses error-correction level Q (~25 %) so users can scan it from a slightly
   * blurry phone camera.
   */
  ipcMain.handle('get-homekit-qr', async (_e, { host, port, modelName }) => {
    const info = await wemo.getHomeKitInfo(host, port, modelName);
    if (!info.setupURI) return { ...info, qrDataURL: null };
    let qrcode;
    try { qrcode = require('qrcode'); }
    catch { return { ...info, qrDataURL: null, qrError: 'qrcode package not installed' }; }
    const qrDataURL = await qrcode.toDataURL(info.setupURI, {
      errorCorrectionLevel: 'Q',
      margin:                1,
      width:                 240,
      color: { dark: '#000000ff', light: '#ffffffff' },
    });
    return { ...info, qrDataURL };
  });

  // Saved device list management
  ipcMain.handle('get-saved-devices',     () => store.getDevices());
  ipcMain.handle('save-devices', (_e, list) => {
    store.saveDevices(list);
    // Keep service device list in sync so it picks up new/renamed devices
    try { require('../service-manager-sync').syncDevices(list); } catch { /* service sync optional */ }
    // Reconcile HomeKit bridge accessory list (if bridge is running)
    try { require('./homekit.ipc').syncFromDeviceList(list); } catch { /* hk-bridge sync optional */ }
  });
  ipcMain.handle('get-device-order',      () => store.getDeviceOrder());
  ipcMain.handle('save-device-order',     (_e, order) => store.saveDeviceOrder(order));
  ipcMain.handle('get-device-groups',     () => store.getDeviceGroups());
  ipcMain.handle('save-device-groups',    (_e, groups) => store.saveDeviceGroups(groups));

  // ── Voice aliases (per-device training) ─────────────────────────────────
  //
  // Each Wemo can carry a `voiceAliases: string[]` field used by the speech
  // recognition layer (apps/desktop/resources/web/voice-commands.js).  These
  // helpers mutate the in-place device record so the rest of the system
  // (HomeKit bridge sync, scheduler, etc.) keeps seeing the same device
  // identity — only the alias list is touched.

  ipcMain.handle('get-voice-aliases', (_e, { host, port }) => {
    const dev = store.getDevices().find((d) => d.host === host && Number(d.port) === Number(port));
    return Array.isArray(dev?.voiceAliases) ? dev.voiceAliases : [];
  });

  ipcMain.handle('add-voice-alias', (_e, { host, port, alias }) => {
    const aliasNorm = String(alias || '').trim().toLowerCase();
    if (!aliasNorm) throw new Error('alias is required');
    const devices = store.getDevices();
    const idx = devices.findIndex((d) => d.host === host && Number(d.port) === Number(port));
    if (idx === -1) throw new Error('device not found');
    const aliases = Array.isArray(devices[idx].voiceAliases) ? devices[idx].voiceAliases.slice() : [];
    if (!aliases.includes(aliasNorm)) aliases.push(aliasNorm);
    devices[idx] = { ...devices[idx], voiceAliases: aliases };
    store.saveDevices(devices);
    return aliases;
  });

  ipcMain.handle('remove-voice-alias', (_e, { host, port, aliasIndex }) => {
    const devices = store.getDevices();
    const idx = devices.findIndex((d) => d.host === host && Number(d.port) === Number(port));
    if (idx === -1) throw new Error('device not found');
    const aliases = Array.isArray(devices[idx].voiceAliases) ? devices[idx].voiceAliases.slice() : [];
    const i = Number(aliasIndex);
    if (i < 0 || i >= aliases.length) throw new Error('alias index out of range');
    aliases.splice(i, 1);
    devices[idx] = { ...devices[idx], voiceAliases: aliases };
    store.saveDevices(devices);
    return aliases;
  });
};
