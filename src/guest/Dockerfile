FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt
# build-base: gcc; nodejs: agent; util-linux: `script` for PTY shell
ENV ADDPKGS="build-base nodejs util-linux"

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none $ADDPKGS

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
