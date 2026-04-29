'use strict';

/**
 * Wemo SOAP client + discovery + rules CRUD.
 * Runs in the Electron main process (Node.js).
 */

const crypto = require('crypto');
const dgram  = require('dgram');
const path   = require('path');
const http   = require('http');
const axios  = require('axios');
const sun    = require('./core/sun');
const AdmZip = require('adm-zip');
const { parseStringPromise } = require('xml2js');
const { create } = require('xmlbuilder2');
const { namesToDayNumbers, deviceDaysToDibby, dibbyDayToDevice, timeToSecs } = require('./core/types');

// Wemo devices close the socket immediately after each response.
const NO_KEEPALIVE = new http.Agent({ keepAlive: false });

// ---------------------------------------------------------------------------
// WiFi diagnostic logger — emits real-time entries to the renderer UI.
// Set via setWifiLogger() from wifi.ipc.js after BrowserWindow is ready.
// ---------------------------------------------------------------------------
let _wifiLogFn = null;
exports.setWifiLogger = (fn) => { _wifiLogFn = fn; };

function wlog(type, msg, detail) {
  if (_wifiLogFn) _wifiLogFn({ type, msg, detail: detail ?? null, ts: Date.now() });
}

function maskPwd(val) {
  const s = String(val ?? '');
  if (s.length === 0) return '(empty)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 3)}…${s.slice(-2)} [${s.length} chars]`;
}

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

async function soapRequest(host, port, controlURL, serviceType, action, args = {}, timeoutMs = 10_000, rawBody = null) {
  const url  = `http://${host}:${port}${controlURL}`;
  // isWifi is evaluated at call-time — WIFI_URL / META_URL are module-level consts set before any call.
  const isWifi = (controlURL === WIFI_URL || controlURL === META_URL);

  let xml;
  if (rawBody !== null) {
    xml = rawBody;
  } else {
    const root = create({ version: '1.0', encoding: 'utf-8' })
      .ele('s:Envelope', { 'xmlns:s': 'http://schemas.xmlsoap.org/soap/envelope/', 's:encodingStyle': 'http://schemas.xmlsoap.org/soap/encoding/' })
      .ele('s:Body')
      .ele(`u:${action}`, { [`xmlns:u`]: serviceType });
    for (const [k, v] of Object.entries(args)) root.ele(k).txt(v);
    xml = root.doc().end({ headless: false });
  }

  // Log the outgoing SOAP request for WiFi-related actions.
  if (isWifi) {
    let detail = null;
    if (rawBody !== null) {
      // Show inner body only (strip envelope/body wrapper).
      detail = rawBody
        .replace(/^[\s\S]*?<u:[^>]+>/m, '')
        .replace(/<\/u:[^>]+>[\s\S]*$/m, '')
        .trim() || null;
    } else if (Object.keys(args).length > 0) {
      detail = Object.entries(args)
        .map(([k, v]) => `  <${k}>${k === 'password' ? maskPwd(v) : String(v ?? '')}</${k}>`)
        .join('\n');
    }
    wlog('send', `→ ${action}  [${host}:${port}]`, detail);
  }

  let res;
  try {
    res = await axios.post(url, xml, {
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${serviceType}#${action}"`,
        'Connection': 'close',
      },
      httpAgent: NO_KEEPALIVE,
      timeout: timeoutMs,
    });
  } catch (err) {
    if (isWifi) {
      const code = err.response ? `HTTP ${err.response.status}` : (err.code ?? err.message);
      const body = err.response?.data ? String(err.response.data).slice(0, 400) : null;
      wlog('error', `✕ ${action} — ${code}`, body);
    }
    throw err;
  }

  const parsed = await parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: true });
  const body = parsed['s:Envelope']['s:Body'];
  const result = body[`u:${action}Response`] ?? body;

  // Log the response.
  if (isWifi) {
    const entries = Object.entries(result ?? {});
    const detail = entries.length
      ? entries.map(([k, v]) => `  ${k}: ${String(v ?? '').slice(0, 300)}`).join('\n')
      : null;
    wlog('recv', `← ${action}  HTTP ${res.status}`, detail);
  }

  return result;
}

