# UCDVSC

Offline browser C/C++ IDE: VS Code Workbench + v86 Alpine.

- Source: [`src/`](src/)
- Students: download the Release zip and open `ucdvsc.html`

First-time setup (Docker + rustup with `wasm32-unknown-unknown` + make):

```bash
bash scripts/setup-v86.sh          # v86 + Alpine guest + alpine-vfs.js
cd src && npm install && npm run build:classic
```

See [`src/README.md`](src/README.md) for details.
