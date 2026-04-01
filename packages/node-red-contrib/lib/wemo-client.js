'use strict';

/**
 * Wemo SOAP client + SSDP discovery + rules CRUD.
 *
 * Self-contained: no Electron, no store dependency.
 * Adapted from apps/desktop/src/main/wemo.js — same protocol, same SQL schema.
 */

const dgram  = require('dgram');
const path   = require('path');
const http   = require('http');
const axios  = require('axios');
const AdmZip = require('adm-zip');
const { parseStringPromise } = require('xml2js');
const { create } = require('xmlbuilder2');

// Core helpers — bundled locally so the plugin is self-contained
const { namesToDayNumbers, timeToSecs } = require('./types');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_KEEPALIVE  = new http.Agent({ keepAlive: false });
const WEMO_PORTS    = [49153, 49152, 49154, 49155, 49156];
const BE_SVC        = 'urn:Belkin:service:basicevent:1';
const BE_URL        = '/upnp/control/basicevent1';
const TS_SVC        = 'urn:Belkin:service:timesync:1';
const TS_URL        = '/upnp/control/timesync1';
const RULES_SVC     = 'urn:Belkin:service:rules:1';
const RULES_URL     = '/upnp/control/rules1';

const RULE_TYPE_TO_DEVICE = {
  'Schedule':  'Time Interval',
  'Countdown': 'Countdown Rule',
  'Away':      'Away Mode',
};

// ---------------------------------------------------------------------------
// sql.js (WASM SQLite)
// ---------------------------------------------------------------------------

let SQL = null;

async function getSql(log) {
  if (!SQL) {
    const fs = require('fs');
    const initSqlJs = require('sql.js');

    const candidates = [
      path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(__dirname, 'sql-wasm.wasm'),
    ];

    let wasmBinary = null;
    for (const p of candidates) {
      try { wasmBinary = fs.readFileSync(p); break; } catch { /* try next */ }
    }
    if (!wasmBinary) {
      throw new Error(`sql-wasm.wasm not found. Tried:\n${candidates.join('\n')}`);
    }
    SQL = await initSqlJs({ wasmBinary });
  }
  return SQL;
}

// ---------------------------------------------------------------------------
// SOAP helpers
// ---------------------------------------------------------------------------

async function soapRequest(host, port, controlURL, serviceType, action, args = {}, timeoutMs = 10_000) {
  const url  = `http://${host}:${port}${controlURL}`;
  const root = create({ version: '1.0', encoding: 'utf-8' })
    .ele('s:Envelope', { 'xmlns:s': 'http://schemas.xmlsoap.org/soap/envelope/', 's:encodingStyle': 'http://schemas.xmlsoap.org/soap/encoding/' })
    .ele('s:Body')
    .ele(`u:${action}`, { [`xmlns:u`]: serviceType });
  for (const [k, v] of Object.entries(args)) root.ele(k).txt(v);
  const xml = root.doc().end({ headless: false });

  const res = await axios.post(url, xml, {
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPACTION': `"${serviceType}#${action}"`,
      'Connection': 'close',
    },
    httpAgent: NO_KEEPALIVE,
    timeout: timeoutMs,
  });
  const parsed = await parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: true });
  const body = parsed['s:Envelope']['s:Body'];
  return body[`u:${action}Response`] ?? body;
}

async function soapWithFallback(host, port, controlURL, serviceType, action, args = {}) {
  const portsToTry = [port, ...WEMO_PORTS.filter((p) => p !== port)];
  let lastErr = null;
  for (const tryPort of portsToTry) {
    try {
      return await soapRequest(host, tryPort, controlURL, serviceType, action, args);
    } catch (err) {
      lastErr = err;
      const isConn = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isConn) throw err;
    }
  }
  throw lastErr || new Error(`${host}: all ports failed for ${action}`);
}

// ---------------------------------------------------------------------------
// Device control
// ---------------------------------------------------------------------------

