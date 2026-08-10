#!/usr/bin/env bash
# Clone copy/v86 at the commit UCDVSC was developed against,
# fetch libv86 (prebuilt by default), then build the Alpine guest and
# pack alpine-vfs.js. Does not commit upstream into this repo.
set -euo pipefail

V86_REPO="${V86_REPO:-https://github.com/copy/v86.git}"
V86_COMMIT="${V86_COMMIT:-2f1346b0e7d88d4cbbbcc05fe15b4e369c3de23f}"
# Official CI artifacts for that commit (v86 only publishes the moving "latest" tag).
V86_PREBUILT_BASE="${V86_PREBUILT_BASE:-https://github.com/copy/v86/releases/download/latest}"
V86_BUILD_FROM_SOURCE="${V86_BUILD_FROM_SOURCE:-0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${V86_DIR:-$ROOT/v86}"
VFS="$ROOT/ucdVscode/alpine-vfs.js"

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -nv -O "$out" "$url"
  else
    echo "need curl or wget to download $url" >&2
    return 1
  fi
}

download_prebuilt() {
  mkdir -p build
  echo "==> download prebuilt libv86.js + v86.wasm"
  echo "    $V86_PREBUILT_BASE"
  download "$V86_PREBUILT_BASE/libv86.js" build/libv86.js
  download "$V86_PREBUILT_BASE/v86.wasm" build/v86.wasm
  if [[ ! -s build/libv86.js || ! -s build/v86.wasm ]]; then
    echo "downloaded empty libv86.js / v86.wasm" >&2
    return 1
  fi
  python3 - <<'PY'
from pathlib import Path
wasm = Path("build/v86.wasm").read_bytes()
if wasm[:4] != b"\0asm":
    raise SystemExit(f"v86.wasm is not a wasm module (magic={wasm[:4]!r})")
print(f"      libv86.js {Path('build/libv86.js').stat().st_size} bytes")
print(f"      v86.wasm  {Path('build/v86.wasm').stat().st_size} bytes")
PY
}

ensure_wasm_std() {
  if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    echo "rustc/cargo not found. Install rustup: https://rustup.rs/" >&2
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
    exit 1
  fi
  local sys
  sys="$(rustc --print sysroot)/lib/rustlib/wasm32-unknown-unknown"
  if [[ -d "$sys" ]]; then
    return 0
  fi
  if command -v rustup >/dev/null 2>&1; then
    echo "==> rustup target add wasm32-unknown-unknown"
    rustup target add wasm32-unknown-unknown
    if [[ -d "$sys" ]]; then
      return 0
    fi
  fi
  echo "wasm32 rust-std is not installed (apt rustc cannot build v86.wasm)." >&2
  echo "Install rustup, then: rustup target add wasm32-unknown-unknown" >&2
  echo "Or unset V86_BUILD_FROM_SOURCE and re-run to download prebuilt binaries." >&2
  exit 1
}

if [[ ! -d "$DEST/.git" ]]; then
  echo "==> clone $V86_REPO → $DEST"
  git clone --filter=blob:none "$V86_REPO" "$DEST"
fi

cd "$DEST"
echo "==> checkout $V86_COMMIT"
git fetch --depth 1 origin "$V86_COMMIT" 2>/dev/null || git fetch origin
git checkout --detach "$V86_COMMIT"

if [[ ! -f build/libv86.js || ! -f build/v86.wasm ]]; then
  if [[ "$V86_BUILD_FROM_SOURCE" == "1" ]]; then
    echo "==> build libv86.js + v86.wasm from source"
    if ! command -v make >/dev/null 2>&1; then
      echo "make not found. Install make, then re-run." >&2
      exit 1
    fi
    ensure_wasm_std
    make all
  else
    download_prebuilt
  fi
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
