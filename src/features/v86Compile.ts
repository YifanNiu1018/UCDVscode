/**
 * Option A: monaco-vscode-api Workbench + v86 Alpine guest agent.
 * Control TCP :1234 (files/compile), shell TCP :1235, serial fallback for gcc.
 * URL: ?ucdTransport=auto|tcp|serial
 */
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  AGENT_PORT,
  browserPathToGuest,
  describeAdapter,
  guestRpc,
  guestWrite,
  GUEST_SERVER,
  isGuestControlReady,
  probePort,
  setGuestControlReady,
  setGuestNetworkAdapter,
  waitForAgentPing,
  type V86NetworkAdapter
} from './guestBridge'
import { ensureGuestScreenContainer } from './guestConsole'
import { getGuestFs } from './guestFsProvider'
import {
  restoreGuestWorkspace,
  startGuestWorkspacePersist,
  startGuestVmStatePersist,
  scheduleGuestWorkspacePersist,
  clearGuestWorkspacePersist,
  bindGuestDiskFolder,
  persistGuestWorkspaceAfterBind,
  setGuestDiskBindPrompt,
  hasStoredGuestDiskHandle,
  loadVmStateBuffer,
  saveVmStateNow,
  guestDiskNeedsAuthorization,
  authorizeStoredGuestDisk,
  loadLastGuestDiskSaveMeta,
  onGuestDiskSaved,
  getLastGuestDiskSave,
  type GuestDiskSaveInfo
} from './guestFsPersist'
import compileAgentSrc from '../guest/compile_agent.js?raw'

declare global {
  interface Window {
    V86?: new (options: Record<string, unknown>) => V86Emulator
    __V86_VFS_B64__?: Record<string, string>
    __V86_VFS_READY__?: boolean
    __UCD_V86_RUNTIME__?: {
      WASM_B64: string
      BIOS_B64: string
      VGA_B64: string
    }
  }
}

interface V86Emulator {
  serial0_send: (data: string) => void
  add_listener: (event: string, cb: (...args: unknown[]) => void) => void
  network_adapter?: V86NetworkAdapter
  keyboard_set_enabled?: (enabled: boolean) => void
  destroy?: () => void
  save_state?: () => Promise<ArrayBuffer>
  restore_state?: (state: ArrayBuffer) => Promise<void>
  run?: () => Promise<void> | void
  stop?: () => Promise<void> | void
}

type Transport = 'tcp' | 'serial'
type TransportPref = 'auto' | Transport
type CompileResult = { body: string; exitCode: number; failed: boolean; via: Transport }

const READY = 'localhost:~# '
const AGENT_DONE = 'START_AGENT_DONE'
const AGENT_JS = `${GUEST_SERVER}/compile_agent.js`
const AGENT_PID = `${GUEST_SERVER}/agent.pid`
const AGENT_LOG = `${GUEST_SERVER}/agent.log`
const NET_SH = `${GUEST_SERVER}/networking.sh`

