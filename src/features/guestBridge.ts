/**
 * Shared TCP bridge to guest compile_agent (control :1234, shell :1235).
 */
export const AGENT_PORT = 1234
export const SHELL_PORT = 1235

export interface TcpConn {
  on: (event: string, cb: (...args: unknown[]) => void) => void
  write: (data: Uint8Array) => void
  close: () => void
}

export interface V86NetworkAdapter {
  tcp_probe: (port: number) => Promise<boolean>
  connect: (port: number) => TcpConn
  vm_ip?: Uint8Array
  vm_mac?: Uint8Array
}

export type AgentResponse = {
  ok?: boolean
  op?: string
  stdout?: string
  stderr?: string
  exit?: number
  content?: string
  path?: string
  type?: string
  size?: number
  mtime?: number
  ctime?: number
  from?: string
  to?: string
  entries?: Array<{ name: string; type: string; path: string }>
  work?: string
  code?: string
}

type ReadyListener = (ready: boolean) => void

declare global {
  interface Window {
    __ucdV86Net?: V86NetworkAdapter | null
  }
}

let adapter: V86NetworkAdapter | null = null
let controlReady = false
const readyListeners = new Set<ReadyListener>()

function getAdapter(): V86NetworkAdapter | null {
  return adapter ?? window.__ucdV86Net ?? null
}

export function setGuestNetworkAdapter(next: V86NetworkAdapter | null): void {
  adapter = next
  window.__ucdV86Net = next
}

export function setGuestControlReady(ready: boolean): void {
  controlReady = ready
  for (const l of readyListeners) {
    l(ready)
  }
}

export function isGuestControlReady(): boolean {
  return controlReady && getAdapter() != null
}

export function onGuestControlReady(listener: ReadyListener): () => void {
  readyListeners.add(listener)
  if (controlReady) {
    listener(true)
  }
  return () => {
    readyListeners.delete(listener)
  }
}

export function describeAdapter(): string {
  const a = getAdapter()
  if (a == null) {
    return 'adapter=null'
  }
  const ip = a.vm_ip != null ? Array.from(a.vm_ip).join('.') : '?'
  const mac =
    a.vm_mac != null
      ? Array.from(a.vm_mac)
          .map((x) => x.toString(16).padStart(2, '0'))
          .join(':')
      : '?'
  return `adapter=ok vm_ip=${ip} vm_mac=${mac}`
}

function encodeFrame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj))
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, false)
  frame.set(body, 4)
  return frame
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

/** tcp_probe with timeout — the stock probe can hang forever if no RST. */
export async function probePort(
  port: number,
  attempts = 8,
  delayMs = 750,
  perTryMs = 2500
): Promise<boolean> {
  const a = getAdapter()
  if (a == null) {
    return false
  }
  for (let i = 0; i < attempts; i++) {
    try {
      const ok = await Promise.race([
        a.tcp_probe(port),
        sleep(perTryMs).then(() => false)
      ])
      if (ok) {
        return true
      }
    } catch {
      /* retry */
    }
    await sleep(delayMs)
  }
  return false
}

/**
 * Prefer a real TCP connect + framed ping (more reliable than SYN probe alone).
 */
export async function waitForAgentPing(
  attempts = 15,
  delayMs = 1000,
  perTryMs = 4000
): Promise<boolean> {
  const a = getAdapter()
  if (a == null) {
    return false
  }
  for (let i = 0; i < attempts; i++) {
    const ok = await tryPingOnce(a, perTryMs)
    if (ok) {
      return true
    }
    await sleep(delayMs)
  }
  return false
}

function tryPingOnce(a: V86NetworkAdapter, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let rx: Uint8Array = new Uint8Array(0)
    let conn: TcpConn
    try {
      conn = a.connect(AGENT_PORT)
    } catch {
      resolve(false)
      return
    }

    const finish = (ok: boolean) => {
      if (settled) {
        return
      }
      settled = true
      try {
        conn.close()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }

    const timer = window.setTimeout(() => finish(false), timeoutMs)

    conn.on('connect', () => {
      try {
        conn.write(encodeFrame({ op: 'ping' }))
      } catch {
        window.clearTimeout(timer)
        finish(false)
      }
    })
    conn.on('data', (data: unknown) => {
      const chunk =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      rx = concatU8(rx, chunk)
      while (rx.length >= 4) {
        const len = new DataView(rx.buffer, rx.byteOffset, rx.byteLength).getUint32(
          0,
          false
        )
        if (rx.length < 4 + len) {
          return
        }
        const payload = new TextDecoder().decode(rx.subarray(4, 4 + len))
        rx = rx.subarray(4 + len)
        try {
          const msg = JSON.parse(payload) as AgentResponse
          window.clearTimeout(timer)
          finish(!!msg.ok && msg.op === 'ping')
        } catch {
          window.clearTimeout(timer)
          finish(false)
        }
        return
      }
    })
    conn.on('close', () => {
      window.clearTimeout(timer)
      finish(false)
    })
    conn.on('shutdown', () => {
      window.clearTimeout(timer)
      finish(false)
    })
  })
}

