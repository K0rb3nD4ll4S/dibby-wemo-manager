#!/bin/sh
# ────────────────────────────────────────────────────────────────────────────────
#  Dibby Wemo Manager — container entrypoint
#
#  Responsibilities:
#    - Ensure the data dir exists and is WRITABLE by whatever user the Node
#      server ends up running as.
#    - Honour PUID/PGID envs when set so bind-mounted /data is owned by the
#      host user (LinuxServer-style).
#    - Gracefully fall back to running as root when the unprivileged user
#      can't write the data dir — this is the common case on Synology DSM,
#      where bind-mounted shared folders carry ACLs that block `chown` from
#      inside the container even as root, leaving a dropped-privilege process
#      unable to write and producing:
#         EACCES: permission denied, open '/data/dibby-wemo.json'
#
#  tini (PID 1) catches signals and forwards them regardless of which user
#  the server runs as.
# ────────────────────────────────────────────────────────────────────────────────
set -e

DATA_DIR="${DATA_DIR:-/data}"
PORT="${PORT:-3456}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

log() { echo "[entrypoint] $*"; }

# 1. Make sure the data dir exists (Docker auto-creates a bind-mount source as
#    root:root if the host path didn't exist; this handles the in-container side).
mkdir -p "$DATA_DIR" 2>/dev/null || true

# 2. Re-map the dibby user/group to the requested PUID/PGID if they differ, so
#    files the server writes are owned by the host user the operator expects.
if [ "$(id -u dibby 2>/dev/null)" != "$PUID" ] || [ "$(id -g dibby 2>/dev/null)" != "$PGID" ]; then
    sed -i "s/^dibby:x:[0-9]*:[0-9]*:/dibby:x:$PUID:$PGID:/" /etc/passwd 2>/dev/null || true
    sed -i "s/^dibby:x:[0-9]*:/dibby:x:$PGID:/"               /etc/group  2>/dev/null || true
fi

# 3. Best-effort: give the dibby user ownership of the data dir + app.  On a
#    normal Linux Docker host this succeeds and the server runs unprivileged.
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
chown -R "$PUID:$PGID" /app        2>/dev/null || true

# 4. Decide who actually runs the server.  Probe whether the dibby user can
#    create a file in the data dir; if not (Synology ACL'd share, read-only
#    chown, etc.) fall back to root so writes always succeed.  A working,
#    root-owned install beats a "secure" install that can't save anything.
RUN_AS="dibby:dibby"
PROBE="$DATA_DIR/.dwm-write-test"
if su-exec dibby:dibby sh -c "touch '$PROBE' 2>/dev/null && rm -f '$PROBE' 2>/dev/null"; then
    log "data dir $DATA_DIR is writable as dibby (UID=$PUID GID=$PGID)"
else
    # Try once more to fix it, then re-probe.
    chmod -R u+rwX,g+rwX "$DATA_DIR" 2>/dev/null || true
    if su-exec dibby:dibby sh -c "touch '$PROBE' 2>/dev/null && rm -f '$PROBE' 2>/dev/null"; then
        log "data dir $DATA_DIR writable as dibby after chmod"
    else
        RUN_AS="root"
        log "WARNING: $DATA_DIR not writable as dibby (likely a Synology ACL'd"
        log "         bind-mount). Falling back to running as root so the data"
        log "         store can be written. To run unprivileged instead, point"
        log "         the volume at a plain Docker volume or a folder the"
        log "         container can chown."
    fi
fi

# Final guard: confirm the chosen user can write, else fail loud with a clear
# message instead of the cryptic EACCES from inside Node.
if ! su-exec "$RUN_AS" sh -c "touch '$PROBE' 2>/dev/null && rm -f '$PROBE' 2>/dev/null"; then
    log "FATAL: $DATA_DIR is not writable even as $RUN_AS."
    log "       Check the host folder permissions for your bind mount."
    exit 1
fi

log "starting Dibby Wemo Manager — user=$RUN_AS  DATA_DIR=$DATA_DIR  PORT=$PORT"
exec su-exec "$RUN_AS" node /app/server.js
