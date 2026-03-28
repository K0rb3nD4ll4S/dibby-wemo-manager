'use strict';

/**
 * Homebridge custom UI server for homebridge-dibby-wemo.
 *
 * Runs as a child process managed by homebridge-config-ui-x.
 * Communicates with the frontend via this.onRequest() / homebridge.request().
 *
 * Provides:
 *  - devices.list      → saved device list (from plugin store)
 *  - devices.discover  → trigger SSDP discovery
 *  - devices.state     → get binary state of a device
 *  - devices.setState  → set binary state of a device
 *  - rules.list        → DWM rules from plugin store
 *  - rules.create      → create a DWM rule
 *  - rules.update      → update a DWM rule
 *  - rules.delete      → delete a DWM rule
 *  - rules.wemo.list   → fetch native device rules from a Wemo device
 *  - rules.wemo.toggle → enable / disable a native Wemo device rule
 *  - rules.wemo.delete → delete a native Wemo device rule
 *  - location.get      → get stored location
 *  - location.search   → geocode query via Nominatim
 *  - location.set      → save location
 */

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const path       = require('path');
const DwmStore   = require('../lib/store');
const wemoClient = require('../lib/wemo-client');
const axios      = require('axios');

class DibbyWemoUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Shared store instance — storagePath provided by homebridge-config-ui-x
    this._store = new DwmStore(this.homebridgeStoragePath);

    // ── Devices ─────────────────────────────────────────────────────────────
    this.onRequest('/devices/list', async () => {
      return this._store.getDevices();
    });

    this.onRequest('/devices/discover', async ({ timeout } = {}) => {
      const ms = typeof timeout === 'number' ? timeout : 10_000;
      const devices = await wemoClient.discoverDevices(ms);
      // Persist updated list
      this._store.saveDevices(devices.map((d) => ({
        host: d.host,
        port: d.port,
        udn:  d.udn ?? `${d.host}:${d.port}`,
        friendlyName: d.friendlyName ?? d.host,
        productModel: d.productModel ?? 'Wemo Device',
        firmwareVersion: d.firmwareVersion ?? null,
      })));
      return devices;
    });

    this.onRequest('/devices/state', async ({ host, port }) => {
      return await wemoClient.getBinaryState(host, Number(port));
    });

    this.onRequest('/devices/setState', async ({ host, port, on }) => {
      await wemoClient.setBinaryState(host, Number(port), !!on);
      return { ok: true };
    });

    // ── DWM Rules ────────────────────────────────────────────────────────────
    this.onRequest('/rules/list', async () => {
      return this._store.getDwmRules();
    });

    this.onRequest('/rules/create', async (rule) => {
      return this._store.createDwmRule(rule);
    });

    this.onRequest('/rules/update', async ({ id, updates }) => {
      return this._store.updateDwmRule(id, updates);
    });

    this.onRequest('/rules/delete', async ({ id }) => {
      this._store.deleteDwmRule(id);
      return { ok: true };
    });

    // ── Scheduler heartbeat ───────────────────────────────────────────────────
    this.onRequest('/scheduler/status', async () => {
      const hb = this._store.getHeartbeat();
      if (!hb) return { running: false, stale: false, ts: null };
      const ageMs = Date.now() - new Date(hb.ts).getTime();
      // stale if no heartbeat for > 90 seconds (3 missed ticks)
      return { ...hb, stale: ageMs > 90_000 };
    });

    // ── Native Wemo Device Rules ──────────────────────────────────────────────
    this.onRequest('/rules/wemo/list', async ({ host, port }) => {
      return await wemoClient.fetchRules(host, Number(port));
    });

    this.onRequest('/rules/wemo/toggle', async ({ host, port, ruleId, enabled }) => {
      await wemoClient.toggleRule(host, Number(port), ruleId, !!enabled);
      return { ok: true };
    });

    this.onRequest('/rules/wemo/delete', async ({ host, port, ruleId }) => {
      await wemoClient.deleteRule(host, Number(port), ruleId);
      return { ok: true };
    });

    this.onRequest('/rules/wemo/create', async ({ host, port, ruleData }) => {
      const id = await wemoClient.createRule(host, Number(port), ruleData);
      return { ok: true, id };
    });

    this.onRequest('/rules/wemo/update', async ({ host, port, ruleId, ruleData }) => {
      await wemoClient.updateRule(host, Number(port), ruleId, ruleData);
      return { ok: true };
    });

    // ── Location ──────────────────────────────────────────────────────────────
    this.onRequest('/location/get', async () => {
      return this._store.getLocation();
    });

    this.onRequest('/location/set', async (loc) => {
      this._store.setLocation(loc);
      return { ok: true };
    });

    this.onRequest('/location/search', async ({ query }) => {
      try {
        const res = await axios.get('https://nominatim.openstreetmap.org/search', {
          params: { q: query, format: 'json', limit: 8, addressdetails: 1 },
          headers: { 'User-Agent': 'homebrige-dibby-wemo/1.0' },
          timeout: 8000,
        });
        return (res.data || []).map((r) => ({
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          label: r.display_name,
          city: r.address?.city || r.address?.town || r.address?.village || '',
          country: r.address?.country || '',
        }));
      } catch { return []; }
    });

    this.ready();
  }
}

(() => new DibbyWemoUiServer())();
