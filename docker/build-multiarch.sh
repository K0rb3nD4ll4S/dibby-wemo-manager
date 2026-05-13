#!/bin/bash
# ────────────────────────────────────────────────────────────────────────────────
#  Build & push a multi-arch Dibby Wemo Manager container image.
#
#  Targets:  linux/amd64  (Intel/AMD Synology, generic x86_64 Linux)
#            linux/arm64  (Realtek-based Synology, Raspberry Pi 4/5, Apple silicon)
#
#  Prereqs:
#    - Docker buildx (Docker 20.10+ ships it; `docker buildx version` to confirm)
#    - `docker login ghcr.io` (or set GITHUB_TOKEN and let CI handle it)
#
#  Usage:
#    ./docker/build-multiarch.sh                # pushes :latest + :<git-tag>
#    VERSION=2.0.27 ./docker/build-multiarch.sh # explicit version override
#    NO_PUSH=1 ./docker/build-multiarch.sh      # build locally without pushing
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-ghcr.io/k0rb3nd4ll4s/dibby-wemo-manager}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

echo "==> Building $IMAGE for $PLATFORMS"
echo "    Version tags: $VERSION, latest"

if ! docker buildx ls | grep -q dibby-builder; then
    docker buildx create --name dibby-builder --use --bootstrap
else
    docker buildx use dibby-builder
fi

PUSH_FLAG="--push"
[ "${NO_PUSH:-0}" = "1" ] && PUSH_FLAG="--load"

docker buildx build \
    --platform "$PLATFORMS" \
    --file docker/Dockerfile \
    --tag "$IMAGE:$VERSION" \
    --tag "$IMAGE:latest" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    $PUSH_FLAG \
    .

echo "==> Done.  Pull with:  docker pull $IMAGE:$VERSION"
