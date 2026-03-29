'use strict';

/**
 * DWM Store — Homebridge edition.
 *
 * Stores devices, DWM rules, and location in a single JSON file inside
 * Homebridge's storagePath (passed in at construction time, not via Electron).
 *
 * Schema mirrors the desktop store exactly so DWM rules created in the desktop
 * app can be imported / shared.
 */

const path = require('path');
const fs   = require('fs');

const DEFAULTS = {
  location:     null,
  devices:      [],
  deviceGroups: [],
  deviceOrder:  [],
  disabledRules: {},
  dwmRules:     [],
  schedulerHeartbeat: null,
};

class DwmStore {
  constructor(storagePath) {
    this._filePath = path.join(storagePath, 'dibby-wemo.json');
  }

  // ── Internal I/O ──────────────────────────────────────────────────────────

  _load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this._filePath, 'utf8')) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  _save(data) {
    fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  // ── Location ──────────────────────────────────────────────────────────────

  getLocation()    { return this._load().location; }
  setLocation(loc) { const d = this._load(); d.location = loc; this._save(d); }

  // ── Devices ───────────────────────────────────────────────────────────────

  getDevices()              { return this._load().devices ?? []; }
  saveDevices(list)         { const d = this._load(); d.devices = list; this._save(d); }
  getDeviceOrder()          { return this._load().deviceOrder ?? []; }
  saveDeviceOrder(order)    { const d = this._load(); d.deviceOrder = order; this._save(d); }
  getDeviceGroups()         { return this._load().deviceGroups ?? []; }
  saveDeviceGroups(groups)  { const d = this._load(); d.deviceGroups = groups; this._save(d); }

  /**
   * Merge freshly discovered devices into the cached list.
   * - Existing devices are updated with fresh data (host/port/name/firmware).
   * - Previously cached devices NOT in the new scan are kept as-is (offline ≠ removed).
   * - Newly found devices are appended.
   * Returns the merged list.
   */
  mergeDevices(fresh) {
    const d       = this._load();
    const cached  = d.devices ?? [];
    const byUdn   = new Map(cached.map((dev) => [dev.udn, dev]));

    for (const f of fresh) {
      const udn = f.udn ?? `${f.host}:${f.port}`;
      if (byUdn.has(udn)) {
        // Update existing entry with latest network data
        byUdn.set(udn, { ...byUdn.get(udn), ...f, udn });
      } else {
        byUdn.set(udn, { ...f, udn });
      }
    }

    d.devices = Array.from(byUdn.values());
    this._save(d);
    return d.devices;
  }

  // ── Disabled-rule backups ─────────────────────────────────────────────────

  getDisabledRules()                    { return this._load().disabledRules ?? {}; }
  setDisabledRule(key, ruleDevicesRows) {
    const d = this._load();
    if (!d.disabledRules) d.disabledRules = {};
    d.disabledRules[key] = ruleDevicesRows;
    this._save(d);
  }
  clearDisabledRule(key) {
    const d = this._load();
    if (!d.disabledRules) return;
    delete d.disabledRules[key];
    this._save(d);
  }

  // ── DWM Rules ─────────────────────────────────────────────────────────────

  getDwmRules() { return this._load().dwmRules ?? []; }

  createDwmRule(rule) {
    const d = this._load();
    if (!d.dwmRules) d.dwmRules = [];
    const id  = `dwm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const newRule = { ...rule, id, createdAt: now, updatedAt: now };
    d.dwmRules.push(newRule);
    this._save(d);
    return newRule;
  }

  updateDwmRule(id, updates) {
    const d = this._load();
    if (!d.dwmRules) d.dwmRules = [];
    const idx = d.dwmRules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`DWM rule not found: ${id}`);
    d.dwmRules[idx] = { ...d.dwmRules[idx], ...updates, id, updatedAt: new Date().toISOString() };
    this._save(d);
    return d.dwmRules[idx];
  }

  deleteDwmRule(id) {
    const d = this._load();
    if (!d.dwmRules) return;
    d.dwmRules = d.dwmRules.filter((r) => r.id !== id);
    this._save(d);
  }

  // ── Scheduler heartbeat ───────────────────────────────────────────────────

  getHeartbeat() { return this._load().schedulerHeartbeat ?? null; }

  saveHeartbeat(hb) {
    const d = this._load();
    d.schedulerHeartbeat = { ...hb, ts: new Date().toISOString() };
    this._save(d);
  }
}

module.exports = DwmStore;
