#!/usr/bin/env bash
# Build Alpine+gcc guest image using UCD Dockerfile/agent, without permanently
# dirtying the upstream v86 tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ALPINE="$ROOT/v86/tools/docker/alpine"
cp "$ROOT/src/guest/compile_agent.js" "$ALPINE/compile_agent.js"
cp "$ROOT/src/guest/Dockerfile" "$ALPINE/Dockerfile"
( cd "$ALPINE" && ./build.sh )
echo "Alpine image built. Upstream files still modified in $ALPINE — run:"
echo "  (cd \"$ROOT/v86\" && git checkout -- tools/docker/alpine/Dockerfile && rm -f tools/docker/alpine/compile_agent.js)"
