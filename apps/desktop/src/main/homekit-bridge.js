'use strict';

/**
 * Embedded HomeKit (HAP) bridge for Dibby Wemo Manager.
 *
 * Why this exists:
 *   Older Wemo devices have no HomeKit firmware at all, and newer Wemos that
 *   do may have lost their setup-code sticker or already be paired elsewhere.
 *   Running a HAP bridge inside Dibby gives every Wemo on the LAN — regardless
 *   of native HomeKit support — a single Apple Home pairing flow: pair Dibby
 *   once, every Wemo appears as a HomeKit Switch under the bridge.
 *
 * What this gives users without a Homebridge install:
 *   - One QR-code pairing for all Wemos
 *   - Apple Home automations can drive the on/off state
 *   - Works on Pi / NAS / old phone / Windows / Linux — wherever Dibby runs
 *
 * Persistence:
 *   Bridge identity (username MAC, pincode, accessory cache) is stored in
 *   `<userData>/homekit-bridge/` so pairing survives restarts. Once paired,
 *   re-launching Dibby does NOT re-prompt — Apple Home keeps the trust.
 *
 * Lifecycle:
 *   start()      — generate identity if missing, publish bridge on mDNS
 *   stop()       — gracefully unpublish so iOS doesn't wait for it
 *   syncDevices(list) — add/remove HAP accessories to match the device list
 *   getStatus()  — { running, paired, pincode, setupURI, qrDataURL, pairedClients }
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');

let HAP;          // hap-nodejs is loaded lazily so dev/launch doesn't pay the cost when bridge is off
let qrcodeLib;    // qrcode is already a dep elsewhere

const BRIDGE_NAME    = 'Dibby Wemo Bridge';
const HAP_CATEGORY_BRIDGE = 2;
const HAP_CATEGORY_SWITCH = 8;
const HAP_CATEGORY_OUTLET = 7;

let _state = {
  running:      false,
  bridge:       null,         // hap-nodejs Bridge instance
  accessories:  new Map(),    // udn -> { accessory, service, lastState }
  storagePath:  null,
  identity:     null,         // { username, pincode, port }
  pollTimer:    null,
  pairedFlag:   false,
  wemoClient:   null,
};

// ── Identity ────────────────────────────────────────────────────────────────

function _identityFile() { return path.join(_state.storagePath, 'identity.json'); }
function _accessoriesFile() { return path.join(_state.storagePath, 'accessories.json'); }

/**
 * MAC-format username, e.g. "12:AB:CD:EF:01:02". HAP requires this format and
 * caches pairing trust against it, so we generate once and persist forever.
 */
