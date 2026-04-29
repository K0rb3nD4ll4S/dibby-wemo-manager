'use strict';

/**
 * Dibby Wemo Scheduler — standalone Windows Service entry point
 *
 * Runs under SYSTEM account via node-windows.
 * Reads device list from: C:\ProgramData\DibbyWemoManager\devices.json
 * Reads DWM rules from:   C:\ProgramData\DibbyWemoManager\dwm-rules.json
 * (both written by the Electron app after each save/discovery)
 *
 * Fires SetBinaryState SOAP commands at scheduled times, replacing the
 * dead Belkin cloud rule engine.
 *
 * Rule types handled:
 *  - Schedule / Countdown / Away  → from Wemo device firmware (RULEDEVICES table)
 *  - AlwaysOn                     → health monitor enforces ON every 10 s
 *  - Trigger                      → if device A changes state, fire action on device B
 */

const path = require('path');
const fs   = require('fs');
const wemo = require('./wemo');

// ProgramData on Windows is writable by the LocalSystem account the service
// runs under, and also by the user account the desktop app runs under, so the
// two processes can read each other's state without privilege gymnastics.
const DATA_DIR      = path.join('C:\\ProgramData', 'DibbyWemoManager');
const DEVICES_FILE  = path.join(DATA_DIR, 'devices.json');
const DWM_FILE      = path.join(DATA_DIR, 'dwm-rules.json');
const LOG_FILE      = path.join(DATA_DIR, 'scheduler.log');
const HK_BRIDGE_DIR = path.join(DATA_DIR, 'homekit-bridge');
const HK_PREFS_FILE = path.join(DATA_DIR, 'homekit-bridge-prefs.json');
const HK_STATUS_FILE= path.join(HK_BRIDGE_DIR, 'status.json');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB cap

const HK_STATUS_REFRESH_MS = 30_000;

const HEALTH_POLL_MS   = 10_000;   // poll devices every 10 s
const CATCHUP_WINDOW_S = 10 * 60;  // catch-up missed rules from last 10 min

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
        const old = fs.readFileSync(LOG_FILE, 'utf8');
        fs.writeFileSync(LOG_FILE, old.slice(-512 * 1024) + '\n', 'utf8');
      }
    } catch { /* first run */ }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* ignore write errors */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsToWemoDayId(jsDay) { return jsDay === 0 ? 7 : jsDay; }

// Belkin firmware DayID → Dibby internal day numbers (1=Mon..7=Sun).
// 0=Daily, 1=Sun, 2-7=Mon-Sat, 8=Weekdays, 9=Weekends.
const BELKIN_TO_DIBBY = {
  0: [1, 2, 3, 4, 5, 6, 7],
  1: [7], 2: [1], 3: [2], 4: [3], 5: [4], 6: [5], 7: [6],
  8: [1, 2, 3, 4, 5],
  9: [6, 7],
};
function wemoUtilDeviceDaysToDibby(rawDayId) {
  return BELKIN_TO_DIBBY[Number(rawDayId)] || [];
}

function secondsFromMidnight(d) { return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); }
function secsToHHMM(s) {
  const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ── State ─────────────────────────────────────────────────────────────────────

let deviceMap     = new Map();   // udn → {host, port}
let schedule      = [];          // pre-computed schedule entries from Wemo firmware
let firedToday    = new Set();
let lastDate      = null;
let tickTimer     = null;
let healthTimer   = null;
let dwmRules      = [];          // DWM rules from shared JSON file

// Health monitor state
let deviceHealth  = new Map();   // 'host:port' → true|false
let triggerStates = new Map();   // 'host:port' → last boolean

// ── Device list ───────────────────────────────────────────────────────────────

function loadDevices() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    deviceMap.clear();
    for (const d of (raw.devices || raw)) {
      if (d.udn && d.host && d.port) deviceMap.set(d.udn, { host: d.host, port: d.port, name: d.friendlyName ?? d.host });
    }
    log(`Loaded ${deviceMap.size} device(s) from ${DEVICES_FILE}`);
  } catch (e) {
    log(`Could not load devices file: ${e.message} — will retry`);
  }
}

