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

// ── Data-loss protections ─────────────────────────────────────────────────
// Same hardening as the Homebridge plugin's DwmStore (which lost user rules
// to the naive load/save pattern this file also had):
//  - distinguish missing-file from unreadable/corrupt (never overwrite what
//    we couldn't read)
//  - atomic writes via tmp + rename (readers never see a half-written file)
//  - rolling .bak of the last good file
//  - refuse to flatten non-empty on-disk data with empty in-memory state

let _lastKnown  = null;
let _safeToSave = true;

function isEmptyState(d) {
  if (!d) return true;
  return (!Array.isArray(d.devices)  || d.devices.length  === 0)
      && (!Array.isArray(d.dwmRules) || d.dwmRules.length === 0)
      && (!d.location || (d.location.lat == null && d.location.lng == null));
}

function load() {
  const file = storePath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') { _safeToSave = true; return { ...DEFAULTS }; }
    _safeToSave = false;                       // EBUSY/EACCES/EIO — don't clobber
    console.warn(`[store] cannot read ${file} (${e.code}); refusing to save until readable`);
    return { ...DEFAULTS };
  }
  try {
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    _lastKnown = merged;
    _safeToSave = true;
    return merged;
  } catch {
    // Corrupt JSON — quarantine, try the .bak, only then fall back to defaults.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    try {
      const bak = fs.readFileSync(`${file}.bak`, 'utf8');
      const merged = { ...DEFAULTS, ...JSON.parse(bak) };
      fs.writeFileSync(file, bak, 'utf8');
      console.warn(`[store] recovered ${file} from .bak`);
      _lastKnown = merged;
      _safeToSave = true;
      return merged;
    } catch {
      _safeToSave = false;
      return { ...DEFAULTS };
    }
  }
}

function save(data) {
  const file = storePath();
  if (!_safeToSave) {
    console.warn('[store] save skipped — last read was unsafe (corrupt or unreadable file)');
    return;
  }
  if (isEmptyState(data) && _lastKnown && !isEmptyState(_lastKnown)) {
    console.warn('[store] BLOCKED empty-state write — existing devices/rules/location would be lost');
    return;
  }
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
    _lastKnown = data;
  } catch (e) {
    console.warn(`[store] save failed (${e.code || e.message}); original left intact`);
    try { fs.unlinkSync(tmp); } catch { /* */ }
  }
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
