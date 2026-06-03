'use strict';

/**
 * DWM Store — Homebridge edition.
 *
 * Stores devices, DWM rules, and location in a single JSON file inside
 * Homebridge's storagePath (passed in at construction time, not via Electron).
 *
 * Schema mirrors the desktop store exactly so DWM rules created in the desktop
 * app can be imported / shared.
 *
 * ─── Data-loss protections (added in v2.0.36 after rules + devices vanished
 *     after a plugin upgrade) ───────────────────────────────────────────────
 *
 *  1. Distinguish "file does not exist" from "file exists but unreadable /
 *     unparseable".  The previous version returned DEFAULTS on every error,
 *     which caused the very next mutation to overwrite the file with empty
 *     state — destroying the user's data permanently.
 *
 *  2. Atomic writes via tmp + rename.  Eliminates the race window where a
 *     reader (the UI server process, or a heartbeat tick) catches the file
 *     mid-write and parses junk → returns DEFAULTS → overwrites.
 *
 *  3. Refuse to overwrite non-empty data with empty data.  If the in-memory
 *     state has zero devices AND zero rules AND no location, but the on-disk
 *     file already had real data, the write is rejected with a warning.
 *     Protects against process startup races between the plugin runtime and
 *     the UI server before they've both fully loaded.
 *
 *  4. Keep one rolling `.bak` of the last good file.  If the main file ever
 *     gets damaged, `dibby-wemo.json.bak` is one rename away.
 *
 *  5. Quarantine corrupt files instead of overwriting them.  A file that
 *     exists but fails to parse is moved to
 *     `dibby-wemo.json.corrupt-<unix-ts>` so the user can recover its
 *     contents manually.
 */

const path = require('path');
const fs   = require('fs');

const DEFAULTS = {
  location:           null,
  devices:            [],
  deviceGroups:       [],
  deviceOrder:        [],
  disabledRules:      {},
  dwmRules:           [],
  schedulerHeartbeat: null,
};

function isEmptyState(d) {
  if (!d) return true;
  const noDevices  = !Array.isArray(d.devices)  || d.devices.length  === 0;
  const noRules    = !Array.isArray(d.dwmRules) || d.dwmRules.length === 0;
  const noLocation = !d.location || (d.location.lat == null && d.location.lng == null);
  const noGroups   = !Array.isArray(d.deviceGroups) || d.deviceGroups.length === 0;
  const noOrder    = !Array.isArray(d.deviceOrder)  || d.deviceOrder.length  === 0;
  return noDevices && noRules && noLocation && noGroups && noOrder;
}

class DwmStore {
  constructor(storagePath) {
    this._filePath    = path.join(storagePath, 'dibby-wemo.json');
    this._bakPath     = `${this._filePath}.bak`;
    this._tmpPath     = `${this._filePath}.tmp`;
    // Cached snapshot of the last successful disk read.  Used both to short-
    // circuit hot paths (heartbeat saves) and as the "is the disk state
    // non-empty" signal for the empty-write guard.
    this._lastKnown   = null;
    this._safeToSave  = true;     // flipped false if we ever see a corrupt file
  }

  // ── Internal I/O ──────────────────────────────────────────────────────────