function transportPref(): TransportPref {
  const v = new URL(window.location.href).searchParams.get('ucdTransport')
  if (v === 'tcp' || v === 'serial' || v === 'auto') {
    return v
  }
  return 'tcp'
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

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) != null) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** file:// cannot XHR sibling assets (CORS). Serve Alpine pack + runtime from inlined b64. */
function installFileProtocolVfsShim(): void {
  const normalizeKey = (url: string): string => {
    let s = String(url)
    try {
      if (/^(https?:|file:)/i.test(s)) {
        s = new URL(s, location.href).pathname
      }
    } catch {
      /* keep s */
    }
    s = s.replace(/\\/g, '/')
    const img = s.indexOf('/images/')
    if (img >= 0) s = s.slice(img + 1)
    const v86Img = s.indexOf('/v86/images/')
    if (v86Img >= 0) s = s.slice(v86Img + '/v86/'.length)
    if (s.startsWith('./')) s = s.slice(2)
    while (s.startsWith('/')) s = s.slice(1)
    return s
  }

  const lookup = (url: string): ArrayBuffer | null => {
    const m = window.__V86_VFS_B64__
    if (m == null) return null
    const key = normalizeKey(url)
    let b64 = m[key]
    if (b64 == null) {
      const base = key.split('/').pop()
      if (base != null) {
        b64 = m[base] ?? m[`images/alpine-rootfs-flat/${base}`]
      }
    }
    if (b64 == null) return null
    return b64ToBuf(b64)
  }

  const XHR = window.XMLHttpRequest
  function Shim(this: XMLHttpRequest) {
    const xhr = new XHR()
    let method = 'GET'
    let url = ''
    let responseType = ''
    const listeners: Record<string, Array<(ev: Event) => void>> = {}
    const api: Record<string, unknown> = {
      UNSENT: 0,
      OPENED: 1,
      HEADERS_RECEIVED: 2,
      LOADING: 3,
      DONE: 4,
      readyState: 0,
      status: 0,
      statusText: '',
      response: null,
      responseText: '',
      onload: null,
      onerror: null,
      onprogress: null,
      onreadystatechange: null,
      open(m: string, u: string) {
        method = m
        url = u
        api.readyState = 1
      },
      setRequestHeader() {},
      overrideMimeType() {},
      getResponseHeader() {
        return null
      },
      getAllResponseHeaders() {
        return ''
      },
      addEventListener(type: string, fn: (ev: Event) => void) {
        ;(listeners[type] || (listeners[type] = [])).push(fn)
      },
      removeEventListener(type: string, fn: (ev: Event) => void) {
        listeners[type] = (listeners[type] || []).filter((x) => x !== fn)
      },
      abort() {},
      send() {
        const fire = (type: string) => {
          const ev = { type, target: api } as unknown as Event
          const handler = api[`on${type}`] as ((e: Event) => void) | null
          handler?.(ev)
          for (const fn of listeners[type] || []) fn(ev)
        }
        const buf = lookup(url)
        if (buf == null) {
          xhr.responseType = ((api.responseType as string) ||
            responseType) as XMLHttpRequestResponseType
          xhr.onload = () => {
            api.readyState = 4
            api.status = xhr.status
            api.statusText = xhr.statusText
            api.response = xhr.response
            api.responseText = xhr.responseText
            fire('readystatechange')
            fire('load')
          }
          xhr.onerror = () => {
            api.readyState = 4
            api.status = 0
            fire('error')
          }
          xhr.open(method, url)
          xhr.send()
          return
        }
        const rt = (api.responseType as string) || responseType
        api.readyState = 4
        api.status = 200
        api.statusText = 'OK'
        if (rt === 'json') {
          api.response = JSON.parse(new TextDecoder().decode(buf))
        } else {
          api.response = buf.slice(0)
        }
        fire('readystatechange')
        fire('load')
      }
    }
    Object.defineProperty(api, 'responseType', {
      get: () => responseType,
      set: (v: string) => {
        responseType = v
      }
    })
    return api
  }
  Shim.prototype = XHR.prototype
  window.XMLHttpRequest = Shim as unknown as typeof XMLHttpRequest
}

async function prepareFileProtocolV86(
  onStatus: (msg: string) => void
): Promise<Record<string, unknown>> {
  const asset = (p: string) => new URL(p, document.baseURI).href
  onStatus('Loading Alpine VFS pack (file://, ~200MB)…')
  await loadScript(asset('alpine-vfs.js'))
  if (window.__V86_VFS_READY__ !== true || window.__V86_VFS_B64__ == null) {
    throw new Error(
      'alpine-vfs.js missing next to ucdvsc.html — run: bash scripts/setup-v86.sh && npm run build:classic'
    )
  }
  onStatus('Loading v86 wasm/bios pack…')
  await loadScript(asset('v86-runtime-assets.js'))
  const rt = window.__UCD_V86_RUNTIME__
  if (rt?.WASM_B64 == null || rt.BIOS_B64 == null || rt.VGA_B64 == null) {
    throw new Error(
      'v86-runtime-assets.js incomplete — run: bash scripts/setup-v86.sh && npm run build:classic'
    )
  }
  installFileProtocolVfsShim()
  const wasmBytes = b64ToBuf(rt.WASM_B64)
  return {
    wasm_fn: async (env: WebAssembly.Imports) => {
      const { instance } = await WebAssembly.instantiate(wasmBytes, env)
      return instance.exports
    },
    bios: { buffer: b64ToBuf(rt.BIOS_B64) },
    vga_bios: { buffer: b64ToBuf(rt.VGA_B64) },
    filesystem: {
      baseurl: 'images/alpine-rootfs-flat/',
      basefs: 'images/alpine-fs.json'
    }
  }
}

