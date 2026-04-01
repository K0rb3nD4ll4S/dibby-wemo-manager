'use strict';

const wemo = require('../lib/wemo-client');

module.exports = function (RED) {
  function WemoDiscoverNode(config) {
    RED.nodes.createNode(this, config);
    const node    = this;
    const timeout = Math.max(2, parseInt(config.timeout, 10) || 8) * 1000;

    node.status({ fill: 'grey', shape: 'ring', text: 'idle' });

    node.on('input', async (msg, send, done) => {
      node.status({ fill: 'yellow', shape: 'ring', text: 'scanning…' });

      try {
        const devices = await wemo.discoverDevices(timeout);

        if (devices.length === 0) {
          node.status({ fill: 'yellow', shape: 'ring', text: 'none found' });
          done();
          return;
        }

        node.status({ fill: 'green', shape: 'dot', text: `${devices.length} found` });

        // Emit one message per device
        for (const d of devices) {
          send({
            payload: {
              host:            d.host,
              port:            d.port,
              friendlyName:    d.friendlyName    || d.host,
              udn:             d.udn             || `${d.host}:${d.port}`,
              productModel:    d.productModel    || 'Wemo Device',
              firmwareVersion: d.firmwareVersion || null,
            },
            topic: d.friendlyName || d.host,
          });
        }

        done();
      } catch (e) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        node.error('Discovery failed: ' + (e?.message ?? String(e)), msg);
        done(e);
      }
    });

    node.on('close', () => {});
  }

  RED.nodes.registerType('wemo-discover', WemoDiscoverNode);
};