async function getBinaryState(host, port) {
  const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetBinaryState');
  const raw = String(res['BinaryState'] ?? '0');
  return raw === '1' || raw === '8';
}

async function setBinaryState(host, port, on) {
  await soapWithFallback(host, port, BE_URL, BE_SVC, 'SetBinaryState', { BinaryState: on ? '1' : '0' });
}

// ---------------------------------------------------------------------------
// Device info
// ---------------------------------------------------------------------------

function resolveProductModel(udn, deviceType, firmwareSuffix) {
  const udnBase   = String(udn || '').replace(/^uuid:/i, '');
  const parts     = udnBase.split('-');
  const udnPrefix = parts.slice(0, 2).join('-').toLowerCase();
  const udnType   = parts[0].toLowerCase();
  const fwSuffix  = String(firmwareSuffix || '').toUpperCase();
  const dt        = String(deviceType || '').toLowerCase();

  if (udnPrefix === 'lightswitch-3_0')  return 'Wemo 3-Way Smart Switch (WLS0403)';
  if (udnPrefix === 'lightswitch-2_0')  return 'Wemo Light Switch (WLS040)';
  if (udnPrefix === 'lightswitch-1_0') {
    if (fwSuffix.includes('OWRT-LS'))   return 'Wemo Light Switch (F7C030)';
    return 'Wemo Light Switch (WLS040)';
  }
  if (udnType === 'dimmer' || dt.includes('dimmer') || fwSuffix.includes('WDS'))
    return 'Wemo WiFi Smart Dimmer (WDS060)';
  if (udnType === 'insight' || dt.includes('insight')) return 'Wemo Insight Smart Plug (F7C029)';
  if (udnPrefix === 'socket-2_0')       return 'Wemo Mini Smart Plug (F7C063)';
  if (udnPrefix === 'socket-1_0') {
    if (fwSuffix.includes('OWRT-SNS'))  return 'Wemo Switch (F7C027)';
    return 'Wemo Smart Plug';
  }
  if (udnType === 'socket')             return 'Wemo Smart Plug';
  return null;
}

async function getDeviceInfo(host, port) {
  const results = {};
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetFriendlyName');
    results.friendlyName = String(res['FriendlyName'] ?? '').trim();
  } catch { results.friendlyName = null; }

  try {
    const sx = await axios.get(`http://${host}:${port}/setup.xml`, { timeout: 5000, httpAgent: NO_KEEPALIVE });
    const fwMatch  = sx.data.match(/<firmwareVersion>([^<]+)<\/firmwareVersion>/i);
    const udnMatch = sx.data.match(/<UDN>([^<]+)<\/UDN>/i);
    const dtMatch  = sx.data.match(/<deviceType>([^<]+)<\/deviceType>/i);
    const mdMatch  = sx.data.match(/<modelDescription>([^<]+)<\/modelDescription>/i);
    results.firmwareVersion  = fwMatch ? fwMatch[1].trim() : null;
    results.modelDescription = mdMatch ? mdMatch[1].trim() : null;
    if (udnMatch) {
      results.udn = udnMatch[1].trim();
      const fw = results.firmwareVersion || '';
      const fwSuffix = fw.split('PVT-').pop() || '';
      results.productModel = resolveProductModel(results.udn, dtMatch ? dtMatch[1] : '', fwSuffix);
    }
  } catch { /* non-fatal */ }
  return results;
}

// ---------------------------------------------------------------------------
// SSDP Discovery
// ---------------------------------------------------------------------------