// ── DWM rules ─────────────────────────────────────────────────────────────────

function loadDwmRules() {
  try {
    const raw = JSON.parse(fs.readFileSync(DWM_FILE, 'utf8'));
    dwmRules = Array.isArray(raw) ? raw : (raw.rules ?? []);
    log(`Loaded ${dwmRules.length} DWM rule(s) from ${DWM_FILE}`);
  } catch (e) {
    dwmRules = [];
    if (e.code !== 'ENOENT') log(`Could not load DWM rules: ${e.message}`);
  }
}

// ── Schedule loading from Wemo firmware ──────────────────────────────────────

async function loadSchedule() {
  if (deviceMap.size === 0) { log('No devices — skipping schedule load'); return; }

  const entries = [];
  for (const [udn, { host, port }] of deviceMap) {
    try {
      const db = await wemo.dumpDb(host, port);
      const rdRows   = db.data['RULEDEVICES']  || [];
      const tdRows   = db.data['TARGETDEVICES'] || [];
      const ruleRows = db.data['RULES']         || [];

      const ruleNames = {};
      for (const r of ruleRows) ruleNames[String(r.RuleID ?? r.ruleid)] = String(r.Name ?? r.name ?? '');

      for (const rd of rdRows) {
        const ruleId      = Number(rd.RuleID    ?? rd.ruleid    ?? 0);
        const deviceId    = String(rd.DeviceID  ?? rd.deviceid  ?? '');
        const rawDayId    = Number(rd.DayID     ?? rd.dayid     ?? 0);
        const startSecs   = Number(rd.StartTime ?? rd.starttime ?? -1);
        const endSecs     = Number(rd.EndTime   ?? rd.endtime   ?? -1);
        const startAction = Number(rd.StartAction ?? rd.startaction ?? 1);
        const endAction   = Number(rd.EndAction   ?? rd.endaction   ?? -1);
        const ruleName    = ruleNames[String(ruleId)] || `Rule ${ruleId}`;

        if (startSecs < 0) continue;

        // Translate Belkin device DayID → Dibby internal day numbers (1=Mon..7=Sun).
        // One Belkin row may expand into multiple Dibby days (Daily=0, Weekdays=8,
        // Weekends=9). Emit a separate scheduler entry for each expanded day so
        // todayId comparisons in the firing loop use Dibby's convention uniformly.
        const expandedDays = wemoUtilDeviceDaysToDibby(rawDayId);
        if (!expandedDays.length) continue;

        const target = deviceMap.get(deviceId) || { host, port };

        for (const dayId of expandedDays) {
          const dedup  = `${ruleId}-${dayId}-${startSecs}-${deviceId}`;

          entries.push({ ruleId, ruleName, dayId, targetSecs: startSecs, action: startAction,
            host: target.host, port: target.port, dedup: `${dedup}-start` });

          if (endSecs >= 0 && endAction !== -1) {
            entries.push({ ruleId, ruleName, dayId, targetSecs: endSecs, action: endAction,
              host: target.host, port: target.port, dedup: `${dedup}-end` });
          }

          // Also add TARGETDEVICES rows
          const targets = tdRows
            .filter((t) => Number(t.RuleID ?? t.ruleid) === ruleId)
            .map((t) => String(t.DeviceID ?? t.deviceid))
            .filter(Boolean);
          for (const tid of targets) {
            const tdTarget = deviceMap.get(tid);
            if (!tdTarget) continue;
            const tdedup = `${ruleId}-${dayId}-${startSecs}-${tid}`;
            entries.push({ ruleId, ruleName, dayId, targetSecs: startSecs, action: startAction,
              host: tdTarget.host, port: tdTarget.port, dedup: `${tdedup}-start` });
            if (endSecs >= 0 && endAction !== -1) {
              entries.push({ ruleId, ruleName, dayId, targetSecs: endSecs, action: endAction,
                host: tdTarget.host, port: tdTarget.port, dedup: `${tdedup}-end` });
            }
          }
        }
      }
    } catch (e) {
      log(`Failed to load rules from ${host}:${port}: ${e.message}`);
    }
  }

  const seen = new Set();
  schedule = entries.filter((e) => { if (seen.has(e.dedup)) return false; seen.add(e.dedup); return true; });
  log(`Firmware schedule loaded: ${schedule.length} entries across ${deviceMap.size} device(s)`);
}

