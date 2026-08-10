# Guest Alpine image (UCDVSC)

Upstream v86 lives in `../../v86` (clone with `bash scripts/setup-v86.sh`, do not vendor it).

UCDVSC customizations for the i386 Alpine rootfs:

| Path | Role |
|------|------|
| `/root/ucdvsc_server/compile_agent.js` | Guest RPC `:1234` + shell `:1235` |
| `/root/ucdvsc_server/networking.sh` | virtio-net + DHCP helper |
| `/root/workspace` | Student files (Workbench `/workspace`) |

Build (from repo root), after copying into the upstream alpine docker dir temporarily:

```bash
cp src/guest/compile_agent.js src/guest/Dockerfile v86/tools/docker/alpine/
cd v86/tools/docker/alpine && ./build.sh
# then restore upstream Dockerfile if desired:
#   cd ../../../../v86 && git checkout -- tools/docker/alpine/Dockerfile
#   rm tools/docker/alpine/compile_agent.js
```

Or use `src/guest/build-alpine.sh` (copies, builds, prints cleanup commands).

Without rebuilding Alpine, the Workbench still migrates legacy `/root/compile_agent.js` and `/root/networking.sh` into `/root/ucdvsc_server` on boot.
