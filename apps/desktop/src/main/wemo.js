'use strict';

/**
 * Wemo SOAP client + discovery + rules CRUD.
 * Runs in the Electron main process (Node.js).
 */

const dgram  = require('dgram');
const path   = require('path');
const http   = require('http');
const axios  = require('axios');
const sun    = require('./core/sun');
const AdmZip = require('adm-zip');
const { parseStringPromise } = require('xml2js');
const { create } = require('xmlbuilder2');
const { namesToDayNumbers, timeToSecs } = require('./core/types');

// Wemo devices close the socket immediately after each response.
const NO_KEEPALIVE = new http.Agent({ keepAlive: false });

// Map our UI rule types → firmware-expected type strings (confirmed from real device DB)
const RULE_TYPE_TO_DEVICE = {
  'Schedule':  'Time Interval',
  'Countdown': 'Countdown Rule',
  'Away':      'Away Mode',
};

// ---------------------------------------------------------------------------
// Location (for LOCATIONINFO population)
// ---------------------------------------------------------------------------

let _location = null;
function setLocation(loc) { _location = loc; }
exports.setLocation = setLocation;

// ---------------------------------------------------------------------------
// Product model resolution
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
  if (udnType === 'wsp' || fwSuffix.includes('WSP100')) return 'Wemo Smart Plug with Thread (WSP100)';
  if (fwSuffix.includes('WSP080'))      return 'Wemo WiFi Smart Plug (WSP080)';
  if (udnType === 'scene' || dt.includes('scene')) return 'Wemo Stage Scene Controller (WSC010)';
  if (udnType === 'sensor' || dt.includes('sensor')) return 'Wemo Switch + Motion (F5Z0340)';
  if (udnType === 'bridge' || dt.includes('bridge')) return 'Wemo Bridge (F7C074)';
  if (udnType === 'doorbell' || dt.includes('doorbell')) return 'Wemo Smart Video Doorbell (WDC010)';
  return null;
}

// ---------------------------------------------------------------------------
// sql.js (WASM SQLite)
// ---------------------------------------------------------------------------

let SQL = null;
async function getSql() {
  if (!SQL) {
    const fs = require('fs');
    const initSqlJs = require('sql.js');

    // Resolve the WASM binary directly with fs.readFileSync so Emscripten never
    // falls back to fetch() (which hangs in Electron's main process on bad paths).
    // Monorepo: sql.js lives 4 levels above out/main/ in the workspace root.
    // Try several candidate paths so dev and packaged builds both work.
    const candidates = [
      // standalone service bundle: sql-wasm.wasm copied next to the script in resources/
      path.join(__dirname, 'sql-wasm.wasm'),
      // monorepo workspace root (dev + npm run build)
      path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      // local node_modules (if hoisted differently)
      path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      // packaged asar.unpacked
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];

    let wasmBinary = null;
    for (const p of candidates) {
      try { wasmBinary = fs.readFileSync(p); break; } catch { /* try next */ }
    }
    if (!wasmBinary) throw new Error(`sql-wasm.wasm not found. Tried:\n${candidates.join('\n')}`);

    SQL = await initSqlJs({ wasmBinary });
  }
  return SQL;
}

// ---------------------------------------------------------------------------
// SOAP helpers
// ---------------------------------------------------------------------------

const WEMO_PORTS = [49153, 49152, 49154, 49155, 49156];

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

const BE_SVC = 'urn:Belkin:service:basicevent:1';
const BE_URL = '/upnp/control/basicevent1';

async function getBinaryState(host, port) {
  const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetBinaryState');
  const raw = String(res['BinaryState'] ?? '0');
  return raw === '1' || raw === '8';
}
exports.getBinaryState = getBinaryState;

async function setBinaryState(host, port, on) {
  await soapWithFallback(host, port, BE_URL, BE_SVC, 'SetBinaryState', { BinaryState: on ? '1' : '0' });
}
exports.setBinaryState = setBinaryState;

// ---------------------------------------------------------------------------
// Device info & management
// ---------------------------------------------------------------------------

async function getDeviceInfo(host, port) {
  const results = {};
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetMacAddr');
    results.macAddress  = String(res['MacAddr'] ?? '').trim();
    results.serialNumber = String(res['SerialNo'] ?? '').trim();
  } catch { results.macAddress = null; results.serialNumber = null; }

  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetSignalStrength');
    results.signalStrength = String(res['SignalStrength'] ?? '').trim();
  } catch { results.signalStrength = null; }

  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetFriendlyName');
    results.friendlyName = String(res['FriendlyName'] ?? '').trim();
  } catch { results.friendlyName = null; }

  try {
    const sx = await axios.get(`http://${host}:${port}/setup.xml`, { timeout: 5000, httpAgent: NO_KEEPALIVE });
    const fwMatch  = sx.data.match(/<firmwareVersion>([^<]+)<\/firmwareVersion>/i);
    const hwMatch  = sx.data.match(/<hwVersion>([^<]+)<\/hwVersion>/i);
    const udnMatch = sx.data.match(/<UDN>([^<]+)<\/UDN>/i);
    const dtMatch  = sx.data.match(/<deviceType>([^<]+)<\/deviceType>/i);
    const mdMatch  = sx.data.match(/<modelDescription>([^<]+)<\/modelDescription>/i);
    results.firmwareVersion = fwMatch ? fwMatch[1].trim() : null;
    results.hwVersion       = hwMatch ? hwMatch[1].trim() : null;
    results.modelDescription = mdMatch ? mdMatch[1].trim() : null;
    if (udnMatch) {
      const fw = results.firmwareVersion || '';
      const fwSuffix = fw.split('PVT-').pop() || '';
      results.productModel = resolveProductModel(udnMatch[1].trim(), dtMatch ? dtMatch[1] : '', fwSuffix);
    }
  } catch {
    try {
      const res = await soapWithFallback(host, port, '/upnp/control/firmwareupdate1', 'urn:Belkin:service:firmwareupdate:1', 'GetFirmwareVersion');
      results.firmwareVersion = String(res['FirmwareVersion'] ?? '').trim();
    } catch { results.firmwareVersion = null; }
  }
  return results;
}
exports.getDeviceInfo = getDeviceInfo;

