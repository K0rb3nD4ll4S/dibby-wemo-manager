'use strict';

/**
 * Dibby Wemo MQTT Bridge
 *
 * Bridges Belkin Wemo devices to any MQTT broker.
 * Publishes device state, subscribes to command topics, and optionally
 * registers devices with Home Assistant via MQTT Auto-Discovery.
 *
 * Environment variables:
 *   MQTT_HOST             — broker hostname/IP        (default: localhost)
 *   MQTT_PORT             — broker port               (default: 1883)
 *   MQTT_USERNAME         — broker username           (default: none)
 *   MQTT_PASSWORD         — broker password           (default: none)
 *   MQTT_TOPIC_PREFIX     — root topic prefix         (default: dibby-wemo)
 *   POLL_INTERVAL         — state poll seconds        (default: 10)
 *   DISCOVERY_INTERVAL    — SSDP re-scan seconds      (default: 120)
 *   HA_DISCOVERY          — publish HA discovery      (default: true)
 *   HA_DISCOVERY_PREFIX   — HA discovery prefix       (default: homeassistant)
 *   MANUAL_DEVICES        — JSON array [{host,port}]  (default: [])
 */

const mqtt       = require('mqtt');
const wemo       = require('../lib/wemo-client');

// ── Config ────────────────────────────────────────────────────────────────────

const CFG = {
  mqttHost:          process.env.MQTT_HOST           || 'localhost',
  mqttPort:          parseInt(process.env.MQTT_PORT  || '1883', 10),
  mqttUsername:      process.env.MQTT_USERNAME       || undefined,
  mqttPassword:      process.env.MQTT_PASSWORD       || undefined,
  topicPrefix:       process.env.MQTT_TOPIC_PREFIX   || 'dibby-wemo',
  pollInterval:      parseInt(process.env.POLL_INTERVAL        || '10',  10) * 1000,
  discoveryInterval: parseInt(process.env.DISCOVERY_INTERVAL   || '120', 10) * 1000,
  haDiscovery:       (process.env.HA_DISCOVERY       || 'true') !== 'false',
  haPrefix:          process.env.HA_DISCOVERY_PREFIX || 'homeassistant',
  manualDevices:     JSON.parse(process.env.MANUAL_DEVICES     || '[]'),
};

// ── State ─────────────────────────────────────────────────────────────────────

/** Map of `host:port` → device info + last known state */
const devices = new Map();
let client;

// ── Helpers ───────────────────────────────────────────────────────────────────

