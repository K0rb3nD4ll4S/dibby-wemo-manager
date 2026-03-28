'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const scheduler = require('../scheduler');

module.exports = function registerSchedulerIpc() {
  // Push fire events to all renderer windows
  scheduler.onFire((event) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('scheduler-fired', event)
    );
  });

  // Push status updates to all renderer windows
  scheduler.onStatus((status) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('scheduler-status', status)
    );
  });

  // Push device health events to all renderer windows
  scheduler.onHealth((event) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('scheduler-health', event)
    );
  });

  ipcMain.handle('scheduler-start', async (_e, { devices }) => {
    return scheduler.start(devices);
  });

  ipcMain.handle('scheduler-stop', () => {
    return scheduler.stop();
  });

  ipcMain.handle('scheduler-status', () => {
    return scheduler.getStatus();
  });

  ipcMain.handle('scheduler-health', () => {
    return scheduler.getHealthStatus();
  });
};
