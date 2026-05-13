# syntax=docker/dockerfile:1.7

# ────────────────────────────────────────────────────────────────────────────────
#  Dibby Wemo Manager — multi-arch container image
#
#  Targets:  linux/amd64  (Intel/AMD Synology, generic x86_64)
#            linux/arm64  (Realtek-based Synology, Raspberry Pi 4/5, Apple silicon)
#
#  Runtime base is real Node.js 20 LTS (NOT Electron's BoringSSL build) — this is
#  mandatory because hap-nodejs needs the `chacha20-poly1305` cipher exposed,
#  which BoringSSL doesn't provide.
#
#  Build:
#    docker buildx build --platform linux/amd64,linux/arm64 \
#      -t srsit/dibby-wemo-manager:latest --push .
# ────────────────────────────────────────────────────────────────────────────────

# ── Stage 1: assemble the bundle from the monorepo ─────────────────────────────
FROM node:20-alpine AS build

WORKDIR /build

# Copy the docker entry + manifests and the reusable JS bundles from the
# Homebridge plugin (already battle-tested as a headless Node module).
COPY docker/package.json                       ./
COPY docker/server.js                          ./
COPY docker/entrypoint.sh                      ./
COPY packages/homebridge-plugin/lib/           ./lib/
COPY apps/desktop/resources/web/               ./web/
COPY apps/desktop/resources/icon.png           ./icon.png

# Install runtime deps only — sql.js + axios + ws + xml libs + hap-nodejs for HK.
# `--omit=dev` keeps the layer small; `--no-audit --no-fund` quiets npm noise.
RUN npm install --omit=dev --no-audit --no-fund \
        adm-zip@^0.5.14 \
        axios@^1.7.0 \
        sql.js@^1.12.0 \
        ws@^8.18.0 \
        xml2js@^0.6.2 \
        xmlbuilder2@^4.0.3 \
        hap-nodejs@^0.14.3 \
        qrcode@^1.5.4

RUN chmod +x entrypoint.sh

# ── Stage 2: minimal runtime image ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="Dibby Wemo Manager"
LABEL org.opencontainers.image.description="Belkin Wemo local control — DWM rules engine + HomeKit bridge + web UI"
LABEL org.opencontainers.image.source="https://github.com/K0rb3nD4ll4S/dibby-wemo-manager"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="SRS IT"

# Tiny system deps: tini for proper PID-1 signal handling, su-exec for the
# Synology run-as-user model, curl for HEALTHCHECK.
RUN apk add --no-cache tini su-exec curl

# Non-root run user (mapped at container start to host UID via PUID/PGID envs)
RUN addgroup -g 1000 dibby && \
    adduser  -D -u 1000 -G dibby -h /app -s /sbin/nologin dibby

WORKDIR /app

COPY --from=build --chown=dibby:dibby /build/ /app/

# Default data dir — bind a host volume here for persistence.
RUN mkdir -p /data && chown dibby:dibby /data

# Default HTTP port.  HomeKit uses ephemeral ports and only works under
# `network_mode: host` (or macvlan / proper mDNS reflection).
ENV PORT=3456 \
    DATA_DIR=/data \
    NODE_ENV=production

EXPOSE 3456

# 60-second start grace, then poll once a minute.  Status endpoint is on
# server.js's /api/scheduler/status and returns 200 once the daemon's up.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/api/scheduler/status" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