export async function guestRpc(
  msg: Record<string, unknown>,
  timeoutMs = 60000,
  ignoreReady = false
): Promise<AgentResponse> {
  const a = getAdapter()
  if (a == null) {
    throw new Error('guest network adapter not set')
  }
  if (!controlReady && !ignoreReady) {
    throw new Error('guest control agent not ready')
  }

  return await new Promise((resolve, reject) => {
    let rx: Uint8Array = new Uint8Array(0)
    let settled = false
    const conn = a.connect(AGENT_PORT)

    const finish = (err: Error | null, result?: AgentResponse) => {
      if (settled) {
        return
      }
      settled = true
      try {
        conn.close()
      } catch {
        /* ignore */
      }
      if (err != null) {
        reject(err)
      } else {
        resolve(result!)
      }
    }

    const onData = (data: unknown) => {
      const chunk =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      rx = concatU8(rx, chunk)
      while (rx.length >= 4) {
        const len = new DataView(rx.buffer, rx.byteOffset, rx.byteLength).getUint32(
          0,
          false
        )
        if (len > 16 * 1024 * 1024) {
          finish(new Error('TCP frame too large'))
          return
        }
        if (rx.length < 4 + len) {
          return
        }
        const payload = new TextDecoder().decode(rx.subarray(4, 4 + len))
        rx = rx.subarray(4 + len)
        try {
          finish(null, JSON.parse(payload) as AgentResponse)
        } catch (e) {
          finish(new Error('bad JSON from agent: ' + String(e)))
        }
        return
      }
    }

    conn.on('connect', () => {
      conn.write(encodeFrame(msg))
    })
    conn.on('data', onData)
    conn.on('close', () => finish(new Error('TCP closed before response')))
    conn.on('shutdown', () => finish(new Error('TCP shutdown before response')))
    window.setTimeout(() => finish(new Error('guest RPC timeout')), timeoutMs)
  })
}

export async function guestWrite(relPath: string, content: string): Promise<void> {
  const r = await guestRpc({ op: 'write', path: relPath, content })
  if (!r.ok) {
    throw new Error(r.stderr || 'write failed')
  }
}

/** Open raw shell TCP; caller owns the connection. */
export function connectGuestShell(): TcpConn {
  const a = getAdapter()
  if (a == null) {
    throw new Error('guest network adapter not set')
  }
  if (!controlReady) {
    throw new Error('guest agent not ready (shell starts with control agent)')
  }
  return a.connect(SHELL_PORT)
}

export const GUEST_HOME = '/root'
export const GUEST_WORK = '/root/workspace'
/** Guest-side UCDVSC agent (compile + shell), not student files. */
export const GUEST_SERVER = '/root/ucdvsc_server'
/** Workbench alias: file:///workspace ↔ guest /root/workspace */
export const VSCODE_WORK_ALIAS = '/workspace'

function normFsPath(fsPath: string): string {
  const n = fsPath.replace(/\\/g, '/')
  if (n.length > 1 && n.endsWith('/')) {
    return n.slice(0, -1)
  }
  return n || '/'
}

/** VS Code file URI path → guest absolute path, or null if outside guest FS. */
export function vscodePathToGuest(fsPath: string): string | null {
  const norm = normFsPath(fsPath)
  if (norm === VSCODE_WORK_ALIAS || norm === 'workspace') {
    return GUEST_WORK
  }
  if (norm.startsWith(VSCODE_WORK_ALIAS + '/')) {
    return GUEST_WORK + norm.slice(VSCODE_WORK_ALIAS.length)
  }
  if (norm === '/' || norm === GUEST_HOME || norm.startsWith(GUEST_HOME + '/')) {
    return norm
  }
  if (norm === '/tmp' || norm.startsWith('/tmp/')) {
    return norm
  }
  return null
}

/** Guest absolute path → VS Code file URI path (keep /workspace alias). */
export function guestPathToVscode(guestAbs: string): string {
  const g = normFsPath(guestAbs)
  if (g === GUEST_WORK || g.startsWith(GUEST_WORK + '/')) {
    return VSCODE_WORK_ALIAS + g.slice(GUEST_WORK.length)
  }
  return g
}

export function isGuestFsVscodePath(fsPath: string): boolean {
  return vscodePathToGuest(fsPath) != null
}

/** @deprecated use vscodePathToGuest — still returns a guest path for RPC. */
export function browserPathToGuest(fsPath: string): string | null {
  return vscodePathToGuest(fsPath)
}
