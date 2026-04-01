'use strict';

module.exports = function (RED) {
  function WemoConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.host = config.host;
    this.port = parseInt(config.port, 10) || 49153;
    this.name = config.name || this.host;
  }

  RED.nodes.registerType('wemo-config', WemoConfigNode);
};