// ── Catch-up missed rules ─────────────────────────────────────────────────────

function catchUpMissedRules() {
  if (!schedule.length) return;
  const now     = new Date();
  const nowSecs = secondsFromMidnight(now);
  const todayId = jsToWemoDayId(now.getDay());
  let   count   = 0;

  for (const entry of schedule) {
    if (entry.dayId !== todayId) continue;
    const age = nowSecs - entry.targetSecs;
    if (age <= 0 || age > CATCHUP_WINDOW_S) continue;
    if (firedToday.has(entry.dedup)) continue;
    firedToday.add(entry.dedup);
    count++;
    fire(entry);  // don't await — fire-and-forget on startup
  }
  if (count) log(`Catch-up: fired ${count} missed entries`);
}

// ── Fire ──────────────────────────────────────────────────────────────────────

async function fire(entry) {
  const on = entry.action === 1;
  try {
    await wemo.setBinaryState(entry.host, entry.port, on);
    log(`✅ Fired: "${entry.ruleName}" → ${on ? 'ON' : 'OFF'} (${entry.host})`);
  } catch (e) {
    log(`❌ Fire failed: "${entry.ruleName}" → ${e.message}`);
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

const TICK_MS    = 30_000;
const WINDOW_SEC = 35;

async function tick() {
  const now     = new Date();
  const dateStr = now.toDateString();
  const nowSecs = secondsFromMidnight(now);
  const dayId   = jsToWemoDayId(now.getDay());

  if (dateStr !== lastDate) {
    log(`New day (${dateStr}), resetting fired set`);
    firedToday.clear();
    lastDate = dateStr;
    loadDevices();
    loadDwmRules();
    await loadSchedule();
  }

  const due = schedule.filter((e) =>
    e.dayId === dayId &&
    e.targetSecs >= nowSecs &&
    e.targetSecs < nowSecs + WINDOW_SEC &&
    !firedToday.has(e.dedup)
  );

  for (const e of due) {
    firedToday.add(e.dedup);
    await fire(e);
  }
}

// ── Health monitor ────────────────────────────────────────────────────────────

async function pollDeviceHealth() {
  // Build device map from DWM rules
  const healthMap     = new Map(); // 'host:port' → { host, port, name }
  const alwaysOnSet   = new Set();
  const triggerSrcSet = new Set();

  const addDev = (td) => {
    if (!td?.host || !td?.port) return;
    const key = `${td.host}:${td.port}`;
    if (!healthMap.has(key))
      healthMap.set(key, { host: td.host, port: Number(td.port), name: td.name ?? td.host });
    return key;
  };

  for (const rule of dwmRules) {
    if (!rule.enabled) continue;
    if (rule.type === 'Trigger') {
      const k = addDev(rule.triggerDevice);
      if (k) triggerSrcSet.add(k);
      for (const td of (rule.actionDevices ?? [])) addDev(td);
      continue;
    }
    for (const td of (rule.targetDevices ?? [])) {
      const k = addDev(td);
      if (k && rule.type === 'AlwaysOn') alwaysOnSet.add(k);
    }
  }

  for (const [key, dev] of healthMap) {
    const wasOnline = deviceHealth.get(key);
    try {
      const isOn = await wemo.getBinaryState(dev.host, dev.port);
      deviceHealth.set(key, true);

      if (wasOnline === false) {
        log(`🟢 ${dev.name} came back online`);
        // Enforce most recent schedule state
        await enforceCurrentState(dev);
      } else if (wasOnline === undefined) {
        log(`🟢 ${dev.name} online`);
      }

      // AlwaysOn enforcement
      if (alwaysOnSet.has(key) && !isOn) {
        try {
          await wemo.setBinaryState(dev.host, dev.port, true);
          log(`🔒 [always-on] ${dev.name} was OFF — turned ON ✓`);
        } catch (e) {
          log(`❌ [always-on] ${dev.name} turn-ON failed: ${e.message}`);
        }
      }

      // Trigger detection
      if (triggerSrcSet.has(key)) {
        const prevState = triggerStates.get(key);
        triggerStates.set(key, isOn);
        if (prevState !== undefined && prevState !== isOn) {
          await fireTriggerRules(key, isOn);
        }
      }

    } catch (e) {
      deviceHealth.set(key, false);
      if (wasOnline !== false) {
        log(`🔴 ${dev.name} unreachable: ${e.message}`);
      }
    }
  }

  healthTimer = setTimeout(pollDeviceHealth, HEALTH_POLL_MS);
}

async function enforceCurrentState(dev) {
  const now     = new Date();
  const nowSecs = secondsFromMidnight(now);
  const todayId = jsToWemoDayId(now.getDay());

  let best = null;
  for (const entry of schedule) {
    if (entry.host !== dev.host) continue;
    if (entry.dayId !== todayId) continue;
    if (entry.targetSecs > nowSecs) continue;
    if (!best || entry.targetSecs > best.targetSecs) best = entry;
  }

  if (!best) return;
  const wantOn = best.action === 1;
  try {
    await wemo.setBinaryState(dev.host, dev.port, wantOn);
    log(`🔄 [enforce] "${best.ruleName}" → ${wantOn ? 'ON' : 'OFF'} restored on ${dev.name} ✓`);
  } catch (e) {
    log(`❌ [enforce] "${best.ruleName}" restore FAILED on ${dev.name}: ${e.message}`);
  }
}

async function fireTriggerRules(sourceKey, isOn) {
  const rules = dwmRules.filter((r) =>
    r.enabled &&
    r.type === 'Trigger' &&
    r.triggerDevice?.host &&
    `${r.triggerDevice.host}:${r.triggerDevice.port}` === sourceKey
  );

  for (const rule of rules) {
    const matches =
      rule.triggerEvent === 'any' ||
      (rule.triggerEvent === 'on'  &&  isOn) ||
      (rule.triggerEvent === 'off' && !isOn);
    if (!matches) continue;

    let targetOn;
    if      (rule.action === 'on')       targetOn = true;
    else if (rule.action === 'off')      targetOn = false;
    else if (rule.action === 'mirror')   targetOn = isOn;
    else if (rule.action === 'opposite') targetOn = !isOn;
    else continue;

    for (const dev of (rule.actionDevices ?? [])) {
      if (!dev.host || !dev.port) continue;
      try {
        await wemo.setBinaryState(dev.host, Number(dev.port), targetOn);
        log(`⚡ [trigger] "${rule.name}" → ${dev.name ?? dev.host} ${targetOn ? 'ON' : 'OFF'} ✓`);
      } catch (e) {
        log(`❌ [trigger] "${rule.name}" → ${dev.name ?? dev.host} FAILED: ${e.message}`);
      }
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function start() {
  log('=== Dibby Wemo Scheduler service starting ===');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  try { fs.mkdirSync(HK_BRIDGE_DIR, { recursive: true }); } catch { /* exists */ }

  loadDevices();
  loadDwmRules();
  await loadSchedule();
  catchUpMissedRules();

  // ── HomeKit bridge — runs HEADLESS in this service so users with no
  //    always-on PC can still expose every Wemo to Apple Home. The bridge
  //    is a separate process from the Electron desktop app; the desktop UI
  //    only displays its status (read from HK_STATUS_FILE).
  await startHomeKitBridge();

  // Watch devices file for changes (new discoveries)
  try {
    fs.watch(DEVICES_FILE, { persistent: false }, () => {
      log('Devices file changed — reloading');
      setTimeout(async () => { loadDevices(); await loadSchedule(); }, 2000);
    });
  } catch { /* file may not exist yet */ }

  // Watch DWM rules file for changes (rules edited in Electron app)
  try {
    fs.watch(DWM_FILE, { persistent: false }, () => {
      log('DWM rules file changed — reloading');
      setTimeout(() => { loadDwmRules(); }, 1000);
    });
  } catch { /* file may not exist yet */ }

  await tick();
  tickTimer = setInterval(async () => { try { await tick(); } catch (e) { log(`Tick error: ${e.message}`); } }, TICK_MS);

  // Start health monitor after 15 s so startup can complete first
  healthTimer = setTimeout(pollDeviceHealth, 15_000);

  log(`Scheduler running. Tick interval: ${TICK_MS / 1000}s, Health poll: ${HEALTH_POLL_MS / 1000}s`);
}

// ── HomeKit bridge integration ────────────────────────────────────────────────
//
// The bridge module is loaded lazily so the service still starts even if
// `hap-nodejs` is missing (e.g. dev environments that haven't run npm install
// against the desktop workspace yet).
let _hkBridgeMod   = null;
let _hkBridgeOn    = false;
let _hkStatusTimer = null;

async function startHomeKitBridge() {
  if (_hkBridgeOn) return;
  // Honour the user's preference: if the desktop app set `autoStart: false`
  // in HK_PREFS_FILE, leave the bridge off — desktop UI can flip it on later.
  let auto = true;  // default ON in the headless service so v2.0.18 "just works"
  try {
    const prefs = JSON.parse(fs.readFileSync(HK_PREFS_FILE, 'utf8'));
    if (typeof prefs.autoStart === 'boolean') auto = prefs.autoStart;
  } catch { /* default = on */ }
  if (!auto) { log('HomeKit bridge auto-start disabled by user preference'); return; }

  try {
    _hkBridgeMod = require('./homekit-bridge');
  } catch (e) {
    log(`HomeKit bridge not available: ${e.message}`);
    return;
  }

  try {
    await _hkBridgeMod.start({
      storagePath: HK_BRIDGE_DIR,
      wemoClient:  wemo,
      log:         (m) => log('[hk-bridge] ' + String(m).replace(/^\[hk-bridge\]\s*/, '')),
    });
    _hkBridgeMod.syncDevices(_devicesArrayForBridge());
    _hkBridgeOn = true;
    log('HomeKit bridge started — Apple Home users: pair via Settings → HomeKit Bridge in the desktop app');
  } catch (e) {
    log(`HomeKit bridge start failed: ${e.message}`);
    return;
  }

  // Republish bridge accessory list whenever devices file changes
  try {
    fs.watch(DEVICES_FILE, { persistent: false }, () => {
      setTimeout(() => {
        if (!_hkBridgeOn) return;
        try { _hkBridgeMod.syncDevices(_devicesArrayForBridge()); } catch (e) { log('hk-bridge sync err: ' + e.message); }
      }, 2500);
    });
  } catch { /* file may not exist yet */ }

  // Periodic status snapshot so the desktop UI can show pincode + QR
  // without running the bridge itself.
  const writeStatus = async () => {
    try {
      const s = await _hkBridgeMod.getStatus();
      const out = {
        ...s,
        host:        'service',
        updatedAt:   new Date().toISOString(),
      };
      fs.writeFileSync(HK_STATUS_FILE, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) { /* non-critical */ }
  };
  await writeStatus();
  _hkStatusTimer = setInterval(writeStatus, HK_STATUS_REFRESH_MS);
}

async function stopHomeKitBridge() {
  if (_hkStatusTimer) { clearInterval(_hkStatusTimer); _hkStatusTimer = null; }
  if (_hkBridgeOn && _hkBridgeMod) {
    try { await _hkBridgeMod.stop(); } catch { /* ignore */ }
    _hkBridgeOn = false;
  }
  // Mark status file so desktop knows the bridge isn't running
  try {
    fs.writeFileSync(HK_STATUS_FILE, JSON.stringify({
      running: false, host: 'service', updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function _devicesArrayForBridge() {
  return [...deviceMap.entries()].map(([udn, dev]) => ({
    udn,
    host:         dev.host,
    port:         dev.port,
    friendlyName: dev.name,
    name:         dev.name,
  }));
}

start().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });

async function _gracefulStop(reason) {
  log(`Stopping (${reason}).`);
  clearInterval(tickTimer);
  if (healthTimer) clearTimeout(healthTimer);
  try { await stopHomeKitBridge(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT',  () => { _gracefulStop('SIGINT'); });
process.on('SIGTERM', () => { _gracefulStop('SIGTERM'); });