const TS_SVC = 'urn:Belkin:service:timesync:1';
const TS_URL = '/upnp/control/timesync1';

async function setDeviceTime(host, port) {
  const now  = Math.floor(Date.now() / 1000);
  const d    = new Date();
  // Standard offset = worst-case (no DST) — Jan or Jul whichever is larger
  const stdOffset = Math.max(
    new Date(d.getFullYear(), 0, 1).getTimezoneOffset(),
    new Date(d.getFullYear(), 6, 1).getTimezoneOffset(),
  );
  const isDst      = d.getTimezoneOffset() < stdOffset;
  const tzOffsetMin = -(d.getTimezoneOffset());
  const localNow    = now + tzOffsetMin * 60;
  await soapWithFallback(host, port, TS_URL, TS_SVC, 'TimeSync', {
    UTC:          String(now),
    TimeZone:     String(tzOffsetMin * 60),
    dst:          isDst ? '1' : '0',
    DstSupported: '1',
  });
  const localISO = new Date(localNow * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return { timestamp: now, localISO };
}
exports.setDeviceTime = setDeviceTime;

async function renameDevice(host, port, newName) {
  await soapWithFallback(host, port, BE_URL, BE_SVC, 'ChangeFriendlyName', { FriendlyName: newName });
}
exports.renameDevice = renameDevice;

async function resetData(host, port)    { await soapWithFallback(host, port, BE_URL, BE_SVC, 'ReSetup', { Reset: '1' }); }
async function factoryReset(host, port) { await soapWithFallback(host, port, BE_URL, BE_SVC, 'ReSetup', { Reset: '2' }); }
async function resetWifi(host, port)    { await soapWithFallback(host, port, BE_URL, BE_SVC, 'ReSetup', { Reset: '5' }); }

// Fetch a device SCPD XML file and return a list of action names.
async function fetchScpdActions(host, port, scpdPath) {
  try {
    const res = await axios.get(`http://${host}:${port}${scpdPath}`, {
      timeout: 5000, httpAgent: NO_KEEPALIVE, headers: { 'Connection': 'close' },
    });
    const parsed = await parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: false });
    const al = parsed?.scpd?.actionList?.action;
    if (!al) return [];
    const actions = Array.isArray(al) ? al : [al];
    return actions.map((a) => String(a.name ?? '')).filter(Boolean);
  } catch { return []; }
}

async function rebootDevice(host, port) {
  // 1. Collect all candidate (controlURL, serviceType, action) triples.
  //    Start with known patterns, then scan every service SCPD for a Reboot action.
  const isConnDrop = (e) =>
    e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED';

  const candidates = [
    { url: BE_URL,                       svc: BE_SVC,                                  action: 'Reboot',  args: {} },
    { url: '/upnp/control/deviceevent1', svc: 'urn:Belkin:service:deviceevent:1',       action: 'Reboot',  args: {} },
    { url: '/upnp/control/manufacture1', svc: 'urn:Belkin:service:manufacture:1',       action: 'Reboot',  args: {} },
    { url: BE_URL,                       svc: BE_SVC,                                  action: 'ReSetup', args: { Reset: '0' } },
  ];

  // Dynamically discover any Reboot/Restart action from setup.xml SCPDs
  try {
    const setup = await fetchSetupXml(host, port);
    if (setup?.services) {
      for (const { serviceType, controlURL, scpdURL } of Object.values(setup.services)) {
        if (!scpdURL) continue;
        const actions = await fetchScpdActions(host, port, scpdURL);
        for (const action of actions) {
          if (/reboot|restart/i.test(action)) {
            // Prepend discovered action so it is tried before the fallbacks
            candidates.unshift({ url: controlURL, svc: serviceType, action, args: {} });
          }
        }
      }
    }
  } catch { /* ignore SCPD lookup errors */ }

  const portsToTry = [port, ...WEMO_PORTS.filter((p) => p !== port)];
  const errors = [];

  for (const { url, svc, action, args } of candidates) {
    for (const tryPort of portsToTry) {
      try {
        await soapRequest(host, tryPort, url, svc, action, args, 5_000);
        return;
      } catch (err) {
        if (isConnDrop(err)) return; // connection dropped — reboot in progress
        if (err.code !== 'ECONNREFUSED') {
          errors.push(`${action}@${tryPort}`);
          break;
        }
      }
    }
  }

  throw new Error(
    'REBOOT_UNSUPPORTED: This device does not support remote reboot via SOAP. ' +
    'To activate new rules cut power at the circuit breaker briefly.'
  );
}
exports.resetData    = resetData;
exports.factoryReset = factoryReset;
exports.resetWifi    = resetWifi;
exports.rebootDevice = rebootDevice;

// ---------------------------------------------------------------------------
// Wi-Fi setup
// ---------------------------------------------------------------------------

const WIFI_SVC = 'urn:Belkin:service:WiFiSetup:1';
const WIFI_URL = '/upnp/control/WiFiSetup1';