  /**
   * Read the file from disk.  Three outcomes:
   *  - Returns `{ ...DEFAULTS }` cleanly if the file simply doesn't exist
   *    (first-run case).
   *  - Returns parsed data if the file exists and is valid JSON.
   *  - If the file exists but is unreadable / corrupt, moves it aside to
   *    `*.corrupt-<ts>`, sets `_safeToSave = false`, and returns DEFAULTS.
   *    Subsequent `_save()` calls will be rejected until a clean reload
   *    succeeds.
   */
  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this._filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        // First-run: file simply doesn't exist yet.  Safe to save.
        this._safeToSave = true;
        return { ...DEFAULTS };
      }
      // EACCES, EBUSY, EIO, etc.  We don't know if the file holds user data,
      // so refuse to overwrite until we can read it cleanly.
      this._safeToSave = false;
      try {
        // eslint-disable-next-line no-console
        console.warn(`[DwmStore] cannot read ${this._filePath} (${e.code || e.message}). Refusing to save until readable.`);
      } catch { /* logging is best-effort */ }
      return { ...DEFAULTS };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // File exists but isn't valid JSON.  Move it aside so a future write
      // doesn't destroy the original; user can inspect / recover it.
      const corruptPath = `${this._filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this._filePath, corruptPath); } catch { /* best effort */ }
      try {
        // eslint-disable-next-line no-console
        console.warn(`[DwmStore] ${this._filePath} was unparseable JSON. Quarantined to ${corruptPath}. Will try .bak fallback.`);
      } catch { /* logging is best-effort */ }
      // Try the backup before declaring data lost.
      try {
        const bakRaw = fs.readFileSync(this._bakPath, 'utf8');
        parsed = JSON.parse(bakRaw);
        // Restore the .bak as the new main file.
        fs.writeFileSync(this._filePath, bakRaw, 'utf8');
        try { console.warn(`[DwmStore] recovered from ${this._bakPath}.`); } catch { /* */ }
      } catch {
        this._safeToSave = false;
        return { ...DEFAULTS };
      }
    }

    const merged = { ...DEFAULTS, ...parsed };
    this._lastKnown  = merged;
    this._safeToSave = true;
    return merged;
  }

  /**
   * Atomic save: write to a sibling .tmp file, then rename over the target.
   * Renames are atomic on POSIX filesystems and effectively-atomic on NTFS,
   * so readers never see a partially-written file.
   *
   * Refuses to write empty state on top of a non-empty file — that's the
   * single most common cause of "all my rules are gone" reports.
   */
  _save(data) {
    if (!this._safeToSave) {
      // eslint-disable-next-line no-console
      try { console.warn('[DwmStore] save skipped — last read was unsafe (corrupt or unreadable file).'); } catch { /* */ }
      return;
    }

    // Empty-write guard.  If we're about to flatten user data, abort and warn.
    if (isEmptyState(data) && this._lastKnown && !isEmptyState(this._lastKnown)) {
      // eslint-disable-next-line no-console
      try {
        console.warn(
          `[DwmStore] BLOCKED an empty-state write to ${this._filePath} — ` +
          `existing data (${(this._lastKnown.devices || []).length} device(s), ` +
          `${(this._lastKnown.dwmRules || []).length} DWM rule(s)) would be lost. ` +
          `Likely cause: process race between plugin runtime and UI server.`,
        );
      } catch { /* */ }
      return;
    }

    const payload = JSON.stringify(data, null, 2);
    try {
      // 1. Write to tmp.
      fs.writeFileSync(this._tmpPath, payload, 'utf8');
      // 2. Snapshot the previous file to .bak (best effort).
      try {
        if (fs.existsSync(this._filePath)) {
          fs.copyFileSync(this._filePath, this._bakPath);
        }
      } catch { /* .bak is best-effort */ }
      // 3. Atomic-rename tmp → target.
      fs.renameSync(this._tmpPath, this._filePath);
      this._lastKnown = data;
    } catch (e) {
      try { console.warn(`[DwmStore] save failed (${e.code || e.message}). Original ${this._filePath} left intact.`); } catch { /* */ }
      // Clean up the tmp file so it doesn't accumulate on disk.
      try { fs.unlinkSync(this._tmpPath); } catch { /* */ }
    }
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
   *
   * STICKY-DEVICE GUARANTEE — once a Wemo has been detected and stored, it
   * stays in the device list permanently.  A re-scan never removes anything:
   * if a device is offline / unreachable / on a different VLAN, its cached
   * record is preserved exactly as-is (host, port, UDN, friendlyName, model,
   * firmwareVersion).  Plugin upgrades (`npm update -g homebridge-dibby-wemo`)
   * leave this file untouched because it lives in Homebridge's storagePath,
   * outside the npm package directory.
   *
   * Behaviour:
   * - Existing devices get their host/port/name/firmware refreshed if a new
   *   scan returned newer values; everything else on the record is kept.
   * - Previously cached devices NOT in the new scan are kept verbatim
   *   (offline ≠ removed).
   * - Brand-new devices are appended.
   *
   * Returns the merged list (= the new on-disk state).
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
