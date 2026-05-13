#!/bin/sh
# ────────────────────────────────────────────────────────────────────────────────
#  Dibby Wemo Manager — container entrypoint
#
#  Responsibilities:
#    - Honour PUID/PGID envs so bind-mounted /data is writable by the host user
#      (Synology's docker volumes default to UID/GID 1026/100; Linux is usually
#      1000/1000; the user passes their own in the compose file).
#    - Ensure /data exists with correct ownership.
#    - Drop privileges to the dibby user and exec the Node server.  tini (PID 1)
#      catches signals and forwards them.
#
#  Everything below runs as root briefly — only for setup; the actual app is
#  exec'd under su-exec so HAP and the scheduler never see root.
# ────────────────────────────────────────────────────────────────────────────────
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Re-map the dibby user/group to the requested PUID/PGID if they differ.
# This lets users bind-mount a Synology share without permission errors.
if [ "$(id -u dibby)" != "$PUID" ] || [ "$(id -g dibby)" != "$PGID" ]; then
    # Best-effort — alpine's `addgroup`/`adduser` won't allow renaming; use
    # sed against the password/group files directly. Safe inside a container.
    sed -i "s/^dibby:x:[0-9]*:[0-9]*:/dibby:x:$PUID:$PGID:/" /etc/passwd
    sed -i "s/^dibby:x:[0-9]*:/dibby:x:$PGID:/"               /etc/group
fi

mkdir -p "${DATA_DIR:-/data}"
chown -R "$PUID:$PGID" "${DATA_DIR:-/data}" /app 2>/dev/null || true

echo "[entrypoint] starting Dibby Wemo Manager"
echo "[entrypoint] running as UID=$PUID GID=$PGID  DATA_DIR=${DATA_DIR:-/data}  PORT=${PORT:-3456}"

# Replace shell with the Node server under the unprivileged user.
exec su-exec dibby:dibby node /app/server.js
