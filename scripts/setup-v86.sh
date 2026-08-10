#!/usr/bin/env bash
# Clone copy/v86 at the commit UCDVSC was developed against,
# build libv86, then build the Alpine guest and pack alpine-vfs.js.
# Does not commit upstream into this repo.
set -euo pipefail

V86_REPO="${V86_REPO:-https://github.com/copy/v86.git}"
V86_COMMIT="${V86_COMMIT:-2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${V86_DIR:-$ROOT/v86}"
VFS="$ROOT/ucdVscode/alpine-vfs.js"

if [[ ! -d "$DEST/.git" ]]; then
  echo "==> clone $V86_REPO → $DEST"
  git clone --filter=blob:none "$V86_REPO" "$DEST"
fi

cd "$DEST"
echo "==> checkout $V86_COMMIT"
git fetch --depth 1 origin "$V86_COMMIT" 2>/dev/null || git fetch origin
git checkout --detach "$V86_COMMIT"

if [[ ! -f build/libv86.js || ! -f build/v86.wasm ]]; then
  echo "==> build libv86.js + v86.wasm (needs rustc + wasm32 target; see v86 README)"
  if ! command -v make >/dev/null 2>&1; then
    echo "make not found. Install make, then re-run." >&2
    exit 1
  fi
  if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    echo "rustc/cargo not found. Install rustup: https://rustup.rs/" >&2
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
    exit 1
  fi
  if ! rustc --print target-list 2>/dev/null | grep -qx 'wasm32-unknown-unknown'; then
    echo "wasm32-unknown-unknown target missing." >&2
    if command -v rustup >/dev/null 2>&1; then
      echo "==> rustup target add wasm32-unknown-unknown"
      rustup target add wasm32-unknown-unknown
    else
      echo "Install rustup (not apt rustc), then: rustup target add wasm32-unknown-unknown" >&2
      exit 1
    fi
  fi
  make all
fi

if [[ ! -f images/alpine-fs.json || ! -d images/alpine-rootfs-flat ]]; then
  echo "==> build Alpine guest (Docker; src/guest/Dockerfile)"
  bash "$ROOT/src/guest/build-alpine.sh"
fi

if [[ ! -f "$VFS" ]]; then
  echo "==> pack alpine-vfs.js"
  python3 "$ROOT/src/offline/make-alpine-vfs.py"
fi

echo "done → $DEST @$V86_COMMIT"
echo "      → $VFS"
