FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt
# build-base: gcc; nodejs: agent + pyright; util-linux: `script` for PTY shell;
# python3: actually run student code (pyright analyses via its own typeshed)
ENV ADDPKGS="build-base nodejs util-linux python3 gdb"
# Host npm may point at npmmirror; use the public registry when building in the US.
ENV npm_config_registry=https://registry.npmjs.org/

# Retry apk on transient CDN stalls instead of hanging for hours.
RUN for n in 1 2 3; do \
      apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none && break; \
      echo "apk base attempt $n failed, retrying..." >&2; sleep 15; \
    done

RUN for n in 1 2 3; do \
      apk add $ADDPKGS && break; \
      echo "apk tools attempt $n failed, retrying..." >&2; sleep 15; \
    done

# Pyright backs the browser's LSP client over the agent's :1236 port. It is pure
# JS, so npm is only a build-time fetcher; dropping it again keeps ~40 MB of
# tooling out of the exported rootfs (docker export flattens layers).
RUN apk add --no-cache npm \
 && npm install -g --omit=dev --registry="${npm_config_registry}" pyright@1.1.413 \
 && apk del npm \
 && rm -rf /root/.npm /root/.cache /tmp/*

RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd

RUN setup-hostname localhost

RUN mkdir -p /root/ucdvsc_server /root/workspace
RUN echo -e "rmmod ne2k-pci 2>/dev/null; modprobe ne2k-pci 2>/dev/null\nrmmod virtio-net 2>/dev/null; modprobe virtio-net\nhwclock -s\nsetup-interfaces -a -r" > /root/ucdvsc_server/networking.sh && chmod +x /root/ucdvsc_server/networking.sh

COPY compile_agent.js /root/ucdvsc_server/compile_agent.js
RUN printf '%s\n' \
  '#include <stdio.h>' \
  '' \
  'int main(void)' \
  '{' \
  '    puts("hello from guest workspace");' \
  '    return 0;' \
  '}' > /root/workspace/main.c

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
