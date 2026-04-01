FROM node:20-alpine

LABEL maintainer="SRS IT" \
      org.opencontainers.image.title="Dibby Wemo MQTT Bridge" \
      org.opencontainers.image.description="Bridges Belkin Wemo devices to MQTT with Home Assistant auto-discovery" \
      org.opencontainers.image.source="https://github.com/K0rb3nD4ll4S/dibby-wemo-manager"

WORKDIR /app

# Copy package manifest first for layer caching
COPY packages/mqtt-bridge/package.json ./package.json

# Install production dependencies
RUN npm install --production

# Copy bridge source
COPY packages/mqtt-bridge/src ./src

# Copy wemo-client library (reused from homebridge plugin)
COPY packages/homebridge-plugin/lib ./lib

ENV MQTT_HOST=localhost \
    MQTT_PORT=1883 \
    POLL_INTERVAL=10 \
    DISCOVERY_INTERVAL=120 \
    HA_DISCOVERY=true \
    HA_DISCOVERY_PREFIX=homeassistant \
    MQTT_TOPIC_PREFIX=dibby-wemo

# NOTE: Run with --network host on Linux to enable SSDP multicast discovery.
# On macOS Docker Desktop host networking is unsupported — use MANUAL_DEVICES instead.

CMD ["node", "src/index.js"]
