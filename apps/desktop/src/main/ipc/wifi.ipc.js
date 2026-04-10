'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const wemo = require('../wemo');

module.exports = function registerWifiIpc() {
  // Push real-time WiFi diagnostic log entries to all open renderer windows.
  wemo.setWifiLogger((entry) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('wifi-log', entry);
    });
  });

  ipcMain.handle('get-ap-list', async (_e, { host, port }) => {
    return wemo.getApList(host, port);
  });

  ipcMain.handle('connect-home-network', async (_e, { host, port, ssid, auth, password, encrypt, channel }) => {
    return wemo.connectHomeNetwork(host, port, { ssid, auth, password, encrypt, channel });
  });

  ipcMain.handle('get-network-status', async (_e, { host, port }) => {
    return wemo.getNetworkStatus(host, port);
  });

  ipcMain.handle('close-setup', async (_e, { host, port }) => {
    return wemo.closeSetup(host, port);
  });
};
