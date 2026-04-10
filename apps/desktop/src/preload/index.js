'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld('wemoAPI', {
  // Device discovery & control
  discoverDevices:    (opts)         => invoke('discover-devices', opts),
  getDeviceState:     (args)         => invoke('get-device-state', args),
  setDeviceState:     (args)         => invoke('set-device-state', args),
  getDeviceInfo:      (args)         => invoke('get-device-info', args),
  checkOnline:        (args)         => invoke('check-online', args),
  setDeviceTime:      (args)         => invoke('set-device-time', args),
  renameDevice:       (args)         => invoke('rename-device', args),
  resetData:          (args)         => invoke('reset-data', args),
  factoryReset:       (args)         => invoke('factory-reset', args),
  resetWifi:          (args)         => invoke('reset-wifi', args),
  getHomekitInfo:     (args)         => invoke('get-homekit-info', args),

  // Saved device management
  getSavedDevices:    ()             => invoke('get-saved-devices'),
  saveDevices:        (list)         => invoke('save-devices', list),
  getDeviceOrder:     ()             => invoke('get-device-order'),
  saveDeviceOrder:    (order)        => invoke('save-device-order', order),
  getDeviceGroups:    ()             => invoke('get-device-groups'),
  saveDeviceGroups:   (groups)       => invoke('save-device-groups', groups),

  // Wemo device rules (read-only source, Wemo Rules tab)
  getRules:           (args)         => invoke('get-rules', args),
  createRule:         (args)         => invoke('create-rule', args),
  updateRule:         (args)         => invoke('update-rule', args),
  deleteRule:         (args)         => invoke('delete-rule', args),
  dumpDb:             (args)         => invoke('dump-db', args),
  rebootDevice:       (args)         => invoke('reboot-device', args),
  getDisabledRules:   ()             => invoke('get-disabled-rules'),
  setDisabledRule:    (args)         => invoke('set-disabled-rule', args),
  clearDisabledRule:  (args)         => invoke('clear-disabled-rule', args),

  // DWM Rules — local app database (scheduler reads these)
  getDwmRules:        ()             => invoke('get-dwm-rules'),
  createDwmRule:      (rule)         => invoke('create-dwm-rule', rule),
  updateDwmRule:      (args)         => invoke('update-dwm-rule', args),
  deleteDwmRule:      (args)         => invoke('delete-dwm-rule', args),

  // WiFi
  getApList:          (args)         => invoke('get-ap-list', args),
  connectHomeNetwork: (args)         => invoke('connect-home-network', args),
  getNetworkStatus:   (args)         => invoke('get-network-status', args),
  closeSetup:         (args)         => invoke('close-setup', args),

  // System
  getTheme:           ()             => invoke('get-theme'),
  setTheme:           (theme)        => invoke('set-theme', theme),
  getLocation:        ()             => invoke('get-location'),
  setLocation:        (loc)          => invoke('set-location', loc),
  searchLocation:     (query)        => invoke('search-location', query),
  reverseGeocode:     (args)         => invoke('reverse-geocode', args),
  getSunTimes:        (args)         => invoke('get-sun-times', args),
  showSaveDialog:     (opts)         => invoke('show-save-dialog', opts),
  showOpenDialog:     (opts)         => invoke('show-open-dialog', opts),
  writeFile:          (args)         => invoke('write-file', args),
  readFile:           (args)         => invoke('read-file', args),
  openExternal:       (url)          => invoke('open-external', url),

  // Local Scheduler (in-process)
  schedulerStart:  (args) => invoke('scheduler-start', args),
  schedulerStop:   ()     => invoke('scheduler-stop'),
  schedulerStatus: ()     => invoke('scheduler-status'),
  schedulerHealth: ()     => invoke('scheduler-health'),

  // Windows Service
  serviceStatus:           () => invoke('service-status'),
  serviceInstall:          () => invoke('service-install'),
  serviceUninstall:        () => invoke('service-uninstall'),
  serviceStart:            () => invoke('service-start'),
  serviceStop:             () => invoke('service-stop'),
  syncDevicesToService:    (devices) => invoke('sync-devices-to-service', devices),

  onSchedulerFired: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scheduler-fired', handler);
    return () => ipcRenderer.removeListener('scheduler-fired', handler);
  },
  onSchedulerStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scheduler-status', handler);
    return () => ipcRenderer.removeListener('scheduler-status', handler);
  },
  onSchedulerHealth: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scheduler-health', handler);
    return () => ipcRenderer.removeListener('scheduler-health', handler);
  },

  // Main-process events
  onTriggerDiscovery: (cb)  => {
    ipcRenderer.on('trigger-discovery', cb);
    return () => ipcRenderer.removeListener('trigger-discovery', cb);
  },

  // WiFi diagnostic log — real-time SOAP send/recv entries from the main process.
  onWifiLog: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('wifi-log', handler);
    return () => ipcRenderer.removeListener('wifi-log', handler);
  },
});