async function getApList(host, port) {
  const res = await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'GetApList');
  const raw = String(res['ApList'] ?? '');
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('|');
    return { ssid: parts[0] || '', channel: parts[1] || '', auth: parts[2] || '', encrypt: parts[3] || '', signal: parseInt(parts[4] || '0', 10) || 0 };
  }).sort((a, b) => b.signal - a.signal);
}
exports.getApList = getApList;

async function connectHomeNetwork(host, port, { ssid, auth, password, encrypt, channel }) {
  await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'ConnectHomeNetwork', {
    ssid, auth: auth || 'WPA2PSK', password: password || '', encrypt: encrypt || 'AES', channel: channel || '0',
  });
}
exports.connectHomeNetwork = connectHomeNetwork;

async function getNetworkStatus(host, port) {
  const res = await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'GetNetworkStatus');
  return String(res['NetworkStatus'] ?? '').trim();
}
exports.getNetworkStatus = getNetworkStatus;

async function closeSetup(host, port) {
  await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'CloseSetup');
}
exports.closeSetup = closeSetup;

// ---------------------------------------------------------------------------
// HomeKit
// ---------------------------------------------------------------------------

async function getHomeKitInfo(host, port) {
  const result = { setupDone: null, setupCode: null };
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'getHKSetupState');
    result.setupDone = String(res['HKSetupDone'] ?? '').trim();
  } catch { /* not supported */ }
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetHKSetupInfo');
    result.setupCode = String(res['HKSetupCode'] ?? '').trim();
  } catch { /* not supported */ }
  return result;
}
exports.getHomeKitInfo = getHomeKitInfo;

// ---------------------------------------------------------------------------
// Setup XML parsing
// ---------------------------------------------------------------------------

async function fetchSetupXml(host, port, timeoutMs = 7000) {
  try {
    const response = await axios.get(`http://${host}:${port}/setup.xml`, {
      timeout: timeoutMs, httpAgent: NO_KEEPALIVE, headers: { 'Connection': 'close' },
    });
    const parsed = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: false });
    const root = parsed['root'];
    if (!root) return null;
    const device = root['device'];
    if (!device) return null;

    const friendlyName    = String(device['friendlyName'] ?? 'Wemo Device');
    const serialNumber    = String(device['serialNumber'] ?? '');
    const udn             = String(device['UDN'] ?? `uuid:${host}-${port}`);
    const modelName       = String(device['modelName'] ?? '');
    const modelDescription = String(device['modelDescription'] ?? '');
    const hwVersion       = String(device['hwVersion'] ?? '');
    const firmwareVersion = String(device['firmwareVersion'] ?? '')
      || (response.data.match(/<firmwareVersion>([^<]+)<\/firmwareVersion>/i)?.[1]?.trim() ?? '');
    const fwSuffix   = firmwareVersion.split('PVT-').pop() || '';
    const deviceType = String(device['deviceType'] ?? '');
    const productModel = resolveProductModel(udn, deviceType, fwSuffix);

    const services = {};
    const rawList = device['serviceList'];
    if (rawList) {
      let arr = rawList['service'];
      if (arr && !Array.isArray(arr)) arr = [arr];
      if (Array.isArray(arr)) {
        for (const svc of arr) {
          const st = String(svc['serviceType'] ?? '');
          if (st) services[st] = {
            serviceType: st,
            controlURL: String(svc['controlURL'] ?? ''),
            scpdURL: String(svc['SCPDURL'] ?? ''),
          };
        }
      }
    }

    return {
      friendlyName, serialNumber, udn, modelName, modelDescription, hwVersion,
      firmwareVersion, productModel, host, port, services,
      supportsRules: 'urn:Belkin:service:rules:1' in services,
    };
  } catch {
    return null;
  }
}
exports.fetchSetupXml = fetchSetupXml;

// ---------------------------------------------------------------------------
// SSDP discovery
// ---------------------------------------------------------------------------

let _discoverySocket = null;

function stopDiscovery() {
  try { _discoverySocket?.close(); } catch { /* ok */ }
  _discoverySocket = null;
}
exports.stopDiscovery = stopDiscovery;

