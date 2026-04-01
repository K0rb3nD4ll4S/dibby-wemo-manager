'use strict';

const wemo = require('../lib/wemo-client');

module.exports = function (RED) {
  function WemoStateNode(config) {
    RED.nodes.createNode(this, config);
    const node   = this;
    const device = RED.nodes.getNode(config.device);

    if (!device) {
      node.error('No Wemo device configured');
      return;
    }

    const interval   = Math.max(1, parseInt(config.interval, 10) || 10) * 1000;
    const onlyChange = config.onlyChange !== false;
    let lastState    = null;
    let timer        = null;

    node.status({ fill: 'grey', shape: 'ring', text: 'waiting…' });

    async function poll() {
      try {
        const isOn     = await wemo.getBinaryState(device.host, device.port);
        const stateStr = isOn ? 'ON' : 'OFF';

        node.status(isOn
          ? { fill: 'green', shape: 'dot',  text: 'ON'  }
          : { fill: 'grey',  shape: 'ring', text: 'OFF' });

        if (!onlyChange || stateStr !== lastState) {
          lastState = stateStr;
          node.send({
            payload: stateStr,
            topic:   device.name || device.host,
            device:  { host: device.host, port: device.port, name: device.name || device.host },
          });
        }
      } catch (e) {
        node.status({ fill: 'red', shape: 'ring', text: 'unreachable' });
        if (lastState !== 'offline') {
          lastState = 'offline';
          node.warn('Device unreachable: ' + (e?.message ?? String(e)));
        }
      }
    }

    // Initial poll then start interval
    poll();
    timer = setInterval(poll, interval);

    node.on('close', () => {
      if (timer) { clearInterval(timer); timer = null; }
    });
  }

  RED.nodes.registerType('wemo-state', WemoStateNode);
};
