'use strict';

/**
 * homebridge-dibby-wemo
 *
 * Homebridge plugin entry point.
 *
 * Registers the DibbyWemo platform so Homebridge discovers Wemo devices and
 * exposes them to HomeKit as Switch accessories. Also runs the DWM scheduler
 * for local time-based automations — no Belkin cloud required.
 */

const { WemoPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./lib/platform');

/**
 * @param {object} api - The Homebridge API object
 */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WemoPlatform);
};
