FROM node:20-alpine

LABEL maintainer="SRS IT" \
      org.opencontainers.image.title="Dibby Wemo Manager" \
      org.opencontainers.image.description="Headless Belkin Wemo scheduler + web remote — no cloud required" \
      org.opencontainers.image.source="https://github.com/K0rb3nD4ll4S/dibby-wemo-manager"

WORKDIR /app

# Copy package manifest first for layer caching
COPY docker/package.json ./package.json

# Install production dependencies
RUN npm install --production

# Copy application code
COPY packages/homebridge-plugin/lib ./lib
COPY docker/server.js ./server.js

# Copy mobile web UI and icon
COPY apps/desktop/resources/web ./web
COPY apps/desktop/resources/icon.png ./icon.png

# Persistent data volume (stores dibby-wemo.json config + rules)
VOLUME /data

ENV DATA_DIR=/data \
    PORT=3456

EXPOSE 3456

# NOTE: Wemo SSDP discovery requires --network host on Linux Docker hosts.
# On macOS Docker Desktop, host networking is not supported — add devices
# manually via the web UI or the REST API instead.

CMD ["node", "server.js"]