function discoverDevices(timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const SSDP_ADDR   = '239.255.255.250';
    const SSDP_PORT   = 1900;
    const M_SEARCH    = [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 3',
      'ST: urn:Belkin:device:**',
      '', '',
    ].join('\r\n');

    const found = new Map();
    const sock  = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', async (msg) => {
      const text     = msg.toString();
      const locMatch = text.match(/LOCATION:\s*(http:\/\/([^:]+):(\d+)\/setup\.xml)/i);
      if (!locMatch) return;
      const [, , ip, portStr] = locMatch;
      const port = parseInt(portStr, 10);
      const key  = `${ip}:${port}`;
      if (found.has(key)) return;
      found.set(key, { host: ip, port, discovering: true });
      try {
        const info = await getDeviceInfo(ip, port);
        found.set(key, { host: ip, port, ...info });
      } catch { /* keep partial entry */ }
    });

    sock.bind(() => {
      const buf = Buffer.from(M_SEARCH);
      sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
    });

    setTimeout(() => {
      try { sock.close(); } catch { /* ignore */ }
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Rules — fetch (ZIP + SQLite)
// ---------------------------------------------------------------------------

async function fetchRules(host, port) {
  const res = await soapWithFallback(host, port, RULES_URL, RULES_SVC, 'FetchRules');
  const version = String(res['ruleDbVersion'] ?? '0');
  const dbUrl   = String(res['ruleDbPath'] ?? '');
  if (!dbUrl) throw new Error('FetchRules returned no ruleDbPath');

  const dlRes = await axios.get(dbUrl, { responseType: 'arraybuffer', timeout: 15_000 });
  const zip   = new AdmZip(Buffer.from(dlRes.data));
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('.db'));
  if (!entry) throw new Error('No .db file in rules ZIP');

  const SQL = await getSql();
  const db  = new SQL.Database(entry.getData());

  const rules       = _dbQuery(db, 'SELECT * FROM RULES');
  const ruleDevices = _dbQuery(db, 'SELECT * FROM RULEDEVICES');
  const targets     = _dbQuery(db, 'SELECT * FROM TARGETDEVICES');
  db.close();

  return { version, rules, ruleDevices, targets };
}

function _dbQuery(db, sql) {
  const rows = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ---------------------------------------------------------------------------
// Rules — store (ZIP + CDATA encode)
// ---------------------------------------------------------------------------

async function storeRules(host, port, version, dbBuffer) {
  const zip = new AdmZip();
  zip.addFile('temppluginRules.db', dbBuffer);
  const b64 = zip.toBuffer().toString('base64');

  // CRITICAL: body must be entity-encoded CDATA — hand-crafted XML only
  const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:StoreRules xmlns:u="urn:Belkin:service:rules:1">
      <ruleDbVersion>${version}</ruleDbVersion>
      <StartSync>NOSYNC</StartSync>
      <ruleDbBody>&lt;![CDATA[${b64}]]&gt;</ruleDbBody>
    </u:StoreRules>
  </s:Body>
</s:Envelope>`;

  const url = `http://${host}:${port}${RULES_URL}`;
  const res = await axios.post(url, soapXml, {
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPACTION': `"${RULES_SVC}#StoreRules"`,
      'Connection': 'close',
    },
    httpAgent: NO_KEEPALIVE,
    timeout: 20_000,
  });
  if (String(res.data).includes('failed')) throw new Error('StoreRules: device returned failure');
}

// ---------------------------------------------------------------------------
// Rules — create / update / delete / toggle
// ---------------------------------------------------------------------------

async function createRule(host, port, ruleData) {
  const SQL    = await getSql();
  const { version, rules, ruleDevices, targets } = await fetchRules(host, port);
  const db     = new SQL.Database();
  _createSchema(db);
  for (const r of rules)       _insertRule(db, r);
  for (const r of ruleDevices) _insertRuleDevice(db, r);
  for (const r of targets)     _insertTargetDevice(db, r);

  const newId  = _nextRuleId(db);
  _insertNewRule(db, newId, ruleData);

  const buf    = Buffer.from(db.export());
  db.close();
  await storeRules(host, port, String(parseInt(version, 10) + 2), buf);
  return newId;
}

async function updateRule(host, port, ruleId, ruleData) {
  const SQL    = await getSql();
  const { version, rules, ruleDevices, targets } = await fetchRules(host, port);
  const db     = new SQL.Database();
  _createSchema(db);
  for (const r of rules)       _insertRule(db, r);
  for (const r of ruleDevices) _insertRuleDevice(db, r);
  for (const r of targets)     _insertTargetDevice(db, r);

  db.run('DELETE FROM RULES WHERE RuleID = ?', [String(ruleId)]);
  db.run('DELETE FROM RULEDEVICES WHERE RuleID = ?', [String(ruleId)]);
  db.run('DELETE FROM TARGETDEVICES WHERE RuleID = ?', [String(ruleId)]);
  _insertNewRule(db, ruleId, ruleData);

  const buf    = Buffer.from(db.export());
  db.close();
  await storeRules(host, port, String(parseInt(version, 10) + 2), buf);
}

async function deleteRule(host, port, ruleId) {
  const SQL    = await getSql();
  const { version, rules, ruleDevices, targets } = await fetchRules(host, port);
  const db     = new SQL.Database();
  _createSchema(db);
  for (const r of rules)       _insertRule(db, r);
  for (const r of ruleDevices) _insertRuleDevice(db, r);
  for (const r of targets)     _insertTargetDevice(db, r);

  db.run('DELETE FROM RULES WHERE RuleID = ?', [String(ruleId)]);
  db.run('DELETE FROM RULEDEVICES WHERE RuleID = ?', [String(ruleId)]);
  db.run('DELETE FROM TARGETDEVICES WHERE RuleID = ?', [String(ruleId)]);

  const buf    = Buffer.from(db.export());
  db.close();
  await storeRules(host, port, String(parseInt(version, 10) + 2), buf);
}

async function toggleRule(host, port, ruleId, enabled) {
  const SQL    = await getSql();
  const { version, rules, ruleDevices, targets } = await fetchRules(host, port);
  const db     = new SQL.Database();
  _createSchema(db);
  for (const r of rules)       _insertRule(db, r);
  for (const r of ruleDevices) _insertRuleDevice(db, r);
  for (const r of targets)     _insertTargetDevice(db, r);

  db.run('UPDATE RULES SET State = ? WHERE RuleID = ?', [enabled ? '1' : '0', String(ruleId)]);

  const buf    = Buffer.from(db.export());
  db.close();
  await storeRules(host, port, String(parseInt(version, 10) + 2), buf);
}

// ---------------------------------------------------------------------------
// SQLite helpers (schema + insert helpers)
// ---------------------------------------------------------------------------

function _createSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS RULES (
    RuleID TEXT, Name TEXT, Type TEXT, RuleOrder INTEGER,
    StartDate TEXT DEFAULT '12201982', EndDate TEXT DEFAULT '07301982',
    State TEXT DEFAULT '1', Sync TEXT DEFAULT 'NOSYNC'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS RULEDEVICES (
    RuleDevicePK INTEGER PRIMARY KEY AUTOINCREMENT,
    RuleID TEXT, DeviceID TEXT, GroupID INTEGER, DayID INTEGER,
    StartTime INTEGER, RuleDuration INTEGER, StartAction INTEGER, EndAction INTEGER,
    SensorDuration INTEGER, Type INTEGER, Value INTEGER, Level INTEGER,
    ZBCapabilityStart TEXT, ZBCapabilityEnd TEXT,
    OnModeOffset INTEGER, OffModeOffset INTEGER, CountdownTime INTEGER, EndTime INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS TARGETDEVICES (
    TargetDevicesPK INTEGER PRIMARY KEY AUTOINCREMENT,
    RuleID TEXT, DeviceID TEXT, DeviceIndex INTEGER
  )`);
}

function _insertRule(db, r) {
  db.run(
    'INSERT INTO RULES (RuleID,Name,Type,RuleOrder,StartDate,EndDate,State,Sync) VALUES (?,?,?,?,?,?,?,?)',
    [r.RuleID, r.Name, r.Type, r.RuleOrder, r.StartDate ?? '12201982', r.EndDate ?? '07301982', r.State ?? '1', r.Sync ?? 'NOSYNC']
  );
}

function _insertRuleDevice(db, r) {
  db.run(
    `INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,
      SensorDuration,Type,Value,Level,ZBCapabilityStart,ZBCapabilityEnd,
      OnModeOffset,OffModeOffset,CountdownTime,EndTime)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.RuleID, r.DeviceID, r.GroupID ?? 0, r.DayID, r.StartTime, r.RuleDuration ?? 0,
     r.StartAction, r.EndAction ?? -1, r.SensorDuration ?? 0, r.Type ?? 0, r.Value ?? 0,
     r.Level ?? 0, r.ZBCapabilityStart ?? '', r.ZBCapabilityEnd ?? '',
     r.OnModeOffset ?? 0, r.OffModeOffset ?? 0, r.CountdownTime ?? 0, r.EndTime ?? -1]
  );
}

