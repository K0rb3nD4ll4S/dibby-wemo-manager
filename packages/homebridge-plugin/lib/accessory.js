'use strict';

/**
 * WemoSwitchAccessory
 *
 * Represents a single Wemo device as a HomeKit Switch.
 * State is polled on the configured interval and pushed to HomeKit.
 */

class WemoSwitchAccessory {
  /**
   * @param {object} params
   * @param {object}  params.platform     - WemoPlatform instance
   * @param {object}  params.accessory    - PlatformAccessory from Homebridge
   * @param {object}  params.device       - { host, port, udn, friendlyName, ... }
   * @param {object}  params.wemoClient   - wemo-client module
   * @param {number}  params.pollInterval - poll interval in seconds
   */
  constructor({ platform, accessory, device, wemoClient, pollInterval = 30 }) {
    this.platform     = platform;
    this.accessory    = accessory;
    this.device       = device;
    this.wemo         = wemoClient;
    this.pollInterval = pollInterval;
    this.log          = platform.log;

    const { Service, Characteristic } = platform.api.hap;

    // ── Accessory information ───────────────────────────────────────────────
    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Belkin')
      .setCharacteristic(Characteristic.Model, device.productModel ?? 'Wemo Switch')
      .setCharacteristic(Characteristic.SerialNumber, device.udn ?? device.host);

    // ── Switch service ──────────────────────────────────────────────────────
    this.switchService = this.accessory.getService(Service.Switch)
      || this.accessory.addService(Service.Switch, device.friendlyName ?? device.host);

    this.switchService.getCharacteristic(Characteristic.On)
      .onGet(this._getOn.bind(this))
      .onSet(this._setOn.bind(this));

    // ── Initial state + poll ────────────────────────────────────────────────
    this._currentState = false;
    this._pollTimer    = null;
    this._startPolling();
  }

  // ── HomeKit handlers ──────────────────────────────────────────────────────

  async _getOn() {
    try {
      this._currentState = await this.wemo.getBinaryState(this.device.host, this.device.port);
    } catch (e) {
      this.log.warn(`[${this.device.friendlyName}] getBinaryState failed: ${e.message}`);
    }
    return this._currentState;
  }

  async _setOn(value) {
    try {
      await this.wemo.setBinaryState(this.device.host, this.device.port, !!value);
      this._currentState = !!value;
    } catch (e) {
      this.log.error(`[${this.device.friendlyName}] setBinaryState failed: ${e.message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
      );
    }
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._pollTimer = setInterval(async () => {
      try {
        const newState = await this.wemo.getBinaryState(this.device.host, this.device.port);
        if (newState !== this._currentState) {
          this._currentState = newState;
          const { Characteristic } = this.platform.api.hap;
          this.switchService.updateCharacteristic(Characteristic.On, newState);
        }
      } catch { /* device unreachable — keep last state */ }
    }, this.pollInterval * 1000);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

module.exports = WemoSwitchAccessory;
