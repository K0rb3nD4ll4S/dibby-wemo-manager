'use strict';

const wemo = require('../lib/wemo-client');

module.exports = function (RED) {
  function WemoControlNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const device = RED.nodes.getNode(config.device);

    if (!device) {
      node.error('No Wemo device configured');
      return;
    }

    node.status({ fill: 'grey', shape: 'ring', text: 'unknown' });

    // Refresh state on deploy
    wemo.getBinaryState(device.host, device.port)
      .then((on) => setStatus(node, on))
      .catch(() => node.status({ fill: 'red', shape: 'ring', text: 'unreachable' }));

    node.on('input', async (msg, send, done) => {
      const raw = msg.payload;
      let wantOn;

      if (raw === 'toggle' || raw === 'TOGGLE') {
        try {
          const current = await wemo.getBinaryState(device.host, device.port);
          wantOn = !current;
        } catch (e) {
          node.error('Toggle failed — could not read state: ' + (e?.message ?? String(e)), msg);
          done(e);
          return;
        }
      } else if (raw === true  || raw === 1 || raw === 'ON'  || raw === 'on')  { wantOn = true;  }
      else if   (raw === false || raw === 0 || raw === 'OFF' || raw === 'off') { wantOn = false; }
      else {
        node.warn('Unrecognised payload: ' + JSON.stringify(raw) + ' — use ON/OFF/true/false/1/0/toggle');
        done();
        return;
      }

      try {
        await wemo.setBinaryState(device.host, device.port, wantOn);
        // Short delay then confirm
        await new Promise((r) => setTimeout(r, 1200));
        const confirmed = await wemo.getBinaryState(device.host, device.port);
        setStatus(node, confirmed);
        msg.payload = confirmed ? 'ON' : 'OFF';
        msg.topic   = device.name || device.host;
        send(msg);
        done();
      } catch (e) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        node.error('Command failed: ' + (e?.message ?? String(e)), msg);
        done(e);
      }
    });

    node.on('close', () => {});
  }

  RED.nodes.registerType('wemo-control', WemoControlNode);
};

function setStatus(node, isOn) {
  node.status(isOn
    ? { fill: 'green', shape: 'dot',  text: 'ON'  }
    : { fill: 'grey',  shape: 'ring', text: 'OFF' });
}