function slug(name) {
  return (name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stateTopic(device)        { return `${CFG.topicPrefix}/${device.slug}/state`; }
function commandTopic(device)      { return `${CFG.topicPrefix}/${device.slug}/set`; }
function availabilityTopic(device) { return `${CFG.topicPrefix}/${device.slug}/availability`; }
function bridgeStatusTopic()       { return `${CFG.topicPrefix}/bridge/status`; }
function haConfigTopic(device)     { return `${CFG.haPrefix}/switch/${device.slug}/config`; }

function log(msg)  { console.log(`[DWM-MQTT] ${new Date().toISOString()}  ${msg}`); }
function warn(msg) { console.warn(`[DWM-MQTT] ${new Date().toISOString()}  WARN  ${msg}`); }

// ── HA Discovery ──────────────────────────────────────────────────────────────

function publishHaDiscovery(device) {
  if (!CFG.haDiscovery) return;
  const payload = JSON.stringify({
    name:               device.friendlyName,
    unique_id:          `dibby_wemo_${device.udn}`,
    state_topic:        stateTopic(device),
    command_topic:      commandTopic(device),
    availability_topic: availabilityTopic(device),
    payload_on:         'ON',
    payload_off:        'OFF',
    payload_available:  'online',
    payload_not_available: 'offline',
    device: {
      identifiers:  [`dibby_wemo_${device.udn}`],
      name:         device.friendlyName,
      manufacturer: 'Belkin',
      model:        device.productModel || 'Wemo Device',
      sw_version:   device.firmwareVersion || undefined,
    },
  });
  client.publish(haConfigTopic(device), payload, { retain: true, qos: 1 });
  log(`HA discovery published: ${device.friendlyName}`);
}

// ── Device registration ───────────────────────────────────────────────────────

function registerDevice(info) {
  const key = `${info.host}:${info.port}`;
  if (devices.has(key)) return devices.get(key);

  const device = {
    host:            info.host,
    port:            info.port,
    udn:             info.udn            || key,
    friendlyName:    info.friendlyName   || info.host,
    productModel:    info.productModel   || 'Wemo Device',
    firmwareVersion: info.firmwareVersion || null,
    slug:            slug(info.friendlyName || info.host),
    lastState:       null,   // null = unknown
    online:          null,
  };

  devices.set(key, device);

  // Subscribe to command topic
  client.subscribe(commandTopic(device), { qos: 1 }, (err) => {
    if (err) warn(`Subscribe failed for ${device.friendlyName}: ${err.message}`);
  });

  publishHaDiscovery(device);
  client.publish(availabilityTopic(device), 'online', { retain: true, qos: 1 });

  log(`Registered: ${device.friendlyName} (${key})`);
  return device;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

async function runDiscovery() {
  log('SSDP discovery starting…');
  let found = [];
  try {
    found = await wemo.discoverDevices(8000);
    log(`SSDP found ${found.length} device(s)`);
  } catch (e) {
    warn('SSDP failed: ' + (e?.message ?? String(e)));
  }

  // Merge manual devices
  for (const m of CFG.manualDevices) {
    if (!found.find((d) => d.host === m.host && d.port === (m.port ?? 49153))) {
      try {
        const info = await wemo.getDeviceInfo(m.host, m.port ?? 49153);
        found.push({ host: m.host, port: m.port ?? 49153, ...info });
      } catch {
        found.push({ host: m.host, port: m.port ?? 49153 });
      }
    }
  }

  for (const d of found) {
    registerDevice(d);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollDevices() {
  for (const [key, device] of devices) {
    try {
      const isOn     = await wemo.getBinaryState(device.host, device.port);
      const stateStr = isOn ? 'ON' : 'OFF';

      // Mark online
      if (device.online !== true) {
        device.online = true;
        client.publish(availabilityTopic(device), 'online', { retain: true, qos: 1 });
        if (device.online === false) log(`${device.friendlyName} came back online`);
      }

      // Publish state only on change (or first read)
      if (device.lastState !== stateStr) {
        device.lastState = stateStr;
        client.publish(stateTopic(device), stateStr, { retain: true, qos: 1 });
        log(`${device.friendlyName} → ${stateStr}`);
      }
    } catch (e) {
      if (device.online !== false) {
        device.online = false;
        client.publish(availabilityTopic(device), 'offline', { retain: true, qos: 1 });
        warn(`${device.friendlyName} (${key}) unreachable: ${e?.message ?? String(e)}`);
      }
    }
  }
}

// ── Command handler ───────────────────────────────────────────────────────────

async function handleCommand(topic, payload) {
  const msg = payload.toString().trim().toUpperCase();
  if (msg !== 'ON' && msg !== 'OFF') return;

  // Find device by command topic
  const device = [...devices.values()].find((d) => commandTopic(d) === topic);
  if (!device) return;

  const wantOn = msg === 'ON';
  try {
    await wemo.setBinaryState(device.host, device.port, wantOn);
    // Confirm state by reading back
    await new Promise((r) => setTimeout(r, 1500));
    const confirmed = await wemo.getBinaryState(device.host, device.port);
    const stateStr  = confirmed ? 'ON' : 'OFF';
    device.lastState = stateStr;
    client.publish(stateTopic(device), stateStr, { retain: true, qos: 1 });
    log(`${device.friendlyName} set ${msg} → confirmed ${stateStr}`);
  } catch (e) {
    warn(`${device.friendlyName} command failed: ${e?.message ?? String(e)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting — broker: ${CFG.mqttHost}:${CFG.mqttPort}  HA discovery: ${CFG.haDiscovery}`);

  const connectOpts = {
    host:     CFG.mqttHost,
    port:     CFG.mqttPort,
    will: {
      topic:   bridgeStatusTopic(),
      payload: 'offline',
      retain:  true,
      qos:     1,
    },
  };
  if (CFG.mqttUsername) connectOpts.username = CFG.mqttUsername;
  if (CFG.mqttPassword) connectOpts.password = CFG.mqttPassword;

  client = mqtt.connect(connectOpts);

  client.on('connect', async () => {
    log('Connected to MQTT broker');
    client.publish(bridgeStatusTopic(), 'online', { retain: true, qos: 1 });
    await runDiscovery();
  });

  client.on('message', (topic, payload) => {
    handleCommand(topic, payload).catch((e) =>
      warn('Command handler error: ' + (e?.message ?? String(e)))
    );
  });

  client.on('error',       (e) => warn('MQTT error: '        + (e?.message ?? String(e))));
  client.on('reconnect',   ()  => log('Reconnecting to broker…'));
  client.on('offline',     ()  => warn('MQTT client offline'));
  client.on('disconnect',  ()  => warn('Disconnected from broker'));

  // Poll loop
  setInterval(() => {
    pollDevices().catch((e) => warn('Poll error: ' + (e?.message ?? String(e))));
  }, CFG.pollInterval);

  // Periodic SSDP re-scan
  setInterval(() => {
    runDiscovery().catch((e) => warn('Re-scan error: ' + (e?.message ?? String(e))));
  }, CFG.discoveryInterval);
}

main().catch((e) => {
  console.error('[DWM-MQTT] Fatal:', e?.message ?? String(e));
  process.exit(1);
});