async function discoverDevices(timeoutMs = 10_000, manualEntries = []) {
  const found = new Map();

  await new Promise((resolve) => {
    const SSDP_ADDR = '239.255.255.250';
    const SSDP_PORT = 1900;
    const pending = new Set();
    const sockets = [];

    const handleLocation = async (location) => {
      if (pending.has(location)) return;
      pending.add(location);
      try {
        const url = new URL(location);
        const device = await fetchSetupXml(url.hostname, parseInt(url.port, 10) || 49153);
        if (device && !found.has(device.udn)) found.set(device.udn, device);
      } catch { /* ignore */ }
    };

    const onMessage = (msg) => {
      const text = msg.toString();
      if (!text.includes('HTTP/1.1') && !text.includes('NOTIFY')) return;
      for (const line of text.split('\r\n')) {
        if (line.toLowerCase().startsWith('location:')) {
          handleLocation(line.slice(9).trim()).catch(() => {});
        }
      }
    };

    const closeAll = () => {
      for (const s of sockets) { try { s.close(); } catch { /* ok */ } }
      sockets.length = 0;
    };

    // Get all non-internal IPv4 interfaces so we send M-SEARCH on every
    // adapter — critical on Windows where multiple adapters (WiFi, VPN,
    // virtual) cause the OS to pick the wrong one when no interface is specified.
    const { networkInterfaces } = require('os');
    const ifaces = networkInterfaces();
    const localAddrs = [];
    for (const list of Object.values(ifaces)) {
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) localAddrs.push(iface.address);
      }
    }
    if (localAddrs.length === 0) localAddrs.push('0.0.0.0'); // fallback

    let bound = 0;
    const msearchMsg = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:Belkin:device:**\r\n\r\n`
    );

    for (const localAddr of localAddrs) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);
      socket.on('message', onMessage);
      socket.on('error', () => { /* ignore per-socket errors */ });
      socket.bind(0, localAddr, () => {
        try { socket.addMembership(SSDP_ADDR, localAddr); } catch { /* ok */ }
        try { socket.setMulticastInterface(localAddr); } catch { /* ok */ }
        socket.send(msearchMsg, SSDP_PORT, SSDP_ADDR);
        setTimeout(() => { try { socket.send(msearchMsg, SSDP_PORT, SSDP_ADDR); } catch { /* ok */ } }, 2000);
        bound++;
      });
    }

    // Keep legacy _discoverySocket reference pointing to first socket
    _discoverySocket = sockets[0] ?? null;

    setTimeout(() => { closeAll(); resolve(); }, timeoutMs);
  });

  // Probe manual entries
  for (const entry of manualEntries) {
    const portsToTry = entry.port ? [entry.port] : WEMO_PORTS;
    for (const p of portsToTry) {
      const device = await fetchSetupXml(entry.host, p);
      if (device) { found.set(device.udn, device); break; }
    }
  }

  // Subnet probe fallback (when SSDP blocked by firewall/router)
  // Runs when SSDP found nothing — scans ALL local private-IP subnets found
  // on any non-internal adapter (handles 10.x, 172.16-31.x, 192.168.x).
  if (found.size === 0) {
    try {
      const { networkInterfaces } = require('os');
      const ifaces = networkInterfaces();
      const subnets = new Set();
      for (const list of Object.values(ifaces)) {
        for (const iface of list) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          const a = iface.address;
          // Only probe RFC-1918 private ranges
          if (
            a.startsWith('192.168.') ||
            a.startsWith('10.')       ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(a)
          ) {
            const parts = a.split('.');
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
          }
        }
      }
      for (const subnet of subnets) {
        console.log(`[wemo] SSDP returned 0 devices — probing subnet ${subnet}.0/24`);
        const probePromises = [];
        for (let i = 1; i <= 254; i++) {
          const host = `${subnet}.${i}`;
          probePromises.push((async () => {
            for (const p of [49153, 49152, 49154, 49155]) {
              const device = await fetchSetupXml(host, p, 1200);
              if (device) { found.set(device.udn, device); return; }
            }
          })());
        }
        await Promise.allSettled(probePromises);
      }
    } catch (err) {
      console.warn('[wemo] subnet probe failed:', err.message);
    }
  }

  return [...found.values()];
}
exports.discoverDevices = discoverDevices;

// ---------------------------------------------------------------------------
// Rules DB helpers
// ---------------------------------------------------------------------------

async function loadDb(host, port) {
  const portsToTry = [port, ...WEMO_PORTS.filter((p) => p !== port)];
  const MAX_ROUNDS = 2;
  const RETRY_DELAY = 4000;
  let lastErr = null;

  // Discover the actual rules controlURL from setup.xml.
  // Some firmware versions use a non-standard path; never assume /upnp/control/rules1.
  const RULES_SVC = 'urn:Belkin:service:rules:1';
  const FALLBACK_URLS = ['/upnp/control/rules1', '/upnp/control/rulesrules1'];
  let rulesControlURL = FALLBACK_URLS[0];
  try {
    const sx = await axios.get(`http://${host}:${port}/setup.xml`, {
      timeout: 5000, httpAgent: NO_KEEPALIVE, headers: { 'Connection': 'close' },
    });
    const parsed = await parseStringPromise(sx.data, { explicitArray: false, ignoreAttrs: false });
    const svcList = parsed?.root?.device?.serviceList?.service;
    const svcs = Array.isArray(svcList) ? svcList : (svcList ? [svcList] : []);
    const rulesSvc = svcs.find((s) => String(s.serviceType ?? s['_'] ?? '').includes('rules'));
    if (rulesSvc) {
      const cu = String(rulesSvc.controlURL ?? rulesSvc['controlURL'] ?? '').trim();
      if (cu) rulesControlURL = cu;
    }
  } catch { /* use fallback URL */ }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY));

    for (const tryPort of portsToTry) {
      // Try the discovered controlURL first, then fallbacks
      const urlsToTry = [rulesControlURL, ...FALLBACK_URLS.filter((u) => u !== rulesControlURL)];
      for (const ctrlURL of urlsToTry) {
        try {
          const info = await soapRequest(host, tryPort, ctrlURL, RULES_SVC, 'FetchRules', {}, 10_000);

          const version = parseInt(String(info['ruleDbVersion'] ?? '1'), 10);
          let dbPath = String(info['ruleDbPath'] ?? '');
          if (dbPath && !dbPath.startsWith('http')) dbPath = `http://${host}:${tryPort}${dbPath}`;

          // WASM is loaded AFTER FetchRules succeeds (cached on subsequent calls)
          const SqlLib = await getSql();
          let db;

          if (version === 0 || !dbPath) {
            db = new SqlLib.Database();
          } else {
            const zipRes = await axios.get(dbPath, {
              responseType: 'arraybuffer',
              timeout: 15_000,
              httpAgent: NO_KEEPALIVE,
              headers: { 'Connection': 'close' },
            });
            const zip = new AdmZip(Buffer.from(zipRes.data));
            const dbEntry = zip.getEntries().find((e) => e.entryName.endsWith('.db'));
            if (!dbEntry) throw new Error('No .db file in rules ZIP');
            db = new SqlLib.Database(dbEntry.getData());
            // Preserve original ZIP entry name so storeDb sends it back unchanged
            db._zipEntryName = dbEntry.entryName;
          }

          ensureTables(db);
          return { db, version, resolvedPort: tryPort, zipEntryName: db._zipEntryName || 'temppluginRules.db' };
        } catch (err) {
          lastErr = err;
          const isConnErr = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'
            || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
            || (err.response?.status >= 400);
          if (!isConnErr) throw err; // parse/data error — don't retry
        }
      }
    }
  }

  throw new Error(`${host}: FetchRules unavailable — ${lastErr?.message || 'no response'}`);
}

