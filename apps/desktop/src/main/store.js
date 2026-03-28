'use strict';

const path = require('path');
const fs   = require('fs');
const { app } = require('electron');

const DEFAULTS = {
  location: null,
  theme: 'dark',
  devices: [],
  deviceGroups: [],
  deviceOrder: [],
  disabledRules: {},
};

function storePath() {
  return path.join(app.getPath('userData'), 'wemo-manager.json');
}

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function save(data) {
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
}

// Location
function getLocation()    { return load().location; }
function setLocation(loc) { const d = load(); d.location = loc; save(d); }

// Theme
function getTheme()         { return load().theme ?? 'dark'; }
function setTheme(theme)    { const d = load(); d.theme = theme; save(d); }

// Devices
function getDevices()             { return load().devices ?? []; }
function saveDevices(list)        { const d = load(); d.devices = list; save(d); }
function getDeviceOrder()         { return load().deviceOrder ?? []; }
function saveDeviceOrder(order)   { const d = load(); d.deviceOrder = order; save(d); }
function getDeviceGroups()        { return load().deviceGroups ?? []; }
function saveDeviceGroups(groups) { const d = load(); d.deviceGroups = groups; save(d); }

// Disabled-rule backups
function getDisabledRules()                       { return load().disabledRules ?? {}; }
function setDisabledRule(key, ruleDevicesRows)    { const d = load(); if (!d.disabledRules) d.disabledRules = {}; d.disabledRules[key] = ruleDevicesRows; save(d); }
function clearDisabledRule(key)                   { const d = load(); if (!d.disabledRules) return; delete d.disabledRules[key]; save(d); }

// ── DWM Rules — local app database ─────────────────────────────────────────
// Rules are stored entirely on disk (not on the Wemo device).
// Schema per rule: { id, name, type, enabled, days[], startTime, endTime,
//   startAction, endAction, startType, endType, startOffset, endOffset,
//   countdownTime, targetDevices[{udn,host,port,name}], createdAt, updatedAt }

function getDwmRules() {
  return load().dwmRules ?? [];
}

function createDwmRule(rule) {
  const d = load();
  if (!d.dwmRules) d.dwmRules = [];
  const id = `dwm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const newRule = { ...rule, id, createdAt: now, updatedAt: now };
  d.dwmRules.push(newRule);
  save(d);
  return newRule;
}

function updateDwmRule(id, updates) {
  const d = load();
  if (!d.dwmRules) d.dwmRules = [];
  const idx = d.dwmRules.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`DWM rule not found: ${id}`);
  d.dwmRules[idx] = { ...d.dwmRules[idx], ...updates, id, updatedAt: new Date().toISOString() };
  save(d);
  return d.dwmRules[idx];
}

function deleteDwmRule(id) {
  const d = load();
  if (!d.dwmRules) return;
  d.dwmRules = d.dwmRules.filter((r) => r.id !== id);
  save(d);
}

module.exports = {
  getLocation, setLocation,
  getTheme, setTheme,
  getDevices, saveDevices, getDeviceOrder, saveDeviceOrder, getDeviceGroups, saveDeviceGroups,
  getDisabledRules, setDisabledRule, clearDisabledRule,
  getDwmRules, createDwmRule, updateDwmRule, deleteDwmRule,
};
