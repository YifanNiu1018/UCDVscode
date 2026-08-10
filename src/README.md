# UCDVSC source (`src/`)

Offline C/C++ IDE: VS Code Workbench + v86 Alpine.

| Path | Role |
|------|------|
| **`src/`** | Product source (this directory) |
| `ucdVscode/` | Runtime delivery (`ucdvsc.html`) — build output, not git |
| `v86/` | [copy/v86](https://github.com/copy/v86) at a pinned commit — clone via script, not git |

Monaco/VS Code APIs come from npm (`@codingame/monaco-vscode-*@35.0.3`). You do **not** need to clone or build `monaco-vscode-api`.

## Setup

Needs Docker (Alpine guest) and rustup + `wasm32-unknown-unknown` + make (libv86).

```bash
# from repo root — clones v86, builds emulator + Alpine, packs alpine-vfs.js
bash scripts/setup-v86.sh
cd src && npm install
```

## Build

```bash
cd src
npm run build:classic              # → ../ucdVscode/
```

```
src/
  entry.ts, setup.*.ts, main.*.ts, features/
  guest/                 # Alpine compile_agent + Dockerfile
  build/                 # classic → ucdVscode pack
  offline/               # alpine-vfs.js generator
```