function ensureTables(db) {
  db.run(`CREATE TABLE IF NOT EXISTS RULES (
    RuleID INTEGER PRIMARY KEY, Name TEXT NOT NULL, Type TEXT NOT NULL,
    RuleOrder INTEGER DEFAULT 0, StartDate TEXT DEFAULT '12201982',
    EndDate TEXT DEFAULT '07301982', State TEXT DEFAULT '1', Sync TEXT DEFAULT 'NOSYNC')`);
  db.run(`CREATE TABLE IF NOT EXISTS RULEDEVICES (
    RuleDevicePK INTEGER PRIMARY KEY AUTOINCREMENT, RuleID INTEGER,
    DeviceID TEXT, GroupID INTEGER DEFAULT 0, DayID INTEGER DEFAULT 127,
    StartTime INTEGER DEFAULT 0, RuleDuration INTEGER DEFAULT 0,
    StartAction REAL DEFAULT 1.0, EndAction REAL DEFAULT -1.0,
    SensorDuration INTEGER DEFAULT -1, Type INTEGER DEFAULT -1,
    Value INTEGER DEFAULT -1, Level INTEGER DEFAULT -1,
    ZBCapabilityStart TEXT DEFAULT '', ZBCapabilityEnd TEXT DEFAULT '',
    OnModeOffset INTEGER DEFAULT -1, OffModeOffset INTEGER DEFAULT -1,
    CountdownTime INTEGER DEFAULT -1, EndTime INTEGER DEFAULT -1)`);
  db.run(`CREATE TABLE IF NOT EXISTS TARGETDEVICES (
    TargetDevicesPK INTEGER PRIMARY KEY AUTOINCREMENT,
    RuleID INTEGER, DeviceID TEXT, DeviceIndex INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS LOCATIONINFO (
    LocationPk INTEGER PRIMARY KEY AUTOINCREMENT,
    cityName TEXT, countryName TEXT, latitude TEXT, longitude TEXT,
    countryCode TEXT, region TEXT)`);

  // Sync LOCATIONINFO from stored location
  if (_location) {
    let existingCode = '', existingRegion = '';
    try {
      const r = db.exec('SELECT countryCode, region FROM LOCATIONINFO LIMIT 1');
      if (r[0]?.values?.[0]) { existingCode = r[0].values[0][0] || ''; existingRegion = r[0].values[0][1] || ''; }
    } catch { /* ok */ }
    db.run('DELETE FROM LOCATIONINFO');
    db.run('INSERT INTO LOCATIONINFO (cityName,countryName,latitude,longitude,countryCode,region) VALUES (?,?,?,?,?,?)',
      [ _location.city || _location.label || '', _location.country || '',
        String(_location.lat ?? ''), String(_location.lng ?? ''),
        _location.countryCode || existingCode, _location.region || existingRegion ]);
  }

  db.run('UPDATE RULEDEVICES SET GroupID = 0 WHERE GroupID IS NULL');
}

async function fetchCurrentVersion(host, port) {
  const portsToTry = [port, ...WEMO_PORTS.filter((p) => p !== port)];
  let lastErr = null;
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 5000));
    for (const tryPort of portsToTry) {
      try {
        const info = await soapRequest(host, tryPort, '/upnp/control/rules1', 'urn:Belkin:service:rules:1', 'FetchRules');
        return { version: parseInt(String(info['ruleDbVersion'] ?? '1'), 10), resolvedPort: tryPort };
      } catch (err) {
        lastErr = err;
        const isConn = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        if (!isConn) throw err;
      }
    }
  }
  throw lastErr || new Error(`${host}: all ports failed for FetchRules`);
}