class V86Compiler {
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
    onStatus('Loading v86…')
    // Relative to the page (works for http://…/ and file://…/ucdvsc.html)
    const v86 = (p: string) => new URL(`v86/${p}`, document.baseURI).href
    await loadScript(v86('build/libv86.js'))
    if (window.V86 == null) {
      throw new Error('V86 global missing after script load')
    }

    const wantNet = this.pref !== 'serial'
    onStatus(wantNet ? 'Booting Alpine (virtio-net)…' : 'Booting Alpine (serial only)…')

    const screenContainer = ensureGuestScreenContainer()

    // Prefer inlined Alpine/wasm/bios packs (file:// CORS + smaller ucdVscode/).
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

    onStatus('Looking for VM snapshot (guest-disk/v86state.bin)…')
    let vmState: ArrayBuffer | undefined
    try {
      vmState = await loadVmStateBuffer()
    } catch (e) {
      onStatus(
        'Snapshot lookup skipped: ' + (e instanceof Error ? e.message : String(e))
      )
      vmState = undefined
    }
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
      memory_size: 768 * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
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
      bzimage_initrd_from_filesystem: true,
      cmdline: [
        'rw',
        'root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose',
        'modules=virtio_pci',
        'tsc=reliable',
        'console=ttyS0',
        'console=tty0'
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
      if (this.capture) {
        this.captureBuf += ch
        if (this.captureBuf.includes('---END---') && this.serialBuf.endsWith(READY)) {
          this.finishSerialCapture()
        }
      }
      if (!this.shellReady && this.serialBuf.endsWith(READY)) {
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
        await this.emulator.restore_state(vmState)
        restoredFromSnapshot = true
      } catch (e) {
        onStatus(
          'Snapshot restore failed — cold boot: ' + (e instanceof Error ? e.message : String(e))
        )
      }
    }

