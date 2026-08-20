/**
 * V86Compiler: boot the Alpine guest, bring up the TCP agent (serial fallback),
 * upload the guest agent over serial, and compile/run C. Transport selectable
 * via ?ucdTransport=auto|tcp|serial.
 */
import {
  AGENT_PORT,
  describeAdapter,
  guestRpc,
  GUEST_SERVER,
  isGuestControlReady,
  probePort,
  setGuestControlReady,
  setGuestNetworkAdapter,
  probeAgentPing,
  waitForAgentPing
} from './guestBridge'
import { ensureGuestScreenContainer } from './guestConsole'
import {
  restoreGuestWorkspace,
  startGuestWorkspacePersist,
  startGuestVmStatePersist,
  markGuestVmDirty,
  clearVmStateSnapshot,
  loadVmStateBuffer,
  GUEST_RAM_BYTES,
  GUEST_VGA_BYTES
} from './guestFsPersist'
import { loadScript, prepareFileProtocolV86, type V86Emulator } from './v86Runtime'
import compileAgentSrc from '../guest/compile_agent.js?raw'

export type Transport = 'tcp' | 'serial'
type TransportPref = 'auto' | Transport
export type CompileResult = {
  body: string
  exitCode: number
  failed: boolean
  via: Transport
}

const AGENT_DONE = 'START_AGENT_DONE'
const AGENT_JS = `${GUEST_SERVER}/compile_agent.js`
const AGENT_PID = `${GUEST_SERVER}/agent.pid`
const AGENT_LOG = `${GUEST_SERVER}/agent.log`
const NET_SH = `${GUEST_SERVER}/networking.sh`

const SERIAL_BUF_MAX = 96 * 1024

function transportPref(): TransportPref {
  const v = new URL(window.location.href).searchParams.get('ucdTransport')
  if (v === 'tcp' || v === 'serial' || v === 'auto') {
    return v
  }
  return 'tcp'
}

/** BusyBox ash prompt: `localhost:~# `, `localhost:~/workspace# `, `localhost:/root# `, … */
function serialHasPrompt(buf: string): boolean {
  return /(?:^|\n)[A-Za-z0-9._-]+:[^\n]*# $/.test(buf)
}

function bytesToB64(u8: Uint8Array): string {
  let binary = ''
  const chunk = 0x2000
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      u8.subarray(i, i + chunk) as unknown as number[]
    )
  }
  return btoa(binary)
}

function trimSerialBuf(buf: string): string {
  if (buf.length <= SERIAL_BUF_MAX) {
    return buf
  }
  return buf.slice(-Math.floor(SERIAL_BUF_MAX / 2))
}

export class V86Compiler {
  private emulator: V86Emulator | null = null
  private serialBuf = ''
  private shellReady = false
  private shellWaiters: Array<() => void> = []
  private transport: Transport | null = null
  private ready = false
  private readyWaiters: Array<() => void> = []
  private compiling = false
  private capture = false
  private captureBuf = ''
  private captureResolve: ((r: CompileResult) => void) | null = null
  private readonly pref = transportPref()

  get isReady(): boolean {
    return this.ready
  }

  get activeTransport(): Transport | null {
    return this.transport
  }