function _insertTargetDevice(db, r) {
  db.run(
    'INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)',
    [r.RuleID, r.DeviceID, r.DeviceIndex ?? 0]
  );
}

function _nextRuleId(db) {
  const stmt = db.prepare('SELECT CAST(MAX(CAST(RuleID AS INTEGER)) AS INTEGER) AS mx FROM RULES');
  let mx = 0;
  if (stmt.step()) { mx = stmt.getAsObject().mx ?? 0; }
  stmt.free();
  return mx + 1;
}

function _insertNewRule(db, ruleId, ruleData) {
  // namesToDayNumbers + timeToSecs already required at top of file
  const days     = ruleData.days ?? [];
  const dayNums  = typeof days[0] === 'string' ? namesToDayNumbers(days) : days.map(Number);
  const devId    = ruleData.deviceId ?? ruleData.udn ?? '';
  const ruleType = RULE_TYPE_TO_DEVICE[ruleData.type] ?? ruleData.type ?? 'Time Interval';

  let startSecs, endSecs;
  if (ruleData.startTime != null) {
    startSecs = typeof ruleData.startTime === 'string'
      ? timeToSecs(ruleData.startTime) : Number(ruleData.startTime);
  } else startSecs = 0;

  if (ruleData.endTime != null && ruleData.endTime !== '') {
    endSecs = typeof ruleData.endTime === 'string'
      ? timeToSecs(ruleData.endTime) : Number(ruleData.endTime);
  } else endSecs = -1;

  const startAction = ruleData.startAction ?? 1;
  const endAction   = ruleData.endAction   ?? -1;

  db.run(
    'INSERT INTO RULES (RuleID,Name,Type,RuleOrder,StartDate,EndDate,State,Sync) VALUES (?,?,?,?,?,?,?,?)',
    [String(ruleId), ruleData.name ?? 'Rule', ruleType, ruleId,
     '12201982', '07301982', ruleData.enabled !== false ? '1' : '0', 'NOSYNC']
  );

  for (const dayId of dayNums) {
    db.run(
      `INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,
        SensorDuration,Type,Value,Level,ZBCapabilityStart,ZBCapabilityEnd,
        OnModeOffset,OffModeOffset,CountdownTime,EndTime)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [String(ruleId), devId, 0, dayId, startSecs, 0,
       startAction, endAction, 0, 0, 0, 0, '', '',
       0, 0, ruleData.countdownTime ?? 0, endSecs]
    );
  }

  db.run(
    'INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)',
    [String(ruleId), devId, 0]
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getBinaryState,
  setBinaryState,
  getDeviceInfo,
  discoverDevices,
  fetchRules,
  storeRules,
  createRule,
  updateRule,
  deleteRule,
  toggleRule,
};