async function soapWithFallback(host, port, controlURL, serviceType, action, args = {}, rawBody = null) {
  const portsToTry = [port, ...WEMO_PORTS.filter((p) => p !== port)];
  let lastErr = null;
  for (const tryPort of portsToTry) {
    try {
      return await soapRequest(host, tryPort, controlURL, serviceType, action, args, 10_000, rawBody);
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

const META_SVC = 'urn:Belkin:service:metainfo:1';
const META_URL = '/upnp/control/metainfo1';

// Retrieve device MAC and serial number required for password encryption.
// Returns a pipe-delimited string: "MAC|SerialNumber|..."
async function getMetaInfo(host, port) {
  const res = await soapWithFallback(host, port, META_URL, META_SVC, 'GetMetaInfo');
  return String(res['MetaInfo'] ?? '');
}
exports.getMetaInfo = getMetaInfo;

// Encrypt a WiFi password using AES-128-CBC, keyed from device MAC + serial.
// Matches OpenSSL: enc -aes-128-cbc -md md5 -S <salt> -iv <iv> -pass pass:<keydata>
// Key derivation: EVP_BytesToKey(MD5, 1 iter, 16 bytes) = MD5(keydata + salt)
function encryptWifiPassword(password, metaInfo) {
  const parts   = metaInfo.split('|');
  const mac     = parts[0] || '';
  const serial  = parts[1] || '';
  const keydata = mac.slice(0, 6) + serial + mac.slice(6, 12);

  const saltBuf = Buffer.from(keydata.slice(0, 8),  'utf8');
  const iv      = Buffer.from(keydata.slice(0, 16), 'utf8');
  const key     = crypto.createHash('md5')
    .update(Buffer.from(keydata, 'utf8'))
    .update(saltBuf)
    .digest();

  const cipher    = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(password, 'utf8')),
    cipher.final(),
  ]);
  const b64     = encrypted.toString('base64');
  const lenEnc  = b64.length.toString(16).padStart(2, '0');
  const lenOrig = password.length.toString(16).padStart(2, '0');
  return b64 + lenEnc + lenOrig;
}

async function getApList(host, port) {
  const res = await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'GetApList');
  const raw = String(res['ApList'] ?? '');
  wlog('step', 'Raw ApList response', raw.trim() || '(empty)');
  if (!raw.trim()) return [];
  // pywemo skips the first line (may be a count or blank).
  // We filter(Boolean) to drop empty strings, which handles both cases.
  const lines = raw.split('\n').filter(Boolean);
  const entries = lines.map((line) => {
    const parts = line.split('|');
    // pywemo uses columns[-1] (last field) as the combined "auth/encrypt" string.
    // Format: ssid|channel|[rssi|]auth/encrypt
    // Some firmware may split auth and encrypt into separate fields (5 fields).
    let auth, encrypt, rssi;
    const last = parts[parts.length - 1] || '';
    if (last.includes('/')) {
      // "auth/encrypt" in last field: ssid|channel|rssi|auth/encrypt OR ssid|channel|auth/encrypt
      const [authMode, encMode] = last.split('/');
      auth    = authMode || '';
      encrypt = encMode  || '';
      // rssi is either field[2] (4-field) or absent (3-field)
      rssi    = parts.length >= 4 ? (parseInt(parts[2] || '0', 10) || 0) : 0;
    } else {
      // 5-field: ssid|channel|auth|encrypt|rssi
      auth    = parts[2] || '';
      encrypt = parts[3] || '';
      rssi    = parseInt(parts[4] || '0', 10) || 0;
    }
    return { ssid: parts[0] || '', channel: parts[1] || '', auth, encrypt, rssi };
  }).sort((a, b) => b.rssi - a.rssi);
  wlog('step', `Parsed ${entries.length} AP(s)`,
    entries.map((e) => `${e.ssid}  ch${e.channel}  ${e.auth}/${e.encrypt}  ${e.rssi}%`).join('\n'));
  return entries;
}
exports.getApList = getApList;