function buildStoreXml(serviceType, version, base64Body) {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:StoreRules xmlns:u="${serviceType}">`
    + `<ruleDbVersion>${version}</ruleDbVersion><processDb>1</processDb>`
    + `<ruleDbBody>&lt;![CDATA[${base64Body}]]&gt;</ruleDbBody>`
    + `</u:StoreRules></s:Body></s:Envelope>`;
}

async function saveAndUpload(db, host, port, version, zipEntryName) {
  const exported   = db.export();
  db.close();
  const newZip = new AdmZip();
  newZip.addFile(zipEntryName || 'temppluginRules.db', Buffer.from(exported));
  const base64Body = newZip.toBuffer().toString('base64');
  const svcType    = 'urn:Belkin:service:rules:1';

  let freshVersion = version, activePort = port;
  try {
    const fresh = await fetchCurrentVersion(host, port);
    freshVersion = fresh.version;
    activePort   = fresh.resolvedPort;
  } catch { /* use loadDb version */ }

  const newVersion = freshVersion + 2;
  const xml = buildStoreXml(svcType, newVersion, base64Body);

  const postResult = async (h, p, x) => {
    const res = await axios.post(`http://${h}:${p}/upnp/control/rules1`, x, {
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': `"${svcType}#StoreRules"`, 'Connection': 'close' },
      httpAgent: NO_KEEPALIVE, timeout: 30_000,
    });
    const parsed = await parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: true });
    return String(parsed['s:Envelope']['s:Body']['u:StoreRulesResponse']?.['errorInfo'] ?? '').trim();
  };

  let errorInfo;
  const portsToTry = [activePort, ...WEMO_PORTS.filter((p) => p !== activePort)];
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 5000));
    for (const tryPort of portsToTry) {
      try {
        errorInfo = await postResult(host, tryPort, xml);
        if (errorInfo.toLowerCase().includes('successful')) {
          setDeviceTime(host, tryPort).catch(() => {});
          return;
        }
        // Version mismatch — retry with fresh version
        await new Promise((r) => setTimeout(r, 2000));
        const f2 = await fetchCurrentVersion(host, tryPort);
        const retryXml = buildStoreXml(svcType, f2.version + 2, base64Body);
        const ri = await postResult(host, f2.resolvedPort, retryXml);
        if (!ri.toLowerCase().includes('successful')) throw new Error(`StoreRules failed: ${ri}`);
        setDeviceTime(host, f2.resolvedPort).catch(() => {});
        return;
      } catch (err) {
        const isConn = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        if (!isConn) throw err;
      }
    }
  }
  throw new Error(`StoreRules failed: ${errorInfo || 'all ports failed'}`);
}

// ---------------------------------------------------------------------------
// Rules CRUD
// ---------------------------------------------------------------------------

function resolveSunTimes(input) {
  const clamp = (v) => Math.max(0, Math.min(86399, v));
  const resolveOne = (type, offsetMin, fixedHHMM) => {
    // Always emit native Wemo sun codes (-2=sunrise, -3=sunset) regardless of
    // whether _location is configured.  The device uses its own LOCATIONINFO
    // table to calculate the actual times; we populate that table separately
    // (in ensureTables) when the user has set a location.
    // Positive offset = after the sun event, negative = before.
    // Device formula: fireTime = calculatedSunTime + OnModeOffset
    // (confirmed from real Wemo iOS app: OnModeOffset=1800 → 30 min AFTER sunset)
    if (type === 'sunrise') return { secs: -2, modeOffset: (offsetMin ?? 0) * 60 };
    if (type === 'sunset')  return { secs: -3, modeOffset: (offsetMin ?? 0) * 60 };
    // null / empty string = no time set; device uses -1 as "no end time" sentinel
    // Fixed-time rules use -1 for OnModeOffset (no sun offset), matching iOS app default
    if (!fixedHHMM) return { secs: -1, modeOffset: 0 };
    return { secs: clamp(timeToSecs(fixedHHMM)), modeOffset: 0 };
  };
  const start = resolveOne(input.startType, input.startOffset, input.startTime);
  const end   = resolveOne(input.endType,   input.endOffset,   input.endTime);
  return { startSecs: start.secs, endSecs: end.secs, onModeOffset: start.modeOffset, offModeOffset: end.modeOffset };
}