  async start(onStatus: (msg: string) => void): Promise<void> {
    if (this.emulator != null) {
      return
    }
    onStatus('Loading v86, Alpine pack, and snapshot…')
    // Relative to the page (works for http://…/ and file://…/ucdvsc.html)
    const v86 = (p: string) => new URL(`v86/${p}`, document.baseURI).href
    const libP = loadScript(v86('build/libv86.js'))

    const wantNet = this.pref !== 'serial'
    const screenContainer = ensureGuestScreenContainer()

    // Prefer inlined Alpine/wasm/bios packs (file:// CORS + smaller ucdVscode/).
    // Snapshot lookup needs alpine-vfs.js (__V86_VFS_ID__) already on window.
    let fileAssets: Record<string, unknown> | null = null
    try {
      fileAssets = await prepareFileProtocolV86(onStatus)
    } catch (e) {
      if (location.protocol === 'file:') {
        throw e
      }
      onStatus(
        'Inline v86 packs missing — using v86/ files: ' +
          (e instanceof Error ? e.message : String(e))
      )
    }
    const [vmState] = await Promise.all([
      loadVmStateBuffer(onStatus).catch((e: unknown) => {
        onStatus(
          'Snapshot lookup skipped: ' + (e instanceof Error ? e.message : String(e))
        )
        return undefined
      }),
      libP
    ])
    if (window.V86 == null) {
      throw new Error('V86 global missing after script load')
    }

    onStatus(wantNet ? 'Booting Alpine (virtio-net)…' : 'Booting Alpine (serial only)…')
    let restoredFromSnapshot = false

    this.emulator = new window.V86({
      ...(fileAssets ?? {
        wasm_path: v86('build/v86.wasm'),
        bios: { url: v86('bios/seabios.bin') },
        vga_bios: { url: v86('bios/vgabios.bin') },
        filesystem: {
          baseurl: v86('images/alpine-rootfs-flat'),
          basefs: v86('images/alpine-fs.json')
        }
      }),
      memory_size: GUEST_RAM_BYTES,
      vga_memory_size: GUEST_VGA_BYTES,
      screen_container: screenContainer,
      ...(wantNet
        ? {
            net_device: {
              type: 'virtio',
              relay_url: 'fetch'
            }
          }
        : {}),
      autostart: false,
      preserve_mac_from_state_image: vmState != null,
      // Keyboard adapter on, but gated via keyboard_set_enabled (Focus / blur)
      disable_keyboard: false,
      disable_mouse: true,
      disable_speaker: true,
      fastboot: true,
      bzimage_initrd_from_filesystem: true,
      cmdline: [
        'rw',
        'root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose',
        'modules=virtio_pci',
        'tsc=reliable',
        'console=ttyS0',
        'quiet',
        'mitigations=off',
        'nowatchdog',
        'nmi_watchdog=0'
      ].join(' ')
    })

    if (this.emulator.network_adapter != null) {
      setGuestNetworkAdapter(this.emulator.network_adapter)
    }

    this.emulator.add_listener('serial0-output-byte', (byte) => {
      if (typeof byte !== 'number') {
        return
      }
      const ch = String.fromCharCode(byte)
      if (ch === '\r') {
        return
      }
      this.serialBuf += ch
      if (this.serialBuf.length > SERIAL_BUF_MAX) {
        this.serialBuf = trimSerialBuf(this.serialBuf)
      }
      if (this.capture) {
        this.captureBuf += ch
        if (this.captureBuf.includes('---END---') && serialHasPrompt(this.serialBuf)) {
          this.finishSerialCapture()
        }
      }
      if (!this.shellReady && serialHasPrompt(this.serialBuf)) {
        this.shellReady = true
        for (const w of this.shellWaiters) {
          w()
        }
        this.shellWaiters = []
      }
    })

    await this.waitEmulatorLoaded()

    if (vmState != null && this.emulator.restore_state != null) {
      try {
        onStatus(
          `Restoring full VM snapshot (${(vmState.byteLength / (1024 * 1024)).toFixed(1)} MiB)…`
        )
        await Promise.race([
          this.emulator.restore_state(vmState),
          new Promise<never>((_, reject) =>
            window.setTimeout(
              () => reject(new Error('restore_state timed out after 120s')),
              120_000
            )
          )
        ])
        restoredFromSnapshot = true
      } catch (e) {
        onStatus(
          'Snapshot restore failed — cold boot: ' + (e instanceof Error ? e.message : String(e))
        )
        try {
          await clearVmStateSnapshot()
        } catch {
          /* best-effort drop of a snapshot that cannot be restored */
        }
      }
    }

    await this.emulator.run?.()

    // A restored snapshot already has DHCP done and the agent process running,
    // so a short ping decides whether the whole serial bring-up can be skipped.
    if (restoredFromSnapshot && this.pref !== 'serial') {
      if (this.emulator.network_adapter != null) {
        setGuestNetworkAdapter(this.emulator.network_adapter)
      }
      onStatus('Snapshot: probing existing agent…')
      const pong = await probeAgentPing(6, 500, 2000)
      if (pong != null) {
        // The snapshot froze an agent *process*; a newer bundled agent means
        // that process lacks the current ops/ports, so it has to be restarted.
        const want = await this.bundledAgentSha()
        if (want == null || pong.sha === want) {
          this.shellReady = true
          setGuestControlReady(true)
          startGuestWorkspacePersist()
          this.hookVmStatePersist()
          this.markReady('tcp', onStatus)
          return
        }
        onStatus('Snapshot agent is outdated — restarting it')
      } else {
        onStatus('Snapshot agent unreachable — full bring-up')
      }
    }

    if (restoredFromSnapshot) {
      this.serialSend('\n')
      const gotPrompt = await this.waitUntilPromptTimeout(12000)
      if (!gotPrompt) {
        this.shellReady = true
        onStatus('Snapshot serial quiet — continuing')
      } else {
        onStatus('Snapshot shell ready')
      }
    } else {
      await this.waitUntilPromptOrTimeout(120_000, onStatus)
      onStatus('Shell ready')
    }

    // A snapshot was taken after a successful boot, so the layout is migrated.
    if (!restoredFromSnapshot) {
      await this.prepareGuestServerDir(onStatus)
    }

    if (this.pref === 'serial') {
      this.hookVmStatePersist()
      this.markReady('serial', onStatus)
      return
    }

    onStatus('DHCP via networking.sh…')
    this.serialSend(
      `${NET_SH} 2>/dev/null; /root/networking.sh 2>/dev/null; ` +
        'udhcpc -i eth0 -n -q 2>/dev/null; ' +
        'udhcpc -i ens3 -n -q 2>/dev/null; ' +
        'echo __UCD_NET__; ip -4 addr show; echo __UCD_NET_END__'
    )
    await this.waitUntilPromptOrTimeout(60_000, onStatus)
    {
      const netInfo = this.extractSerialSection('__UCD_NET__', '__UCD_NET_END__')
      if (netInfo) {
        onStatus('guest net:\n' + netInfo.trim())
      }
    }

    // Re-assert adapter right before TCP (Vite can duplicate module state).
    if (this.emulator.network_adapter != null) {
      setGuestNetworkAdapter(this.emulator.network_adapter)
    }
    onStatus('net bridge: ' + describeAdapter())

    onStatus('Updating guest agent…')
    await this.uploadGuestAgent(onStatus)

    const logSlice = await this.startGuestAgent(onStatus)

    if (this.emulator.network_adapter != null) {
      setGuestNetworkAdapter(this.emulator.network_adapter)
    }
    onStatus('Probing TCP (' + describeAdapter() + ')…')

    // Connect+ping is more reliable than SYN-only tcp_probe under load.
    let open = await waitForAgentPing(12, 1000, 5000)
    if (!open) {
      onStatus('ping failed — trying tcp_probe…')
      open = await probePort(AGENT_PORT, 10, 800, 3000)
    }
    if (open) {
      if (!restoredFromSnapshot) {
        onStatus('Restoring saved workspace overlay…')
        try {
          const n = await restoreGuestWorkspace()
          if (n > 0) {
            onStatus(`Restored ${n} file(s) from last session`)
          }
        } catch (e) {
          onStatus('Workspace restore skipped: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      setGuestControlReady(true)
      startGuestWorkspacePersist()
      this.hookVmStatePersist()
      if (!restoredFromSnapshot) {
        markGuestVmDirty()
      }
      this.markReady('tcp', onStatus)
      return
    }

    this.serialBuf = ''
    this.serialSend(
      'echo __UCD_DIAG_B__; ' +
        'ip -4 addr; ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null; ' +
        `kill -0 $(cat ${AGENT_PID} /tmp/agent.pid 2>/dev/null) 2>&1; ` +
        'echo __UCD_DIAG_E__'
    )
    await this.waitSerialIncludes('__UCD_DIAG_E__', 20000)
    const diag = this.extractSerialSection('__UCD_DIAG_B__', '__UCD_DIAG_E__')

    const detail =
      [
        describeAdapter(),
        logSlice && logSlice.trim(),
        diag && 'diag:\n' + diag.trim()
      ]
        .filter(Boolean)
        .join('\n') || '(no detail)'

    if (this.pref === 'tcp') {
      throw new Error('TCP agent not reachable (pref=tcp).\n' + detail)
    }

    onStatus('TCP unavailable — falling back to serial gcc\n' + detail)
    setGuestControlReady(false)
    this.hookVmStatePersist()
    this.markReady('serial', onStatus)
  }

  private waitEmulatorLoaded(timeoutMs = 180000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('v86 emulator-loaded timed out'))
        }
      }, timeoutMs)
      this.emulator?.add_listener('emulator-loaded', () => {
        if (settled) {
          return
        }
        settled = true
        window.clearTimeout(timer)
        resolve()
      })
    })
  }

  private waitUntilPromptTimeout(ms: number): Promise<boolean> {
    if (this.shellReady) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(false), ms)
      this.shellWaiters.push(() => {
        window.clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** Move legacy /root agent files into /root/ucdvsc_server (works on old Alpine + snapshots). */
  private async prepareGuestServerDir(onStatus: (msg: string) => void): Promise<void> {
    onStatus('Preparing /root/ucdvsc_server…')
    this.serialSend(
      `mkdir -p ${GUEST_SERVER} && ` +
        `if [ -f /root/networking.sh ]; then mv -f /root/networking.sh ${NET_SH}; fi && ` +
        `if [ -f /root/compile_agent.js ]; then mv -f /root/compile_agent.js ${AGENT_JS}; fi && ` +
        'rm -f /root/compile_agent.js.bak /root/hello.c /root/hello.js && ' +
        'echo __UCD_SERVER_DIR__\n'
    )
    await this.waitSerialIncludes('__UCD_SERVER_DIR__', 20000)
    await this.waitUntilPrompt()
  }

  private async startGuestAgent(onStatus: (msg: string) => void): Promise<string | null> {
    onStatus('Starting guest agent (:1234 control, :1235 shell)…')
    this.serialBuf = ''
    this.serialSend(
      `kill $(cat ${AGENT_PID} /tmp/agent.pid 2>/dev/null) 2>/dev/null; ` +
        `rm -f ${AGENT_LOG} /tmp/agent.log /tmp/agent.pid\n` +
        `(node ${AGENT_JS} > ${AGENT_LOG} 2>&1 & echo $! > ${AGENT_PID})\n` +
        'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do\n' +
        `  if grep -q "agent control on" ${AGENT_LOG} 2>/dev/null; then break; fi\n` +
        '  sleep 1\n' +
        'done\n' +
        'echo __UCD_ALOG_B__\n' +
        `cat ${AGENT_LOG} 2>/dev/null || echo "(no agent.log)"\n` +
        'echo __UCD_ALOG_E__\n' +
        'echo ' +
        AGENT_DONE
    )

    const agentOk = await this.waitSerialIncludes(AGENT_DONE, 120000)
    if (!agentOk) {
      onStatus('Agent start marker missing — probing anyway')
    }

    const logSlice = this.extractSerialSection('__UCD_ALOG_B__', '__UCD_ALOG_E__')
    if (logSlice) {
      onStatus('agent.log:\n' + logSlice.trim())
    }

    const listened =
      this.serialBuf.includes('agent control on') ||
      (logSlice != null && logSlice.includes('agent control on'))

    if (!listened) {
      onStatus('Agent did not print listen banner — node may have failed')
    }
    return logSlice
  }

  private hookVmStatePersist(): void {
    startGuestVmStatePersist(async () => {
      if (this.emulator?.save_state == null) {
        throw new Error('save_state unavailable')
      }
      if (this.compiling) {
        throw new Error('compile in progress')
      }
      await this.emulator.stop?.()
      try {
        return await this.emulator.save_state()
      } finally {
        await this.emulator.run?.()
      }
    })
  }

  private extractSerialSection(startMark: string, endMark: string): string | null {
    const a = this.serialBuf.indexOf(startMark)
    const b = this.serialBuf.indexOf(endMark)
    if (a === -1 || b === -1 || b <= a) {
      return null
    }
    return this.serialBuf.slice(a + startMark.length, b)
  }

  private markReady(via: Transport, onStatus: (msg: string) => void): void {
    this.transport = via
    this.ready = true
    onStatus(
      via === 'tcp'
        ? 'Alpine ready (TCP agent + shell)'
        : 'Alpine ready (serial; no guest FS/shell)'
    )
    for (const w of this.readyWaiters) {
      w()
    }
    this.readyWaiters = []
  }

  private waitUntilPromptOrTimeout(
    ms: number,
    onStatus?: (msg: string) => void
  ): Promise<void> {
    if (this.shellReady) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.shellReady = true
        onStatus?.('Shell prompt wait timed out — continuing anyway')
        resolve()
      }, ms)
      this.shellWaiters.push(() => {
        window.clearTimeout(timer)
        resolve()
      })
    })
  }

  private waitUntilPrompt(): Promise<void> {
    if (this.shellReady) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.shellWaiters.push(resolve)
    })
  }

  waitUntilReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve)
    })
  }

  private async bundledAgentSha(): Promise<string | null> {
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(compileAgentSrc)
      )
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      return null
    }
  }

  /**
   * sha256 of the agent copy already in the guest (baked into the image, or
   * left by a previous session). The marker is split across two string
   * literals so the tty echo of the command cannot be read back as the reply.
   */
  private async guestAgentSha(): Promise<string | null> {
    this.serialBuf = ''
    this.serialSend(
      `S=$(sha256sum ${AGENT_JS} 2>/dev/null | cut -c1-64); echo "AGENT""SHA:$S:END"`
    )
    const m = await this.waitSerialMatch(/AGENTSHA:([0-9a-f]{64})?:END/, 20000)
    return m?.[1] ?? null
  }

  /** Get the shell out of a stuck quote / PS2 so the next command is actually run. */
  private async interruptShell(): Promise<void> {
    this.serialSend('\x03')
    await new Promise<void>((resolve) => window.setTimeout(resolve, 400))
    this.serialBuf = ''
    this.serialSend('cd /root; echo "SH""OK:END"')
    await this.waitSerialIncludes('SHOK:END', 8000)
  }

  /**
   * Push src/guest/compile_agent.js over serial.
   * Each chunk waits for a split echo marker (not the shell prompt): tty echo of
   * the command line cannot match `CK:n:END` because the command contains `CK"":`.
   * Never overlap chunks — that truncated the agent to `0.0.0.0", () => {`.
   */
  private async uploadGuestAgent(onStatus: (msg: string) => void): Promise<void> {
    const want = await this.bundledAgentSha()
    if (want != null && (await this.guestAgentSha()) === want) {
      onStatus('Guest agent already current — skipping upload')
      return
    }

    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        onStatus(`Retrying guest agent upload (${attempt}/${attempts})…`)
      }
      const ok = await this.uploadGuestAgentOnce(want, onStatus)
      if (ok) {
        return
      }
    }
    onStatus('Guest agent upload failed — not replacing the on-disk copy')
  }

  private async uploadGuestAgentOnce(
    want: string | null,
    onStatus: (msg: string) => void
  ): Promise<boolean> {
    await this.interruptShell()
    const b64 = bytesToB64(new TextEncoder().encode(compileAgentSrc))
    // Canonical tty lines drop past ~4 KiB; keep printf + wrapper well under that.
    const chunkSize = 1200
    const chunks = Math.ceil(b64.length / chunkSize) || 1

    this.serialBuf = ''
    this.serialSend(
      `mkdir -p ${GUEST_SERVER}; rm -f /tmp/agent.b64 /tmp/compile_agent.js.new; echo "UP""INIT:END"`
    )
    if (!(await this.waitSerialIncludes('UPINIT:END', 15000))) {
      onStatus('Upload init failed (no serial ack)')
      return false
    }

    for (let i = 0, n = 1; i < b64.length; i += chunkSize, n++) {
      const chunk = b64.slice(i, i + chunkSize)
      const op = i === 0 ? '>' : '>>'
      onStatus(`Uploading guest agent (${n}/${chunks})…`)
      this.serialBuf = ''
      this.serialSend(`printf '%s' '${chunk}' ${op} /tmp/agent.b64 && echo "CK"":${n}:END"`)
      if (!(await this.waitSerialIncludes(`CK:${n}:END`, 15000))) {
        onStatus(`Upload chunk ${n}/${chunks} failed (no serial ack)`)
        return false
      }
    }

    this.serialBuf = ''
    this.serialSend(
      'base64 -d /tmp/agent.b64 > /tmp/compile_agent.js.new && ' +
        'S=$(sha256sum /tmp/compile_agent.js.new 2>/dev/null | cut -c1-64); ' +
        'echo "AGENT""NEW:$S:END"'
    )
    const m = await this.waitSerialMatch(/AGENTNEW:([0-9a-f]{64})?:END/, 30000)
    const got = m?.[1] ?? null
    if (want != null && got !== want) {
      onStatus(`Uploaded agent sha mismatch (got ${got ?? 'none'})`)
      this.serialSend('rm -f /tmp/agent.b64 /tmp/compile_agent.js.new; echo "UP""RM:END"')
      await this.waitSerialIncludes('UPRM:END', 8000)
      return false
    }

    this.serialBuf = ''
    this.serialSend(
      `mv /tmp/compile_agent.js.new ${AGENT_JS} && rm -f /tmp/agent.b64 && echo "AGENT""OK:END"`
    )
    if (!(await this.waitSerialIncludes('AGENTOK:END', 15000))) {
      onStatus('Agent install ack missing')
      return false
    }
    onStatus('Guest agent uploaded')
    return true
  }

  private serialSend(cmd: string): void {
    if (this.emulator == null) {
      throw new Error('v86 not started')
    }
    if (!cmd.endsWith('\n') && !cmd.endsWith('\x03')) {
      cmd += '\n'
    }
    this.shellReady = false
    this.emulator.serial0_send(cmd)
  }

  private waitSerialIncludes(needle: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        if (this.serialBuf.includes(needle)) {
          resolve(true)
          return
        }
        if (Date.now() - start > timeoutMs) {
          resolve(false)
          return
        }
        window.setTimeout(tick, 200)
      }
      tick()
    })
  }

  private waitSerialMatch(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray | null> {
    const start = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        const m = this.serialBuf.match(re)
        if (m != null) {
          resolve(m)
          return
        }
        if (Date.now() - start > timeoutMs) {
          resolve(null)
          return
        }
        window.setTimeout(tick, 200)
      }
      tick()
    })
  }

  private finishSerialCapture(): void {
    this.compiling = false
    this.capture = false
    const text = this.captureBuf
    const start = text.search(/\n---OUT---\n/)
    const end = text.search(/\n---END---/)
    let body = ''
    if (start !== -1 && end !== -1 && end > start) {
      body = text.slice(start + '\n---OUT---\n'.length, end)
    } else {
      body = text
    }
    const exitM = text.match(/\n---END--- exit:(-?\d+)/)
    const exitCode = exitM != null ? parseInt(exitM[1]!, 10) : 1
    const failed = exitCode !== 0 || /error:|undefined reference|gcc:/.test(body)
    const resolve = this.captureResolve
    this.captureResolve = null
    resolve?.({ body, exitCode, failed, via: 'serial' })
  }

  private compileSerial(code: string, onStatus: (msg: string) => void): Promise<CompileResult> {
    const b64 = bytesToB64(new TextEncoder().encode(code))
    this.compiling = true
    this.capture = true
    this.captureBuf = ''
    onStatus('Compiling via serial…')
    return new Promise((resolve) => {
      this.captureResolve = resolve
      this.serialSend(
        "printf '%s' '" +
          b64 +
          "' | base64 -d > /root/workspace/main.c && " +
          "echo '---OUT---' && " +
          'cd /root/workspace && gcc main.c -o main && ./main; ' +
          "echo '---END--- exit:'$?"
      )
    })
  }

  private async compileTcp(code: string, onStatus: (msg: string) => void): Promise<CompileResult> {
    onStatus('Compiling via TCP agent…')
    this.compiling = true
    try {
      const msg = await guestRpc({ op: 'compile', code, name: 'main.c' })
      const exitCode = typeof msg.exit === 'number' ? msg.exit : msg.ok ? 0 : 1
      const body = [msg.stdout || '', msg.stderr || ''].filter(Boolean).join('\n')
      return {
        body,
        exitCode,
        failed: !msg.ok || exitCode !== 0,
        via: 'tcp'
      }
    } finally {
      this.compiling = false
    }
  }

  async compile(code: string, onStatus: (msg: string) => void): Promise<CompileResult> {
    if (this.compiling) {
      throw new Error('Compile already in progress')
    }
    await this.waitUntilReady()
    markGuestVmDirty()
    if (this.transport === 'tcp' && isGuestControlReady()) {
      try {
        return await this.compileTcp(code, onStatus)
      } catch (e) {
        if (this.pref === 'tcp') {
          throw e
        }
        onStatus('TCP failed — retrying over serial…')
        return await this.compileSerial(code, onStatus)
      }
    }
    return await this.compileSerial(code, onStatus)
  }
}
