#!/bin/bash
# ────────────────────────────────────────────────────────────────────────────────
#  build-spk.sh — assemble Synology .spk packages for DSM 7.
#
#  Builds one .spk per target architecture into ./dist/.
#  Each .spk is a self-contained installer that pulls in:
#    - bundled Node 20 LTS binary for the target arch
#    - the docker/server.js + lib/ + web/ bundle (same code as the Docker image)
#    - DSM lifecycle scripts in packages/synology-spk/scripts/
#
#  Prereqs:
#    - bash, tar, xz, curl
#    - run from anywhere; paths resolve relative to this script
#
#  Usage:
#    ./packages/synology-spk/build-spk.sh                 # all arches
#    ARCHES="apollolake geminilake" ./build-spk.sh        # subset
#    VERSION=2.0.27 ./build-spk.sh                        # explicit version
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SPK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SPK_DIR/../.." && pwd)"
DIST="$SPK_DIR/dist"
STAGE_ROOT="$SPK_DIR/.stage"

VERSION="${VERSION:-$(node -p "require('$REPO_ROOT/package.json').version")}"
ARCHES="${ARCHES:-apollolake geminilake denverton broadwell rtd1296}"

# DSM arch → Node download arch
node_arch_for_dsm() {
    case "$1" in
        apollolake|geminilake|denverton|broadwell|kvmx64|x86_64)  echo "x64"   ;;
        rtd1296|rtd1619b|aarch64|armv8)                            echo "arm64" ;;
        *) echo "unsupported"; return 1 ;;
    esac
}

NODE_VERSION="${NODE_VERSION:-20.17.0}"

download_node() {
    local arch="$1"
    local cache="$SPK_DIR/.cache/node-v${NODE_VERSION}-linux-${arch}"
    if [ -f "$cache/bin/node" ]; then
        echo "$cache"
        return
    fi
    mkdir -p "$SPK_DIR/.cache"
    local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"
    echo "==> Downloading Node $NODE_VERSION for $arch" >&2
    curl -sSL "$url" | tar -xJ -C "$SPK_DIR/.cache"
    echo "$cache"
}

build_one() {
    local DSM_ARCH="$1"
    local NODE_ARCH
    NODE_ARCH="$(node_arch_for_dsm "$DSM_ARCH")"
    if [ "$NODE_ARCH" = "unsupported" ]; then
        echo "==> Skipping $DSM_ARCH (no Node mapping)" >&2
        return
    fi

    echo
    echo "════════════════════════════════════════════════════════════════════"
    echo " Building dibby-wemo-manager_${DSM_ARCH}_${VERSION}.spk"
    echo "════════════════════════════════════════════════════════════════════"

    local NODE_DIR
    NODE_DIR="$(download_node "$NODE_ARCH")"

    local STAGE="$STAGE_ROOT/$DSM_ARCH"
    rm -rf "$STAGE"
    mkdir -p "$STAGE/package/bin" "$STAGE/package/app" "$STAGE/scripts" "$STAGE/conf" "$STAGE/ui"

    # ── INFO ────────────────────────────────────────────────────────────────
    sed -e "s/@VERSION@/${VERSION}/g" -e "s/@ARCH@/${DSM_ARCH}/g" \
        "$SPK_DIR/INFO.tmpl" > "$STAGE/INFO"

    # ── package/ payload ────────────────────────────────────────────────────
    # Bundled Node binary
    cp "$NODE_DIR/bin/node" "$STAGE/package/bin/node"
    chmod 755 "$STAGE/package/bin/node"

    # App bundle — same as Docker image content (server.js + lib/ + web/)
    cp "$REPO_ROOT/docker/server.js" "$STAGE/package/app/"
    cp -r "$REPO_ROOT/packages/homebridge-plugin/lib"  "$STAGE/package/app/lib"
    cp -r "$REPO_ROOT/apps/desktop/resources/web"      "$STAGE/package/app/web"
    cp "$REPO_ROOT/apps/desktop/resources/icon.png"    "$STAGE/package/app/icon.png" || true

    # Install runtime deps into the bundle
    (
        cd "$STAGE/package/app"
        # Write a minimal package.json so npm install is well-defined
        cat > package.json <<JSON
{
  "name": "dibby-wemo-manager-app",
  "version": "${VERSION}",
  "private": true,
  "dependencies": {
    "adm-zip": "^0.5.14",
    "axios": "^1.7.0",
    "sql.js": "^1.12.0",
    "ws": "^8.18.0",
    "xml2js": "^0.6.2",
    "xmlbuilder2": "^4.0.3",
    "hap-nodejs": "^0.14.3",
    "qrcode": "^1.5.4"
  }
}
JSON
        npm install --omit=dev --no-audit --no-fund --silent
    )

    # ── conf / scripts / ui ─────────────────────────────────────────────────
    cp -r "$SPK_DIR/conf/"*    "$STAGE/conf/"
    cp -r "$SPK_DIR/scripts/"* "$STAGE/scripts/"
    chmod 755 "$STAGE/scripts/"*
    cp -r "$SPK_DIR/ui/"*      "$STAGE/ui/"

    # ── icons ───────────────────────────────────────────────────────────────
    if [ -f "$SPK_DIR/PACKAGE_ICON.PNG" ]; then
        cp "$SPK_DIR/PACKAGE_ICON.PNG"     "$STAGE/PACKAGE_ICON.PNG"
    else
        cp "$REPO_ROOT/apps/desktop/resources/icon.png" "$STAGE/PACKAGE_ICON.PNG"
    fi
    [ -f "$SPK_DIR/PACKAGE_ICON_256.PNG" ] && cp "$SPK_DIR/PACKAGE_ICON_256.PNG" "$STAGE/PACKAGE_ICON_256.PNG"

    # ── package.tgz (the payload archive DSM expects inside .spk) ───────────
    (
        cd "$STAGE/package"
        tar -czf "$STAGE/package.tgz" .
    )
    rm -rf "$STAGE/package"

    # ── final .spk archive ──────────────────────────────────────────────────
    mkdir -p "$DIST"
    local SPK_NAME="dibby-wemo-manager_${DSM_ARCH}_${VERSION}.spk"
    (
        cd "$STAGE"
        # SPK files are tar archives (NOT compressed at the outer layer).
        tar -cf "$DIST/$SPK_NAME" \
            INFO PACKAGE_ICON.PNG \
            $( [ -f PACKAGE_ICON_256.PNG ] && echo PACKAGE_ICON_256.PNG ) \
            package.tgz scripts conf ui
    )

    echo "==> Built: $DIST/$SPK_NAME ($(du -h "$DIST/$SPK_NAME" | cut -f1))"
}

mkdir -p "$DIST"
rm -rf "$STAGE_ROOT"

for ARCH in $ARCHES; do
    build_one "$ARCH"
done

echo
echo "════════════════════════════════════════════════════════════════════"
echo " All builds complete.  Artifacts in:  $DIST"
echo "════════════════════════════════════════════════════════════════════"
ls -lh "$DIST"
