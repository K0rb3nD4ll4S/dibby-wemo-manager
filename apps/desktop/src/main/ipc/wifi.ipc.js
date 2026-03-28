'use strict';

const { ipcMain } = require('electron');
const wemo = require('../wemo');

module.exports = function registerWifiIpc() {
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
