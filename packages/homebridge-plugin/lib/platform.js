'use strict';

/**
 * WemoPlatform
 *
 * Homebridge platform plugin. Discovers Wemo devices via SSDP (and any
 * manually-configured hosts), registers each as a Switch accessory, and
 * runs the DWM local scheduler for time-based automation rules.
 */

const DwmStore         = require('./store');
const wemoClient       = require('./wemo-client');
const DwmScheduler     = require('./scheduler');
const WemoSwitchAccessory = require('./accessory');

const PLUGIN_NAME   = 'homebridge-dibby-wemo';
const PLATFORM_NAME = 'DibbyWemo';

class WemoPlatform {
  /**
   * @param {object} log    - Homebridge logger
   * @param {object} config - Platform config from config.json
   * @param {object} api    - Homebridge API
   */
  constructor(log, config, api) {
    this.log    = log;
    this.config = config ?? {};
    this.api    = api;

    this._accessories = new Map();   // uuid → PlatformAccessory
    this._handlers    = new Map();   // uuid → WemoSwitchAccessory

    // Store in Homebridge's user storage directory
    this._store = new DwmStore(api.user.storagePath());

    // Location is set via the custom UI settings panel (city search) and stored
    // in the plugin's DwmStore — no raw lat/lng in config.json needed.

    // DWM Scheduler
    this._scheduler = new DwmScheduler({
      store:      this._store,
      wemoClient,
      log,
    });
    this._scheduler.onFire(({ success, msg }) => {
      if (success) log.info('[DWM] ' + msg);
      else         log.warn('[DWM] ' + msg);
    });

    // Homebridge calls didFinishLaunching once the restore cache is ready
    api.on('didFinishLaunching', () => {
      this._discoverDevices();
      this._scheduler.start().catch((e) => log.error('[DWM Scheduler] Start failed: ' + e.message));
    });

    log.info('DibbyWemo platform initialised');
  }

  // ── Homebridge lifecycle ──────────────────────────────────────────────────

  /**
   * Called for each accessory restored from cache on startup.
   * We immediately attach handlers using the device context stored in the
   * accessory so HomeKit requests don't time out during the SSDP window.
   */
  configureAccessory(accessory) {
    this.log.info('Restoring cached accessory: ' + accessory.displayName);
    this._accessories.set(accessory.UUID, accessory);

    // Re-attach handlers right away if we have saved device context
    const device = accessory.context?.device;
    if (device?.host && device?.port) {
      const pollInterval = this.config.pollInterval ?? 30;
      this._handlers.get(accessory.UUID)?.stopPolling();
      const handler = new WemoSwitchAccessory({
        platform: this,
        accessory,
        device,
        wemoClient,
        pollInterval,
      });
      this._handlers.set(accessory.UUID, handler);
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  async _discoverDevices() {
    const timeout      = this.config.discoveryTimeout ?? 10_000;
    const pollInterval = this.config.pollInterval     ?? 30;

    this.log.info('Starting Wemo device discovery…');
    let discovered = [];
    try {
      discovered = await wemoClient.discoverDevices(timeout);
    } catch (e) {
      this.log.error('SSDP discovery failed: ' + e.message);
    }

    // Merge in manually-configured devices
    const manual = (this.config.manualDevices ?? []).map(({ host, port }) => ({
      host, port: port ?? 49153,
    }));
    for (const m of manual) {
      if (!discovered.find((d) => d.host === m.host && d.port === m.port)) {
        try {
          const info = await wemoClient.getDeviceInfo(m.host, m.port);
          discovered.push({ ...m, ...info });
        } catch {
          discovered.push(m);
        }
      }
    }

    this.log.info(`Found ${discovered.length} Wemo device(s)`);

    // Save discovered device list for the custom UI
    this._store.saveDevices(discovered.map((d) => ({
      host: d.host,
      port: d.port,
      udn:  d.udn ?? `${d.host}:${d.port}`,
      friendlyName: d.friendlyName ?? d.host,
      productModel: d.productModel ?? 'Wemo Device',
      firmwareVersion: d.firmwareVersion ?? null,
    })));

    for (const device of discovered) {
      this._registerDevice(device, pollInterval);
    }

    // Remove stale accessories (devices no longer discovered)
    const activeUUIDs = new Set(discovered.map((d) => this._uuidForDevice(d)));
    for (const [uuid, acc] of this._accessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory: ' + acc.displayName);
        this._handlers.get(uuid)?.stopPolling();
        this._handlers.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this._accessories.delete(uuid);
      }
    }
  }

  _uuidForDevice(device) {
    const id = device.udn ?? `${device.host}:${device.port}`;
    return this.api.hap.uuid.generate(id);
  }

  _registerDevice(device, pollInterval) {
    const uuid = this._uuidForDevice(device);
    const name = device.friendlyName ?? device.host;

    let accessory = this._accessories.get(uuid);

    if (!accessory) {
      this.log.info('Adding new accessory: ' + name);
      accessory = new this.api.platformAccessory(name, uuid);
      this._accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      accessory.displayName = name;
    }

    // Persist device connection info so configureAccessory can restore it on
    // the next restart without waiting for SSDP to complete.
    accessory.context.device = {
      host:            device.host,
      port:            device.port,
      udn:             device.udn             ?? `${device.host}:${device.port}`,
      friendlyName:    device.friendlyName    ?? device.host,
      productModel:    device.productModel    ?? 'Wemo Device',
      firmwareVersion: device.firmwareVersion ?? null,
    };

    // (Re)create handler so device info is up to date
    this._handlers.get(uuid)?.stopPolling();
    const handler = new WemoSwitchAccessory({
      platform: this,
      accessory,
      device,
      wemoClient,
      pollInterval,
    });
    this._handlers.set(uuid, handler);
  }
}

module.exports = { WemoPlatform, PLUGIN_NAME, PLATFORM_NAME };
