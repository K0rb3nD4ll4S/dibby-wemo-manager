'use strict';

const { ipcMain } = require('electron');
const path      = require('path');
const fs        = require('fs');
const wemo      = require('../wemo');
const store     = require('../store');
const scheduler = require('../scheduler');

// Write DWM rules to ProgramData so the standalone service can read them
const DWM_SHARED = path.join('C:\\ProgramData', 'DibbyWemoManager', 'dwm-rules.json');
function syncDwmRulesToService() {
  try {
    fs.mkdirSync(path.dirname(DWM_SHARED), { recursive: true });
    fs.writeFileSync(DWM_SHARED, JSON.stringify(store.getDwmRules(), null, 2), 'utf8');
  } catch { /* non-critical */ }
}

module.exports = function registerRulesIpc() {

  // ── Wemo device rules (read from device, used by Wemo Rules tab) ───────────

  ipcMain.handle('get-rules', async (_e, { host, port }) => {
    return wemo.getRules(host, port);
  });

  // Write a native rule directly to a Wemo device (Wemo Rules tab, not DWM).
  ipcMain.handle('create-rule', async (_e, { host, port, input }) => {
    return wemo.createRule(host, port, input);
  });

  ipcMain.handle('update-rule', async (_e, { host, port, ruleId, input }) => {
    return wemo.updateRule(host, port, ruleId, input);
  });

  ipcMain.handle('delete-rule', async (_e, { host, port, ruleId }) => {
    return wemo.deleteRule(host, port, ruleId);
  });

  ipcMain.handle('dump-db', async (_e, { host, port }) => {
    return wemo.dumpDb(host, port);
  });

  ipcMain.handle('reboot-device', async (_e, { host, port }) => {
    return wemo.rebootDevice(host, port);
  });

  // ── DWM Rules — stored locally, scheduler reads these ─────────────────────

  ipcMain.handle('get-dwm-rules', () => {
    return store.getDwmRules();
  });

  ipcMain.handle('create-dwm-rule', (_e, rule) => {
    const result = store.createDwmRule(rule);
    syncDwmRulesToService();
    scheduler.reload();
    return result;
  });

  ipcMain.handle('update-dwm-rule', (_e, { id, updates }) => {
    const result = store.updateDwmRule(id, updates);
    syncDwmRulesToService();
    scheduler.reload();
    return result;
  });

  ipcMain.handle('delete-dwm-rule', (_e, { id }) => {
    store.deleteDwmRule(id);
    syncDwmRulesToService();
    scheduler.reload();
  });

  // ── Legacy disabled-rule backups (no longer used by DWM tab) ──────────────
  ipcMain.handle('get-disabled-rules', () => store.getDisabledRules());

  ipcMain.handle('set-disabled-rule', (_e, { key, ruleDevicesRows }) => {
    store.setDisabledRule(key, ruleDevicesRows);
  });

  ipcMain.handle('clear-disabled-rule', (_e, { key }) => {
    store.clearDisabledRule(key);
  });
};
