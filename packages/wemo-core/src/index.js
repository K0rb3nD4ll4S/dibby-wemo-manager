'use strict';

/**
 * @wemo-manager/core
 *
 * Shared utilities for both the Electron desktop app and the Homebridge plugin.
 */

const sun   = require('./sun');
const types = require('./types');

module.exports = {
  ...sun,
  ...types,
};