function _randomMac() {
  // Locally-administered, unicast MAC: first byte's bit-1 set, bit-0 clear
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/**
 * 8-digit HAP setup code, formatted "NNN-NN-NNN". HAP forbids trivial
 * sequences (00000000, 11111111, 12345678, 87654321) — re-roll if hit.
 */
function _randomPincode() {
  const banned = new Set(['00000000','11111111','22222222','33333333','44444444','55555555','66666666','77777777','88888888','99999999','12345678','87654321']);
  for (;;) {
    const n = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    if (banned.has(n)) continue;
    return `${n.slice(0,3)}-${n.slice(3,5)}-${n.slice(5,8)}`;
  }
}

function _loadOrCreateIdentity() {
  try {
    const raw = fs.readFileSync(_identityFile(), 'utf8');
    const id  = JSON.parse(raw);
    if (id.username && id.pincode && id.port) return id;
  } catch { /* fall through to generate */ }

  const id = {
    username: _randomMac(),
    pincode:  _randomPincode(),
    port:     47126 + crypto.randomInt(0, 200), // outside common ports, deterministic-ish range
    setupId:  crypto.randomBytes(2).toString('hex').toUpperCase(),
  };
  fs.mkdirSync(_state.storagePath, { recursive: true });
  fs.writeFileSync(_identityFile(), JSON.stringify(id, null, 2), 'utf8');
  return id;
}

// ── HAP setup URI ───────────────────────────────────────────────────────────

/**
 * Build the X-HM:// URI Apple Home expects for QR scanning.
 * Same encoding as `wemo.js#buildHomeKitSetupURI` but kept local so this
 * module is self-contained for future extraction into its own package.
 */
function buildSetupURI(pincode, category, flags) {
  const digits = String(pincode).replace(/-/g, '');
  if (!/^\d{8}$/.test(digits)) throw new Error('invalid pincode');
  const code = BigInt(digits);
  let payload = 0n;
  payload |= (BigInt(category & 0xff)) << 7n;
  payload |= (BigInt(flags    & 0x0f)) << 15n;
  payload |= (code            & 0x7ffffffn) << 19n;
  let s = '';
  let v = payload;
  for (let i = 0; i < 9; i++) {
    s = (Number(v % 36n)).toString(36).toUpperCase() + s;
    v /= 36n;
  }
  return 'X-HM://' + s;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Initialise the bridge. Idempotent: calling start() on a running bridge is a no-op.
 *
 * @param {object} opts
 * @param {string}   opts.storagePath - directory for bridge identity + accessory cache
 * @param {object}   opts.wemoClient  - module exposing getBinaryState / setBinaryState
 * @param {function} [opts.log]       - optional logger
 */
async function start({ storagePath, wemoClient, log = () => {} }) {
  if (_state.running) return getStatus();
  if (!HAP)        HAP        = require('hap-nodejs');
  if (!qrcodeLib)  qrcodeLib  = require('qrcode');

  _state.storagePath = storagePath;
  _state.wemoClient  = wemoClient;
  _state.identity    = _loadOrCreateIdentity();

  HAP.HAPStorage.setCustomStoragePath(storagePath);

  const uuid = HAP.uuid.generate('com.srsit.dibbywemomanager.bridge:' + _state.identity.username);
  _state.bridge = new HAP.Bridge(BRIDGE_NAME, uuid);

  // AccessoryInformation is created automatically by Bridge; set our metadata
  _state.bridge.getService(HAP.Service.AccessoryInformation)
    ?.setCharacteristic(HAP.Characteristic.Manufacturer, 'SRS IT')
    .setCharacteristic(HAP.Characteristic.Model,         'Dibby Wemo Bridge')
    .setCharacteristic(HAP.Characteristic.SerialNumber,  _state.identity.username)
    .setCharacteristic(HAP.Characteristic.FirmwareRevision, _bridgeVersion());

  _state.bridge.on('paired', () => { _state.pairedFlag = true; log('[hk-bridge] paired with controller'); });
  _state.bridge.on('unpaired', () => { _state.pairedFlag = _hasPairings(); log('[hk-bridge] controller removed pairing'); });

  await _state.bridge.publish({
    username: _state.identity.username,
    pincode:  _state.identity.pincode,
    port:     _state.identity.port,
    category: HAP_CATEGORY_BRIDGE,
    setupID:  _state.identity.setupId,
    addIdentifyingMaterial: true,
  });

  _state.running    = true;
  _state.pairedFlag = _hasPairings();
  log(`[hk-bridge] published as "${BRIDGE_NAME}" on port ${_state.identity.port}, pincode ${_state.identity.pincode}`);

  // Restore previously-known accessories from disk so HomeKit sees them
  // immediately after restart (before the first device discovery completes).
  try {
    const cached = JSON.parse(fs.readFileSync(_accessoriesFile(), 'utf8'));
    for (const dev of (cached.devices ?? [])) _addAccessory(dev);
    log(`[hk-bridge] restored ${cached.devices?.length ?? 0} cached accessories`);
  } catch { /* no cache yet */ }

  _startStatePolling(log);
  return getStatus();
}

async function stop() {
  if (!_state.running) return;
  if (_state.pollTimer) { clearInterval(_state.pollTimer); _state.pollTimer = null; }
  try { await _state.bridge.unpublish(); } catch { /* may already be unpublished */ }
  _state.running     = false;
  _state.bridge      = null;
  _state.accessories = new Map();
}

function _hasPairings() {
  try {
    const aci = _state.bridge?._accessoryInfo;
    return !!(aci && aci.pairedClients && Object.keys(aci.pairedClients).length > 0);
  } catch { return false; }
}

function _bridgeVersion() {
  try { return require('../../package.json').version; } catch { return '2.0.0'; }
}

// ── Accessories ─────────────────────────────────────────────────────────────

function _categoryForDevice(device) {
  const m = String(device?.modelName ?? '').toLowerCase();
  if (m.includes('lightswitch')) return HAP_CATEGORY_SWITCH;
  return HAP_CATEGORY_OUTLET;
}

function _addAccessory(device) {
  if (!device?.udn || _state.accessories.has(device.udn)) return;

  const aid  = HAP.uuid.generate('com.srsit.dibbywemomanager.dev:' + device.udn);
  const name = device.friendlyName || device.name || device.host;
  const accessory = new HAP.Accessory(name, aid);

  accessory.getService(HAP.Service.AccessoryInformation)
    ?.setCharacteristic(HAP.Characteristic.Manufacturer, 'Belkin (via Dibby)')
    .setCharacteristic(HAP.Characteristic.Model,         device.productModel ?? device.modelName ?? 'Wemo')
    .setCharacteristic(HAP.Characteristic.SerialNumber,  device.serialNumber ?? device.udn)
    .setCharacteristic(HAP.Characteristic.FirmwareRevision, device.firmwareVersion ?? '0');

  const svc = accessory.addService(HAP.Service.Switch, name);
  svc.getCharacteristic(HAP.Characteristic.On)
    .onGet(async () => {
      // Cached state — see homebridge-plugin/lib/accessory.js for rationale.
      const entry = _state.accessories.get(device.udn);
      return !!(entry?.lastState);
    })
    .onSet(async (value) => {
      try {
        await _state.wemoClient.setBinaryState(device.host, device.port, !!value);
        const entry = _state.accessories.get(device.udn);
        if (entry) entry.lastState = !!value;
      } catch (e) {
        throw new HAP.HapStatusError(HAP.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });

  _state.bridge.addBridgedAccessory(accessory);
  _state.accessories.set(device.udn, { accessory, service: svc, lastState: false, device });
}

function _removeAccessory(udn) {
  const entry = _state.accessories.get(udn);
  if (!entry) return;
  try { _state.bridge.removeBridgedAccessory(entry.accessory); } catch { /* not added */ }
  _state.accessories.delete(udn);
}

function _persistAccessoryCache() {
  try {
    const devices = [..._state.accessories.values()].map((e) => e.device);
    fs.writeFileSync(_accessoriesFile(), JSON.stringify({ devices }, null, 2), 'utf8');
  } catch { /* non-critical */ }
}

/**
 * Reconcile the HAP accessory list against the current Wemo device list.
 * Adds missing devices, removes vanished ones. Safe to call repeatedly.
 */
function syncDevices(deviceList) {
  if (!_state.running) return;
  const have   = new Set([..._state.accessories.keys()]);
  const want   = new Set(deviceList.map((d) => d.udn).filter(Boolean));

  for (const dev of deviceList) {
    if (dev.udn && !have.has(dev.udn)) _addAccessory(dev);
  }
  for (const udn of have) {
    if (!want.has(udn)) _removeAccessory(udn);
  }
  _persistAccessoryCache();
}

// ── State polling ───────────────────────────────────────────────────────────

function _startStatePolling(log) {
  if (_state.pollTimer) clearInterval(_state.pollTimer);
  // Poll cadence matches the homebridge plugin default; fast enough for HomeKit
  // automations, slow enough to not hammer the LAN with 30+ devices.
  _state.pollTimer = setInterval(async () => {
    for (const entry of _state.accessories.values()) {
      try {
        const cur = await _state.wemoClient.getBinaryState(entry.device.host, entry.device.port);
        if (cur !== entry.lastState) {
          entry.lastState = cur;
          entry.service.updateCharacteristic(HAP.Characteristic.On, cur);
        }
      } catch { /* device unreachable — keep last state */ }
    }
  }, 30_000);
}

// ── Status ──────────────────────────────────────────────────────────────────

async function getStatus() {
  if (!_state.running) {
    return { running: false, paired: false, pincode: null, setupURI: null, qrDataURL: null, pairedClients: 0, port: null };
  }
  // Prefer hap-nodejs's canonical setupURI generator over our hand-rolled
  // encoder. The official format embeds the 4-char setupID at the end of the
  // URI (X-HM://<9-char-base36><4-char-setupID>) and Apple Home rejects QRs
  // that don't match this exact structure with "Could not add accessory:
  // unsupported setup code". The custom encoder previously here computed the
  // base36 portion correctly but omitted the setupID suffix.
  let setupURI;
  try {
    setupURI = _state.bridge.setupURI();
  } catch (e) {
    setupURI = buildSetupURI(_state.identity.pincode, HAP_CATEGORY_BRIDGE, /* IP flag */ 2);
  }
  let qrDataURL = null;
  try {
    qrDataURL = await qrcodeLib.toDataURL(setupURI, {
      errorCorrectionLevel: 'Q',
      margin:                1,
      width:                 240,
    });
  } catch { /* qrcode optional */ }
  const pairedClients = (() => {
    try { return Object.keys(_state.bridge._accessoryInfo?.pairedClients ?? {}).length; }
    catch { return 0; }
  })();
  return {
    running:        true,
    paired:         pairedClients > 0,
    pincode:        _state.identity.pincode,
    username:       _state.identity.username,
    port:           _state.identity.port,
    setupURI,
    qrDataURL,
    pairedClients,
    accessoryCount: _state.accessories.size,
  };
}

/**
 * Wipe pairing trust + identity. After this the user re-pairs from scratch.
 * Useful when a controller (e.g. an iPhone) was lost/reset and the trust is stuck.
 */
async function resetPairings() {
  await stop();
  try { fs.rmSync(_state.storagePath, { recursive: true, force: true }); } catch { /* ignore */ }
  _state.identity = null;
}

module.exports = { start, stop, syncDevices, getStatus, resetPairings, buildSetupURI };