    await this.emulator.run?.()

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
      await this.waitUntilPrompt()
      onStatus('Shell ready')
    }

    await this.prepareGuestServerDir(onStatus)

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
    await this.waitUntilPrompt()
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

  /** Push src/guest/compile_agent.js over serial into /root/ucdvsc_server. */
  private async uploadGuestAgent(onStatus: (msg: string) => void): Promise<void> {
    const b64 = bytesToB64(new TextEncoder().encode(compileAgentSrc))
    const chunkSize = 2000
    this.serialSend(`mkdir -p ${GUEST_SERVER}; rm -f /tmp/agent.b64 /tmp/compile_agent.js.new\n`)
    await this.waitUntilPrompt()
    for (let i = 0; i < b64.length; i += chunkSize) {
      const chunk = b64.slice(i, i + chunkSize)
      const op = i === 0 ? '>' : '>>'
      this.serialSend(`printf '%s' '${chunk}' ${op} /tmp/agent.b64\n`)
      await this.waitUntilPrompt()
    }
    this.serialBuf = ''
    this.serialSend(
      'base64 -d /tmp/agent.b64 > /tmp/compile_agent.js.new && ' +
        `mv /tmp/compile_agent.js.new ${AGENT_JS} && ` +
        'rm -f /tmp/agent.b64 && echo __UCD_AGENT_WRITTEN__\n'
    )
    const ok = await this.waitSerialIncludes('__UCD_AGENT_WRITTEN__', 30000)
    await this.waitUntilPrompt()
    if (!ok) {
      onStatus('Guest agent upload uncertain — using image copy')
    }
  }

  private serialSend(cmd: string): void {
    if (this.emulator == null) {
      throw new Error('v86 not started')
    }
    if (!cmd.endsWith('\n')) {
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

const compiler = new V86Compiler()

const { getApi, registerFileUrl } = registerExtension(
    {
      name: 'ucd-v86-compile',
      publisher: 'ucd',
      version: '1.0.0',
      engines: {
        vscode: '*'
      },
      browser: 'extension.js',
      activationEvents: ['*'],
      contributes: {
        commands: [
          {
            command: 'ucd.v86.run',
            title: 'Run C in Alpine',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.bindGuestDisk',
            title: 'Bind Disk Folder…',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.saveVmState',
            title: 'Save VM Snapshot',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.clearPersistedWorkspace',
            title: 'Clear VM Snapshot',
            category: 'UCDVSC'
          }
        ],
        keybindings: [
          {
            command: 'ucd.v86.run',
            key: 'ctrl+alt+b',
            mac: 'cmd+alt+b',
            when: 'editorTextFocus'
          }
        ]
      }
    },
    ExtensionHostKind.LocalProcess
  )

  registerFileUrl('./extension.js', 'data:text/javascript;base64,' + window.btoa('// ucd-v86-compile'))

  void getApi().then(async (vscode) => {
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    status.text = '$(vm) Alpine: booting…'
    status.tooltip = 'Run C in Alpine (Ctrl+Alt+B / Cmd+Alt+B)'
    status.command = 'ucd.v86.run'
    status.show()

    const saveStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    saveStatus.command = 'ucd.v86.saveVmState'
    saveStatus.show()

    const channel = vscode.window.createOutputChannel('Alpine / v86')

    const formatSaveClock = (ms: number): string =>
      new Date(ms).toLocaleTimeString('en-US', { hour12: false })
    const formatSaveFull = (ms: number): string =>
      new Date(ms).toLocaleString('en-US', { hour12: false })

    const paintSaveStatus = (info: GuestDiskSaveInfo | null = getLastGuestDiskSave()): void => {
      if (info == null) {
        saveStatus.text = '$(history) Snapshot: —'
        saveStatus.tooltip =
          'No VM snapshot yet. Bind a disk folder to auto-save. Click to save now.'
        return
      }
      const size =
        typeof info.byteLength === 'number'
          ? `\nSize: ${(info.byteLength / (1024 * 1024)).toFixed(1)} MiB`
          : ''
      const kind = info.source === 'vm' ? 'VM snapshot' : 'workspace'
      saveStatus.text = `$(history) Saved ${formatSaveClock(info.savedAt)}`
      saveStatus.tooltip =
        `Last auto-save (${kind}): ${formatSaveFull(info.savedAt)}${size}\nClick to save VM snapshot now.`
    }
    paintSaveStatus()
    onGuestDiskSaved((info) => {
      paintSaveStatus(info)
      if (info.source !== 'vm') {
        return
      }
      channel.appendLine(
        `disk saved @ ${formatSaveFull(info.savedAt)}` +
          (info.byteLength != null
            ? ` (${(info.byteLength / (1024 * 1024)).toFixed(1)} MiB)`
            : '')
      )
    })

    const setStatus = (msg: string) => {
      status.text = `$(vm) ${msg}`
      channel.appendLine(msg)
    }

    async function bindDiskFromUi(): Promise<boolean> {
      try {
        await bindGuestDiskFolder()
        const r = await persistGuestWorkspaceAfterBind()
        paintSaveStatus()
        if (r.files > 0 || r.stateBytes > 0) {
          void vscode.window.showInformationMessage(
            `Disk folder bound. Workspace ${r.files} files, snapshot ${(r.stateBytes / (1024 * 1024)).toFixed(1)} MiB.`
          )
        } else {
          void vscode.window.showInformationMessage(
            'Disk folder bound. The VM snapshot will be saved here automatically.'
          )
        }
        return true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        void vscode.window.showErrorMessage('Failed to bind disk folder: ' + msg)
        return false
      }
    }

    setGuestDiskBindPrompt(() => {
      void vscode.window
        .showWarningMessage(
          'Bind a disk folder so UCDVSC can save the VM snapshot. Pick the ucdVscode folder.',
          'Bind Disk Folder…'
        )
        .then(async (choice) => {
          if (choice === 'Bind Disk Folder…') {
            await bindDiskFromUi()
          }
        })
    })

    if (!(await hasStoredGuestDiskHandle())) {
      const choice = await vscode.window.showWarningMessage(
        'UCDVSC needs a folder to store the VM snapshot. Pick the ucdVscode folder.',
        { modal: true },
        'Bind Disk Folder…'
      )
      if (choice === 'Bind Disk Folder…') {
        await bindDiskFromUi()
      }
    }

    async function syncDocument(doc: { uri: { fsPath: string; scheme: string }; getText: () => string }) {
      if (doc.uri.scheme !== 'file' || !isGuestControlReady()) {
        return
      }
      const rel = browserPathToGuest(doc.uri.fsPath)
      if (rel == null || rel === '.') {
        return
      }
      await guestWrite(rel, doc.getText())
      channel.appendLine(`synced → guest:${rel}`)
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Connecting to guest',
          cancellable: false
        },
        async () => {
          await compiler.start(setStatus)
          await compiler.waitUntilReady()
        }
      )
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setStatus(`boot failed: ${err}`)
      void vscode.window.showErrorMessage(`v86 boot failed: ${err}`)
    }

    if (compiler.isReady) {
      void vscode.window.showInformationMessage('Connected to guest')
      try {
        if (await guestDiskNeedsAuthorization()) {
          void vscode.window
            .showWarningMessage(
              'A disk folder is remembered, but the browser needs a click to read the VM snapshot.',
              'Authorize and Reload'
            )
            .then(async (choice) => {
              if (choice !== 'Authorize and Reload') {
                return
              }
              const ok = await authorizeStoredGuestDisk()
              if (ok) {
                window.location.reload()
              } else {
                void vscode.window.showErrorMessage(
                  'Authorization failed. Use Command Palette → UCDVSC: Bind Disk Folder… to pick ucdVscode again.'
                )
              }
            })
        }
      } catch {
        /* ignore */
      }
      setStatus('Alpine ready')
      void loadLastGuestDiskSaveMeta().then(() => paintSaveStatus())

      if (isGuestControlReady()) {
        try {
          await guestRpc({ op: 'mkdir', path: '.' })
          getGuestFs()?.notifyChanged()
          channel.appendLine('explorer: live guest FS ready (file:///workspace → /root/workspace)')
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file('/workspace/main.c')
            )
            await vscode.window.showTextDocument(doc, { preview: false })
          } catch {
            /* main.c may not exist yet */
          }
        } catch (e) {
          channel.appendLine('guest fs ready hook: ' + String(e))
        }
      }
    }

    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Live guest FS writeFile already persists; keep RPC write as belt-and-suspenders
      void syncDocument(doc).catch((e) => {
        channel.appendLine('save sync failed: ' + String(e))
      })
      getGuestFs()?.notifyChanged()
      scheduleGuestWorkspacePersist()
    })

    // main.c opened after guest ready (see start hook above)

    vscode.commands.registerCommand('ucd.v86.bindGuestDisk', () => bindDiskFromUi())

    vscode.commands.registerCommand('ucd.v86.saveVmState', async () => {
      try {
        const bytes = await saveVmStateNow()
        if (bytes <= 0) {
          void vscode.window.showWarningMessage(
            'Snapshot was not written. Bind a disk folder first and wait until Alpine is ready.'
          )
          return
        }
        void vscode.window.showInformationMessage(
          `Saved VM snapshot ${(bytes / (1024 * 1024)).toFixed(1)} MiB → guest-disk/v86state.bin`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        void vscode.window.showErrorMessage('Failed to save VM snapshot: ' + msg)
      }
    })

    vscode.commands.registerCommand('ucd.v86.clearPersistedWorkspace', async () => {
      await clearGuestWorkspacePersist()
      void vscode.window.showInformationMessage(
        'Cleared guest-disk snapshot and workspace overlay. Next open will cold-boot Alpine (this session stays as-is).'
      )
    })

    vscode.commands.registerCommand('ucd.v86.run', async () => {
      const editor = vscode.window.activeTextEditor
      if (editor == null) {
        void vscode.window.showWarningMessage('No active editor')
        return
      }
      if (!compiler.isReady) {
        void vscode.window.showWarningMessage('Alpine guest is still booting')
        return
      }
      const code = editor.document.getText()
      // Always try to persist before compile when TCP is up
      if (isGuestControlReady()) {
        try {
          await syncDocument(editor.document)
        } catch {
          /* compile may still work via payload */
        }
      }
      channel.show(true)
      channel.appendLine(`——— run (${compiler.activeTransport}) ———`)
      try {
        const result = await compiler.compile(code, setStatus)
        channel.append(result.body)
        if (!result.body.endsWith('\n')) {
          channel.appendLine('')
        }
        channel.appendLine(`[via ${result.via}]`)
        if (result.failed) {
          setStatus(`Finished with errors (exit ${result.exitCode}, ${result.via})`)
          void vscode.window.showErrorMessage(`Compile/run failed (exit ${result.exitCode})`)
        } else {
          setStatus(`Finished (exit ${result.exitCode}, ${result.via})`)
          /* success: status bar + output channel are enough */
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        setStatus(`error: ${err}`)
        void vscode.window.showErrorMessage(err)
      }
    })
  })