async function getRules(host, port) {
  // Hard 30-second deadline: FetchRules (12s) + ZIP download (12s) + getSql + margin
  const fence = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`RULES_TIMEOUT`)), 30_000)
  );
  const { db } = await Promise.race([loadDb(host, port), fence]);
  try {
    const rulesRes = db.exec('SELECT RuleID,Name,Type,RuleOrder,State FROM RULES ORDER BY RuleOrder');
    const DEVICE_TYPE_TO_UI = {
      'time interval': 'Schedule', 'simple switch': 'Schedule',
      'countdown rule': 'Countdown',
      'away mode': 'Away',
    };
    const rules = (rulesRes[0]?.values ?? []).map(([RuleID, Name, Type, RuleOrder, State]) => {
      const rawType = String(Type ?? '');
      const uiType  = DEVICE_TYPE_TO_UI[rawType.toLowerCase()] || rawType;
      return {
        ruleId: Number(RuleID),
        name: String(Name ?? ''),
        type: uiType,
        ruleOrder: Number(RuleOrder ?? 0),
        enabled: String(State) === '1',
      };
    });

    const rdRes = db.exec('SELECT * FROM RULEDEVICES ORDER BY rowid');
    const tdRes = db.exec('SELECT * FROM TARGETDEVICES ORDER BY rowid');

    const rdCols = (rdRes[0]?.columns ?? []).map((c) => c.toLowerCase());
    const rdRows = (rdRes[0]?.values ?? []).map((row) => {
      const obj = {};
      rdCols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
    const tdCols = (tdRes[0]?.columns ?? []).map((c) => c.toLowerCase());
    const tdRows = (tdRes[0]?.values ?? []).map((row) => {
      const obj = {};
      tdCols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });

    let locationInfo = null;
    try {
      const locRes = db.exec('SELECT cityName,countryName,latitude,longitude,countryCode,region FROM LOCATIONINFO LIMIT 1');
      if (locRes[0]?.values?.[0]) {
        const [cityName, countryName, latitude, longitude, countryCode, region] = locRes[0].values[0];
        locationInfo = { cityName, countryName, latitude, longitude, countryCode, region };
      }
    } catch { /* ok */ }

    const mappedRules = rules.map((rule) => {
      const allRds = rdRows.filter((r) => Number(r.ruleid) === rule.ruleId);
      const deviceMap = new Map();
      for (const rd of allRds) {
        const key = rd.deviceid;
        if (!deviceMap.has(key)) deviceMap.set(key, { ...rd, days: [] });
        const dayNum = Number(rd.dayid);
        if (dayNum > 0 && dayNum <= 7) deviceMap.get(key).days.push(dayNum);
      }
      return {
        ...rule,
        ruleDevices: [...deviceMap.values()],
        targetDevices: tdRows.filter((t) => Number(t.ruleid) === rule.ruleId).map((t) => t.deviceid),
      };
    });
    return { rules: mappedRules, locationInfo };
  } finally {
    db.close();
  }
}
exports.getRules = getRules;

async function createRule(host, port, input) {
  const { db, version, resolvedPort, zipEntryName } = await loadDb(host, port);
  const maxId    = db.exec('SELECT COALESCE(MAX(CAST(RuleID AS INTEGER)),0) FROM RULES')[0]?.values?.[0]?.[0] ?? 0;
  const ruleId   = Number(maxId) + 1;
  const ruleOrder = 2; // Wemo iOS app always uses RuleOrder=2 for all rules

  const { startSecs, endSecs, onModeOffset, offModeOffset } = resolveSunTimes(input);
  // iOS app always stores a real EndTime — use 86340 (23:59) when no end time is set.
  // -2 (sunrise) and -3 (sunset) are valid sun codes and must be preserved.
  const storedEndSecs = endSecs === -1 ? 86340 : endSecs;
  // Duration only meaningful for fixed times; sun-based rules (startSecs < 0) use 0
  const duration    = startSecs >= 0 && storedEndSecs >= 0 && storedEndSecs > startSecs ? storedEndSecs - startSecs : 0;
  const dayNumbers  = namesToDayNumbers(input.days || []);
  const deviceIds   = input.deviceIds || (input.deviceId ? [input.deviceId] : []);
  const isAway      = (input.type || '').toLowerCase().includes('away');
  const isCountdown = (input.type || '').toLowerCase().includes('countdown');

  const deviceType = RULE_TYPE_TO_DEVICE[input.type] || input.type || 'Time Interval';
  db.run(`INSERT INTO RULES (RuleID,Name,Type,RuleOrder,StartDate,EndDate,State,Sync) VALUES (?,?,?,?,'12201982','07301982','1','NOSYNC')`,
    [ruleId, input.name, deviceType, ruleOrder]);

  const insertDays = isCountdown ? [-1] : (dayNumbers.length ? dayNumbers : [1,2,3,4,5,6,7]);
  for (const deviceId of deviceIds) {
    for (const dayNum of insertDays) {
      db.run(`INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,SensorDuration,CountdownTime,EndTime,OnModeOffset,OffModeOffset) VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?)`,
        [ruleId, deviceId, dayNum, startSecs,
          isAway ? duration : 0,
          input.startAction ?? 1, input.endAction ?? -1,
          2, isCountdown ? (input.countdownTime || 3600) : 0,
          storedEndSecs, onModeOffset, offModeOffset]);
    }
  }

  // TARGETDEVICES: Wemo iOS app populates this for multi-device rules (all types).
  // Without it, some firmware versions only fire the rule on the hosting device.
  if (isAway) {
    (input.targetDeviceIds || []).forEach((tid, idx) => {
      db.run('INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)', [ruleId, tid, idx]);
    });
  } else if (deviceIds.length > 1) {
    deviceIds.forEach((did, idx) => {
      db.run('INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)', [ruleId, did, idx]);
    });
  }

  await saveAndUpload(db, host, resolvedPort || port, version, zipEntryName);
  return ruleId;
}
exports.createRule = createRule;

async function updateRule(host, port, ruleId, input) {
  const { db, version, resolvedPort, zipEntryName } = await loadDb(host, port);

  // Always normalise RuleOrder=2 — Wemo iOS app sets every rule to 2 and
  // firmware may skip rules with other values.
  db.run('UPDATE RULES SET RuleOrder=2 WHERE RuleID=?', [ruleId]);
  if (input.name !== undefined)    db.run('UPDATE RULES SET Name=? WHERE RuleID=?', [input.name, ruleId]);
  if (input.enabled !== undefined) db.run('UPDATE RULES SET State=? WHERE RuleID=?', [input.enabled ? '1' : '0', ruleId]);
  if (input.type !== undefined)    db.run('UPDATE RULES SET Type=? WHERE RuleID=?', [RULE_TYPE_TO_DEVICE[input.type] || input.type, ruleId]);

  const hasSchedule = ['days','startTime','endTime','startAction','endAction','countdownTime','deviceIds','startType','endType'].some((f) => f in input);
  // State='0'/'1' in the RULES table is sufficient to disable/enable — RULEDEVICES are preserved.

  if (hasSchedule) {
    let existingTimes = null;
    if (!input.startTime && !input.startType) {
      const r = db.exec('SELECT StartTime,EndTime,RuleDuration FROM RULEDEVICES WHERE RuleID=? LIMIT 1', [ruleId]);
      if (r[0]?.values?.[0]) existingTimes = { startSecs: r[0].values[0][0], endSecs: r[0].values[0][1], duration: r[0].values[0][2] };
    }

    let startSecs, endSecs, onModeOffset = 0, offModeOffset = 0;
    if (input.startType || input.endType) {
      const resolved = resolveSunTimes(input);
      startSecs = resolved.startSecs; endSecs = resolved.endSecs;
      onModeOffset = resolved.onModeOffset; offModeOffset = resolved.offModeOffset;
    } else {
      startSecs = input.startTime ? timeToSecs(input.startTime) : (existingTimes?.startSecs ?? 0);
      endSecs   = input.endTime   ? timeToSecs(input.endTime)   : (existingTimes?.endSecs ?? -1);
    }

    const ruleTypeRes = db.exec('SELECT Type FROM RULES WHERE RuleID=?', [ruleId]);
    const ruleType = (input.type || ruleTypeRes[0]?.values?.[0]?.[0] || '').toString().toLowerCase();
    const isAway = ruleType.includes('away');
    const isCountdown = ruleType.includes('countdown');
    // iOS app always stores a real EndTime — use 86340 (23:59) when no end time is set.
    // -2 (sunrise) and -3 (sunset) are valid sun codes and must be preserved.
    const storedEndSecs = endSecs === -1 ? 86340 : endSecs;
    // Duration only meaningful for fixed times; sun-based rules (startSecs < 0) use 0
    const duration = startSecs >= 0 && storedEndSecs >= 0 && storedEndSecs > startSecs ? storedEndSecs - startSecs : 0;

    let deviceIds;
    if (input.deviceIds?.length > 0) {
      deviceIds = input.deviceIds;
    } else {
      const r = db.exec('SELECT DISTINCT DeviceID FROM RULEDEVICES WHERE RuleID=?', [ruleId]);
      deviceIds = r[0]?.values?.map((v) => v[0]) ?? [];
    }

    const dayNumbers = input.days?.length > 0 ? namesToDayNumbers(input.days) : null;
    let existingDaysByDevice = null;
    if (!dayNumbers) {
      existingDaysByDevice = new Map();
      const r = db.exec('SELECT DeviceID,DayID FROM RULEDEVICES WHERE RuleID=?', [ruleId]);
      if (r[0]) for (const [did, day] of r[0].values) {
        if (!existingDaysByDevice.has(did)) existingDaysByDevice.set(did, []);
        existingDaysByDevice.get(did).push(Number(day));
      }
    }

    let existingActions = null;
    const actR = db.exec('SELECT StartAction,EndAction,CountdownTime FROM RULEDEVICES WHERE RuleID=? LIMIT 1', [ruleId]);
    if (actR[0]?.values?.[0]) existingActions = { startAction: actR[0].values[0][0], endAction: actR[0].values[0][1], countdownTime: actR[0].values[0][2] };

    const sa = input.startAction ?? existingActions?.startAction ?? 1;
    const ea = input.endAction   ?? existingActions?.endAction   ?? -1;

    db.run('DELETE FROM RULEDEVICES WHERE RuleID=?', [ruleId]);
    const insertDays = isCountdown ? [-1] : (dayNumbers || (existingDaysByDevice?.values().next().value) || [1,2,3,4,5,6,7]);

    for (const deviceId of deviceIds) {
      const days = Array.isArray(insertDays) && !isCountdown
        ? (dayNumbers || existingDaysByDevice?.get(deviceId) || insertDays)
        : insertDays;
      for (const dayNum of days) {
        db.run(`INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,SensorDuration,CountdownTime,EndTime,OnModeOffset,OffModeOffset) VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?)`,
          [ruleId, deviceId, dayNum, startSecs,
            isAway ? duration : 0,
            sa, ea, 2,
            isCountdown ? (input.countdownTime ?? existingActions?.countdownTime ?? 3600) : 0,
            storedEndSecs, onModeOffset, offModeOffset]);
      }
    }
  }

  const tdDeviceIds = input.deviceIds || [];
  if (input.targetDeviceIds !== undefined || tdDeviceIds.length > 1) {
    db.run('DELETE FROM TARGETDEVICES WHERE RuleID=?', [ruleId]);
    const ruleTypeStr = (input.type || '').toString().toLowerCase();
    if (ruleTypeStr.includes('away')) {
      (input.targetDeviceIds || []).forEach((tid, idx) => {
        db.run('INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)', [ruleId, tid, idx]);
      });
    } else if (tdDeviceIds.length > 1) {
      tdDeviceIds.forEach((did, idx) => {
        db.run('INSERT INTO TARGETDEVICES (RuleID,DeviceID,DeviceIndex) VALUES (?,?,?)', [ruleId, did, idx]);
      });
    }
  }

  await saveAndUpload(db, host, resolvedPort || port, version, zipEntryName);
}
exports.updateRule = updateRule;

async function deleteRule(host, port, ruleId) {
  const { db, version, resolvedPort, zipEntryName } = await loadDb(host, port);
  db.run('DELETE FROM RULES WHERE RuleID=?', [ruleId]);
  db.run('DELETE FROM RULEDEVICES WHERE RuleID=?', [ruleId]);
  db.run('DELETE FROM TARGETDEVICES WHERE RuleID=?', [ruleId]);
  await saveAndUpload(db, host, resolvedPort || port, version, zipEntryName);
}
exports.deleteRule = deleteRule;

async function dumpDb(host, port) {
  const { db } = await loadDb(host, port);
  try {
    const tablesRes = db.exec(`SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name`);
    const tables = (tablesRes[0]?.values ?? []).map(([name, sql]) => ({ name, sql }));
    const data = {};
    for (const { name } of tables) {
      try {
        const res = db.exec(`SELECT * FROM [${name}]`);
        if (!res[0]) { data[name] = []; continue; }
        data[name] = res[0].values.map((row) => {
          const obj = {};
          res[0].columns.forEach((c, i) => { obj[c] = row[i]; });
          return obj;
        });
      } catch (e) { data[name] = `ERROR: ${e.message}`; }
    }
    return { tables, data };
  } finally { db.close(); }
}
exports.dumpDb = dumpDb;