// Normalize UI auth/security labels to WeMo firmware strings.
// Sourced directly from the official WeMo Android app (constants.js in APK):
//   AUTH_OPEN = "OPEN", AUTH_WEP = "WEP",
//   AUTH_WPA = AUTH_WPA2 = "WPA1PSKWPA2PSK"
function normalizeAuth(auth) {
  if (!auth) return 'WPA1PSKWPA2PSK';
  const a = auth.toUpperCase().replace(/[-\s]/g, '');
  if (a === 'OPEN') return 'OPEN';
  if (a === 'WEP')  return 'WEP';
  // WPA, WPA-PSK, WPA2, WPA2-PSK, WPA2PSK, WPAPSK, WPA1PSKWPA2PSK, etc.
  return 'WPA1PSKWPA2PSK';
}

// Normalize encrypt type.  APK: ENCRYPT_OPEN="NONE", ENCRYPT_WEP="WEP", ENCRYPT_WPA/WPA2="AES"
function normalizeEncrypt(auth, encrypt) {
  if (encrypt) return encrypt; // already provided by scan result
  const a = (auth || '').toUpperCase();
  if (a === 'OPEN') return 'NONE';
  if (a === 'WEP')  return 'WEP';
  return 'AES';
}

async function connectHomeNetwork(host, port, { ssid, auth, password, encrypt, channel }) {
  const plainPassword = password || '';

  // -------------------------------------------------------------------------
  // Step 1 — Scan the AP list first.
  // This primes the device's internal AP cache AND gives us the exact
  // auth/encrypt strings the firmware recognises (e.g. "WPA2PSK", "TKIPAES").
  // pywemo always does GetApList before ConnectHomeNetwork.
  // -------------------------------------------------------------------------
  let firmwareAuth    = normalizeAuth(auth);
  let firmwareEncrypt = normalizeEncrypt(firmwareAuth, encrypt);
  let firmwareChannel = channel || '0';

  wlog('step', 'Scanning AP list to prime device cache and get exact auth/encrypt…');
  try {
    const apList = await getApList(host, port);
    const match  = apList.find((ap) => ap.ssid === ssid);
    if (match) {
      firmwareAuth    = match.auth    || firmwareAuth;
      firmwareEncrypt = match.encrypt || firmwareEncrypt;
      firmwareChannel = match.channel || firmwareChannel;
      wlog('step', `Found "${ssid}" in AP list`,
        `auth: ${firmwareAuth}\nencrypt: ${firmwareEncrypt}\nchannel: ${firmwareChannel}`);
    } else {
      wlog('step', `"${ssid}" not found in AP list — using user-specified values`,
        `auth: ${firmwareAuth}\nencrypt: ${firmwareEncrypt}\nchannel: ${firmwareChannel}`);
    }
  } catch (e) {
    wlog('error', `AP scan failed (${e.message}) — proceeding with user values`);
  }

  // -------------------------------------------------------------------------
  // Step 2 — Encrypt the password (skip for OPEN networks).
  // -------------------------------------------------------------------------
  const isOpen = firmwareAuth === 'OPEN' || firmwareEncrypt === 'NONE';
  let encryptedPassword = null;

  if (!isOpen && plainPassword) {
    try {
      wlog('step', 'Fetching MetaInfo (MAC + serial for AES key derivation)…');
      const metaInfo = await getMetaInfo(host, port);
      if (metaInfo) {
        wlog('step', 'Encrypting password with AES-128-CBC (method 1)…');
        encryptedPassword = encryptWifiPassword(plainPassword, metaInfo);
        wlog('step', `Password encrypted → ${maskPwd(encryptedPassword)}`);
      }
    } catch (e) {
      wlog('error', `MetaInfo unavailable (${e.message}) — will try plaintext fallback`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — Send ConnectHomeNetwork twice (confirmed working pattern).
  //
  // Confirmed working on F7C027 firmware 2.00.11851:
  //   - Flat params (no PairingData wrapper)
  //   - SSID in CDATA
  //   - Encrypted password (AES-128-CBC with MAC/serial key)
  //   - Send twice in quick succession
  // -------------------------------------------------------------------------
  const finalPassword = encryptedPassword || plainPassword;
  const args = {
    ssid,
    auth:     firmwareAuth,
    password: finalPassword,
    encrypt:  firmwareEncrypt,
    channel:  firmwareChannel,
  };

  // Build raw body to preserve CDATA for ssid
  const makeBody = () => [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    '<u:ConnectHomeNetwork xmlns:u="urn:Belkin:service:WiFiSetup:1">',
    `<ssid><![CDATA[${ssid}]]></ssid>`,
    `<auth>${args.auth}</auth>`,
    `<password>${args.password}</password>`,
    `<encrypt>${args.encrypt}</encrypt>`,
    `<channel>${args.channel}</channel>`,
    '</u:ConnectHomeNetwork>',
    '</s:Body>',
    '</s:Envelope>',
  ].join('\n');

  for (let i = 1; i <= 2; i++) {
    wlog('step', `ConnectHomeNetwork #${i}…`);
    await soapWithFallback(host, port, WIFI_URL, WIFI_SVC, 'ConnectHomeNetwork', {}, makeBody());
    if (i === 1) await new Promise((r) => setTimeout(r, 500));
  }
  wlog('step', 'ConnectHomeNetwork sent — poll GetNetworkStatus for result');
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

async function getHomeKitInfo(host, port, modelName) {
  const result = { setupDone: null, setupCode: null, setupURI: null, category: null };
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'getHKSetupState');
    result.setupDone = String(res['HKSetupDone'] ?? '').trim();
  } catch { /* not supported */ }
  try {
    const res = await soapWithFallback(host, port, BE_URL, BE_SVC, 'GetHKSetupInfo');
    result.setupCode = String(res['HKSetupCode'] ?? '').trim();
  } catch { /* not supported */ }

  // Build the X-HM:// URI Apple Home expects for QR-code-based setup.
  // The Wemo SOAP API exposes only the 8-digit setup code; we derive the URI
  // locally so we can render a scannable QR without hitting the device again.
  if (result.setupCode && /^\d{3}-?\d{2}-?\d{3}$/.test(result.setupCode)) {
    const cat = homeKitCategoryFromModel(modelName);
    result.category = cat;
    result.setupURI  = buildHomeKitSetupURI(result.setupCode, cat, /* IP flag */ 2);
  }
  return result;
}
exports.getHomeKitInfo = getHomeKitInfo;

/**
 * Map a Wemo modelName to its HomeKit Accessory Category Identifier.
 * (HAP spec §13-1.) Falls back to 7 (Outlet) which is the safe default for
 * controllable on/off relays — Apple Home will still pair correctly even if
 * the category is approximate.
 */
function homeKitCategoryFromModel(modelName) {
  const m = String(modelName ?? '').toLowerCase();
  if (m.includes('lightswitch')) return 8;  // Switch
  if (m.includes('light') || m.includes('bulb')) return 5;  // Lightbulb
  if (m.includes('socket') || m.includes('plug') || m.includes('outlet') || m.includes('insight')) return 7;  // Outlet
  if (m.includes('motion') || m.includes('sensor')) return 10;  // Sensor
  return 7;  // Outlet — safe default for Wemo on/off relays
}
exports.homeKitCategoryFromModel = homeKitCategoryFromModel;

/**
 * Build the X-HM:// setup URI from an 8-digit HomeKit setup code.
 *
 * Payload layout (HAP spec §4.2.1.5, "Setup Code Tag"): 46 bits, base36-encoded
 * to 9 ASCII characters. Bit positions (LSB first):
 *   [0..2]   version  (always 0)
 *   [3..6]   reserved (0)
 *   [7..14]  category (8 bits)
 *   [15..18] flags    (4 bits — 1=NFC, 2=IP, 4=BLE)
 *   [19..45] setupCode (27 bits, the integer value of the 8-digit code)
 *
 * Returns e.g. "X-HM://0023U2J03" for setup code 111-22-333 + category 7 + IP flag.
 */
function buildHomeKitSetupURI(setupCode, category, flags) {
  const digits = String(setupCode).replace(/-/g, '');
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`invalid HomeKit setup code: ${setupCode}`);
  }
  const code = BigInt(digits);
  let payload = 0n;
  // version (3 bits, 0) + reserved (4 bits, 0) — bits 0..6 stay 0
  payload |= (BigInt(category & 0xff))   << 7n;   // bits 7..14
  payload |= (BigInt(flags    & 0x0f))   << 15n;  // bits 15..18
  payload |= (code            & 0x7ffffffn) << 19n; // bits 19..45 (27 bits)

  // Base36 encode to exactly 9 chars (zero-padded), uppercase
  let s = '';
  let v = payload;
  for (let i = 0; i < 9; i++) {
    const digit = Number(v % 36n);
    s = digit.toString(36).toUpperCase() + s;
    v /= 36n;
  }
  return 'X-HM://' + s;
}
exports.buildHomeKitSetupURI = buildHomeKitSetupURI;

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
        // Translate Belkin device DayID → Dibby internal day numbers.
        // One Belkin row may expand to multiple Dibby days (Daily=0, Weekdays=8,
        // Weekends=9), and per-day values 1-7 are also remapped because Belkin
        // uses Sun=1..Sat=7 while Dibby uses Mon=1..Sun=7.
        const expanded = deviceDaysToDibby(rd.dayid);
        const target   = deviceMap.get(key).days;
        for (const d of expanded) {
          if (!target.includes(d)) target.push(d);
        }
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
      // Translate Dibby internal day → Belkin firmware DayID convention so
      // rules created in Dibby are also correctly read by the Belkin WeMo app.
      // Countdown sentinel (-1) and any negative values pass through unchanged.
      const deviceDayId = dayNum > 0 ? dibbyDayToDevice(dayNum) : dayNum;
      db.run(`INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,SensorDuration,CountdownTime,EndTime,OnModeOffset,OffModeOffset) VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?)`,
        [ruleId, deviceId, deviceDayId, startSecs,
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
      // Existing DayID values in the firmware are in Belkin convention. Translate
      // them to Dibby internal (Mon=1..Sun=7) so the insert path can apply a
      // single uniform Dibby→Belkin conversion at the end.
      existingDaysByDevice = new Map();
      const r = db.exec('SELECT DeviceID,DayID FROM RULEDEVICES WHERE RuleID=?', [ruleId]);
      if (r[0]) for (const [did, day] of r[0].values) {
        if (!existingDaysByDevice.has(did)) existingDaysByDevice.set(did, []);
        for (const d of deviceDaysToDibby(day)) {
          if (!existingDaysByDevice.get(did).includes(d)) existingDaysByDevice.get(did).push(d);
        }
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
        // Translate Dibby internal day → Belkin firmware DayID convention.
        // Negative sentinel values (e.g. -1 for countdown) pass through unchanged.
        const deviceDayId = dayNum > 0 ? dibbyDayToDevice(dayNum) : dayNum;
        db.run(`INSERT INTO RULEDEVICES (RuleID,DeviceID,GroupID,DayID,StartTime,RuleDuration,StartAction,EndAction,SensorDuration,CountdownTime,EndTime,OnModeOffset,OffModeOffset) VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?)`,
          [ruleId, deviceId, deviceDayId, startSecs,
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
