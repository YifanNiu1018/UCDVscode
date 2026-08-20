/**
 * C/C++ debugging via gdb/MI in the Alpine guest (:1237), exposed to the
 * Workbench as a DAP adapter registered through the calling extension API.
 */
import type * as vscode from 'vscode'
import {
  DEBUG_PORT,
  GUEST_WORK,
  concatU8,
  connectGuestDebug,
  connectGuestDebugTty,
  encodeDebugHandshake,
  encodeDebugTtyHandshake,
  guestPathToVscode,
  guestRpc,
  isGuestControlReady,
  vscodePathToGuest,
  type TcpConn
} from './guestBridge'

type LogFn = (msg: string) => void
type DapMessage = Record<string, unknown>
type OutputCategory = 'stdout' | 'stderr' | 'console'
type OutputFn = (text: string, category: OutputCategory) => void

const DEBUG_TYPE = 'ucd-gdb'
const MI_TIMEOUT_MS = 90_000

function concatText(a: string, b: string): string {
  return a + b
}

/** Decode a gdb/MI C-string (the `"…"` payload of a ~/@/& stream record). */
function decodeMiCString(quoted: string): string {
  let body = quoted
  if (body.startsWith('"')) {
    body = body.slice(1)
  }
  if (body.endsWith('"')) {
    body = body.slice(0, -1)
  }
  return body.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default:
        return c
    }
  })
}

/** Workbench path or file:// URI → guest absolute path for gdb. */
function toGuestPath(raw: string): string | null {
  let norm = raw.replace(/\\/g, '/')
  if (norm.startsWith('file://')) {
    try {
      norm = decodeURIComponent(new URL(norm).pathname)
    } catch {
      norm = norm.replace(/^file:\/+/, '/')
    }
  }
  if (!norm.startsWith('/')) {
    norm = '/' + norm
  }
  return vscodePathToGuest(norm)
}

/** Guest absolute path → Workbench file path for DAP (not a URI). */
function toClientSourcePath(guestAbs: string): string {
  if (guestAbs.startsWith('/')) {
    return guestPathToVscode(guestAbs)
  }
  return guestPathToVscode(`${GUEST_WORK}/${guestAbs}`)
}

function guestFramePath(fields: Record<string, string>): string {
  const full = fields.fullname ?? fields.filename ?? ''
  if (full.startsWith('/')) {
    return full
  }
  const base = fields.file ?? fields.filename ?? ''
  if (base.length > 0) {
    return `${GUEST_WORK}/${base.replace(/^\.\//, '')}`
  }
  return ''
}

function parseMiFrameList(payload: string): Record<string, string>[] {
  const marker = 'stack=['
  const start = payload.indexOf(marker)
  if (start < 0) {
    return parseMiList(payload, 'stack')
  }
  const items: Record<string, string>[] = []
  const chunk = payload.slice(start + marker.length)
  let i = 0
  while (i < chunk.length) {
    const frameIdx = chunk.indexOf('frame={', i)
    if (frameIdx < 0) {
      break
    }
    let depth = 0
    let j = frameIdx + 6
    for (; j < chunk.length; j++) {
      const ch = chunk[j]
      if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          break
        }
      }
    }
    if (depth !== 0) {
      break
    }
    items.push(parseMiFields(chunk.slice(frameIdx + 7, j)))
    i = j + 1
  }
  return items.length > 0 ? items : parseMiList(payload, 'stack')
}

function parseMiFields(payload: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)=("((?:\\.|[^"\\])*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(payload)) != null) {
    const key = m[1]!
    const val = m[3] != null ? m[3].replace(/\\"/g, '"') : (m[4] ?? '')
    out[key] = val
  }
  return out
}

function miQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isBoundsError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /Cannot find bounds of current function/i.test(msg)
}

function parseMiList(payload: string, key: string): Record<string, string>[] {
  const marker = key + '=['
  const start = payload.indexOf(marker)
  if (start < 0) {
    return []
  }
  const items: Record<string, string>[] = []
  const chunk = payload.slice(start + marker.length)
  const frameRe = /\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = frameRe.exec(chunk)) != null) {
    items.push(parseMiFields(m[1]!))
  }
  return items
}

interface StoppedInfo {
  reason: string
  threadId: number
  signalName?: string
  breakpoint?: string
  raw?: string
}

function funcFromStopped(info: StoppedInfo): string {
  const m = info.raw?.match(/\bfunc="([^"]*)"/)
  return m?.[1] ?? ''
}

type ExecKind = 'run' | 'continue' | 'next' | 'step' | 'finish' | 'nexti' | 'stepi'

class MiSession {
  private rx = ''
  private token = 0
  private bufferedStopped: StoppedInfo | null = null
  private readonly pending = new Map<
    number,
    { resolve: (line: string) => void; reject: (e: Error) => void; timer: number }
  >()
  private stoppedWaiters: Array<{
    resolve: (info: StoppedInfo) => void
    reject: (e: Error) => void
    timer: number
  }> = []

  constructor(
    private readonly conn: TcpConn,
    private readonly onOutput?: OutputFn
  ) {
    conn.on('data', (data: unknown) => {
      const chunk =
        data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data)
      this.rx = concatText(this.rx, chunk)
      this.drain()
    })
    conn.on('close', () => {
      for (const p of this.pending.values()) {
        window.clearTimeout(p.timer)
        p.reject(new Error('gdb/MI connection closed'))
      }
      this.pending.clear()
      for (const w of this.stoppedWaiters) {
        window.clearTimeout(w.timer)
        w.reject(new Error('gdb/MI connection closed'))
      }
      this.stoppedWaiters = []
    })
  }

  close(): void {
    try {
      this.conn.close()
    } catch {
      /* ignore */
    }
  }

  feed(chunk: string): void {
    this.rx = concatText(this.rx, chunk)
    this.drain()
  }

  private drain(): void {
    for (;;) {
      const idx = this.rx.indexOf('\n')
      if (idx < 0) {
        return
      }
      const line = this.rx.slice(0, idx).trim()
      this.rx = this.rx.slice(idx + 1)
      if (line.length === 0 || line === '(gdb)') {
        continue
      }
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith('*stopped')) {
      const fields = parseMiFields(line.slice(8))
      const threadId = Number(fields['thread-id'] ?? fields.threadId ?? fields.thread ?? '1') || 1
      const info: StoppedInfo = {
        reason: fields.reason ?? 'unknown',
        threadId,
        signalName: fields['signal-name'],
        breakpoint: fields.bkptno,
        raw: line
      }
      const waiters = this.stoppedWaiters
      this.stoppedWaiters = []
      if (waiters.length === 0) {
        this.bufferedStopped = info
        return
      }
      for (const w of waiters) {
        window.clearTimeout(w.timer)
        w.resolve(info)
      }
      return
    }

    const c0 = line[0]
    // MI stream records: ~ console, @ target (inferior), & log. Always `X"…"`.
    if ((c0 === '~' || c0 === '@' || c0 === '&') && line[1] === '"') {
      const text = decodeMiCString(line.slice(1))
      if (c0 === '&') {
        // gdb internal log — noisy; keep out of the debug console.
        return
      }
      this.onOutput?.(text, c0 === '@' ? 'stdout' : 'console')
      return
    }
    // MI async/status/notify records (*running, =thread-group-added, +download…).
    if ((c0 === '*' || c0 === '=' || c0 === '+') && /^[*=+][a-z][a-z-]*/.test(line)) {
      return
    }

    const sync = /^(\d+)\^(done|running|error)(?:,(.*))?$/.exec(line)
    if (sync != null) {
      const id = Number(sync[1])
      const pending = this.pending.get(id)
      if (pending != null) {
        window.clearTimeout(pending.timer)
        this.pending.delete(id)
        if (sync[2] === 'error') {
          pending.reject(new Error(line))
        } else {
          pending.resolve(line)
        }
      }
      return
    }

    // Anything else is the inferior writing to gdb's shared stdout fd.
    this.onOutput?.(line + '\n', 'stdout')
  }

  command(cmd: string, timeoutMs = MI_TIMEOUT_MS): Promise<string> {
    const id = ++this.token
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MI timeout: ${cmd}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.conn.write(new TextEncoder().encode(`${id}${cmd}\n`))
    })
  }

  waitStopped(timeoutMs = MI_TIMEOUT_MS): Promise<StoppedInfo> {
    if (this.bufferedStopped != null) {
      const info = this.bufferedStopped
      this.bufferedStopped = null
      return Promise.resolve(info)
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.stoppedWaiters = this.stoppedWaiters.filter((w) => w.timer !== timer)
        reject(new Error('gdb did not stop'))
      }, timeoutMs)
      this.stoppedWaiters.push({ resolve, reject, timer })
    })
  }

  cancelStoppedWaiters(why: string): void {
    const waiters = this.stoppedWaiters
    this.stoppedWaiters = []
    for (const w of waiters) {
      window.clearTimeout(w.timer)
      w.reject(new Error(why))
    }
  }

  async execRaw(miCmd: string): Promise<StoppedInfo> {
    this.bufferedStopped = null
    const stopped = this.waitStopped()
    try {
      await this.command(miCmd)
    } catch (e) {
      this.cancelStoppedWaiters(e instanceof Error ? e.message : String(e))
      throw e
    }
    return await stopped
  }

  async exec(kind: ExecKind, threadId = 1): Promise<StoppedInfo> {
    const map: Record<ExecKind, string> = {
      run: '-exec-run',
      continue: '-exec-continue',
      next: '-exec-next',
      step: '-exec-step',
      finish: '-exec-finish',
      nexti: '-exec-next-instruction',
      stepi: '-exec-step-instruction'
    }
    let cmd = map[kind]
    // Same as microsoft/MIEngine GdbMICommandFactory: --thread/--frame so next
    // applies to the current stack frame, not a stale selection.
    if (kind === 'continue') {
      cmd += ` --thread ${threadId}`
    } else if (kind !== 'run') {
      cmd += ` --thread ${threadId} --frame 0`
    }
    return await this.execRaw(cmd)
  }
}

function openMiSession(onOutput: OutputFn, timeoutMs = 30_000): Promise<MiSession> {
  return new Promise((resolve, reject) => {
    const conn = connectGuestDebug()
    let rx: Uint8Array = new Uint8Array(0)
    let settled = false

    const fail = (e: Error): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        conn.close()
      } catch {
        /* ignore */
      }
      reject(e)
    }

    const timer = window.setTimeout(
      () => fail(new Error('guest debug handshake timeout')),
      timeoutMs
    )

    conn.on('connect', () => {
      try {
        conn.write(encodeDebugHandshake(GUEST_WORK))
      } catch (e) {
        window.clearTimeout(timer)
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })

    conn.on('data', (data: unknown) => {
      if (settled) {
        return
      }
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      rx = new Uint8Array([...rx, ...chunk])
      if (rx.length < 4) {
        return
      }
      const len = new DataView(rx.buffer, rx.byteOffset, rx.byteLength).getUint32(0, false)
      if (rx.length < 4 + len) {
        return
      }
      const payload = new TextDecoder().decode(rx.subarray(4, 4 + len))
      const rest = rx.subarray(4 + len)
      window.clearTimeout(timer)

      let ack: { ok?: boolean; stderr?: string }
      try {
        ack = JSON.parse(payload) as { ok?: boolean; stderr?: string }
      } catch (e) {
        fail(new Error(`guest debug bad ack: ${String(e)}`))
        return
      }
      if (ack.ok !== true) {
        fail(new Error(`guest debug refused: ${ack.stderr ?? 'unknown'}`))
        return
      }

      settled = true
      const session = new MiSession(conn, onOutput)
      if (rest.length > 0) {
        session.feed(new TextDecoder().decode(rest))
      }
      resolve(session)
    })

    conn.on('close', () => fail(new Error('debug socket closed before ack')))
    conn.on('shutdown', () => fail(new Error('debug socket shutdown before ack')))
  })
}

/**
 * Bridge to the guest debug-TTY port: after a framed ack carrying the inferior
 * `/dev/pts/N`, the socket is a raw pipe to that PTY master. Wire `setSink` to a
 * terminal's write emitter and `write` to its input for interactive program I/O.
 */
class DebugTty {
  private sink: ((data: Uint8Array) => void) | null = null
  private readonly buffered: Uint8Array[] = []

  private constructor(
    private readonly conn: TcpConn,
    readonly tty: string
  ) {}

  static open(timeoutMs = 15_000): Promise<DebugTty> {
    return new Promise((resolve, reject) => {
      const conn = connectGuestDebugTty()
      let rx: Uint8Array = new Uint8Array(0)
      let instance: DebugTty | null = null
      let settled = false

      const fail = (e: Error): void => {
        if (settled) {
          return
        }
        settled = true
        try {
          conn.close()
        } catch {
          /* ignore */
        }
        reject(e)
      }

      const timer = window.setTimeout(
        () => fail(new Error('debug tty handshake timeout')),
        timeoutMs
      )

      conn.on('connect', () => {
        try {
          conn.write(encodeDebugTtyHandshake(GUEST_WORK))
        } catch (e) {
          window.clearTimeout(timer)
          fail(e instanceof Error ? e : new Error(String(e)))
        }
      })

      conn.on('data', (data: unknown) => {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
        if (instance != null) {
          instance.handleRaw(chunk)
          return
        }
        rx = concatU8(rx, chunk)
        if (rx.length < 4) {
          return
        }
        const len = new DataView(rx.buffer, rx.byteOffset, rx.byteLength).getUint32(0, false)
        if (rx.length < 4 + len) {
          return
        }
        const payload = new TextDecoder().decode(rx.subarray(4, 4 + len))
        const rest = rx.subarray(4 + len)
        window.clearTimeout(timer)
        let ack: { ok?: boolean; tty?: string; stderr?: string }
        try {
          ack = JSON.parse(payload) as { ok?: boolean; tty?: string; stderr?: string }
        } catch (e) {
          fail(new Error(`debug tty bad ack: ${String(e)}`))
          return
        }
        if (ack.ok !== true || ack.tty == null || ack.tty === '') {
          fail(new Error(`debug tty refused: ${ack.stderr ?? 'unknown'}`))
          return
        }
        settled = true
        instance = new DebugTty(conn, ack.tty)
        if (rest.length > 0) {
          instance.handleRaw(rest)
        }
        resolve(instance)
      })

      conn.on('close', () => fail(new Error('debug tty closed before ack')))
      conn.on('shutdown', () => fail(new Error('debug tty shutdown before ack')))
    })
  }

  private handleRaw(data: Uint8Array): void {
    if (this.sink != null) {
      this.sink(data)
    } else {
      this.buffered.push(data)
    }
  }

  setSink(fn: (data: Uint8Array) => void): void {
    this.sink = fn
    for (const b of this.buffered) {
      fn(b)
    }
    this.buffered.length = 0
  }

  write(data: Uint8Array): void {
    try {
      this.conn.write(data)
    } catch {
      /* the socket may already be closing */
    }
  }

  close(): void {
    try {
      this.conn.close()
    } catch {
      /* ignore */
    }
  }
}

/** Kept across sessions so a new debug run can retire the prior program terminal. */
let lastDebugTerminal: vscode.Terminal | null = null

class UcdGdbDebugAdapter implements vscode.DebugAdapter {
  private readonly events: vscode.EventEmitter<DapMessage>
  readonly onDidSendMessage: vscode.Event<DapMessage>
  private seq = 1
  private mi: MiSession | null = null
  private threadId = 1
  private stopOnEntry = true
  private pendingBreakpoints: Array<{ guestFile: string; line: number }> = []
  private binaryPath = ''
  private userSourcePaths = new Set<string>()
  private breakpointsInstalled = false
  private launched = false
  private configDone = false
  private started = false
  private ttyActive = false
  private ttyConn: DebugTty | null = null
  private ttyDisplay: ((text: string) => void) | null = null
  private readonly api: typeof vscode

  constructor(api: typeof vscode, private readonly log: LogFn) {
    this.api = api
    this.events = new api.EventEmitter<DapMessage>()
    this.onDidSendMessage = this.events.event
  }

  dispose(): void {
    this.mi?.close()
    this.mi = null
    this.closeInferiorTty()
    this.events.dispose()
  }

  /**
   * Close the guest bridge but leave the terminal on screen so the final output
   * stays readable (VS Code keeps it too). The next debug session retires it.
   */
  private closeInferiorTty(): void {
    this.ttyConn?.close()
    this.ttyConn = null
    this.ttyDisplay = null
    this.ttyActive = false
  }

  /**
   * Give the inferior a real terminal: connect the guest debug-TTY bridge, show
   * it as an extension pseudoterminal, and point gdb at that pts. On any failure
   * we silently keep the shared-pipe path (output still reaches the Debug Console).
   */
  private async setupInferiorTty(title: string): Promise<void> {
    if (this.mi == null) {
      return
    }
    let tty: DebugTty
    try {
      tty = await DebugTty.open()
    } catch (e) {
      this.log('debug: inferior tty unavailable, using debug console: ' + String(e))
      return
    }
    // Retire the terminal left over from a previous debug session.
    try {
      lastDebugTerminal?.dispose()
    } catch {
      /* ignore */
    }
    lastDebugTerminal = null
    try {
      const writeEmitter = new this.api.EventEmitter<string>()
      const decoder = new TextDecoder()
      tty.setSink((u8) => writeEmitter.fire(decoder.decode(u8, { stream: true })))
      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
          /* nothing to do; guest pty already live */
        },
        close: () => tty.close(),
        handleInput: (data: string) => tty.write(new TextEncoder().encode(data))
      }
      const term = this.api.window.createTerminal({ name: `Debug: ${title}`, pty })
      term.show(true)
      this.ttyConn = tty
      lastDebugTerminal = term
      this.ttyDisplay = (text) => writeEmitter.fire(text)
      try {
        await this.mi.command(`-inferior-tty-set ${tty.tty}`)
      } catch {
        await this.mi.command(
          `-interpreter-exec console ${miQuote('set inferior-tty ' + tty.tty)}`
        )
      }
      this.ttyActive = true
      this.log('debug: inferior tty ' + tty.tty)
    } catch (e) {
      this.log('debug: inferior tty setup failed: ' + String(e))
      tty.close()
      this.closeInferiorTty()
    }
  }

  handleMessage(message: DapMessage): void {
    void this.dispatch(message)
  }

  private send(msg: DapMessage): void {
    this.events.fire(msg)
  }

  private response(request: DapMessage, body?: Record<string, unknown>): void {
    this.send({
      type: 'response',
      seq: this.seq++,
      request_seq: request.seq,
      success: true,
      command: request.command,
      body: body ?? {}
    })
  }

  private fail(request: DapMessage, message: string): void {
    this.send({
      type: 'response',
      seq: this.seq++,
      request_seq: request.seq,
      success: false,
      command: request.command,
      message
    })
  }

  private event(event: string, body: Record<string, unknown>): void {
    this.send({ type: 'event', seq: this.seq++, event, body })
  }

  private async dispatch(message: DapMessage): Promise<void> {
    const cmd = String(message.command ?? '')
    if (cmd !== '') {
      this.log(`debug dap ← ${cmd}`)
    }
    try {
      switch (cmd) {
        case 'initialize':
          this.response(message, {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: false,
            supportsConditionalBreakpoints: false,
            supportsHitConditionalBreakpoints: false,
            supportsEvaluateForHovers: true,
            supportsExceptionInfoRequest: false,
            exceptionBreakpointFilters: [],
            supportTerminateDebuggee: true
          })
          // Workbench waits for this before setBreakpoints / configurationDone / run.
          window.setTimeout(() => this.event('initialized', {}), 0)
          break
        case 'launch':
          await this.onLaunch(message)
          break
        case 'setBreakpoints':
          await this.onSetBreakpoints(message)
          break
        case 'setExceptionBreakpoints':
          this.response(message, { breakpoints: [] })
          break
        case 'configurationDone':
          await this.onConfigurationDone(message)
          break
        case 'threads':
          this.response(message, { threads: [{ id: this.threadId, name: 'main' }] })
          break
        case 'stackTrace':
          await this.onStackTrace(message)
          break
        case 'scopes':
          await this.onScopes(message)
          break
        case 'variables':
          await this.onVariables(message)
          break
        case 'evaluate':
          await this.onEvaluate(message)
          break
        case 'source':
          await this.onSource(message)
          break
        case 'continue':
          await this.onContinue(message)
          break
        case 'next':
          await this.onStep(message, 'next')
          break
        case 'stepIn':
          await this.onStep(message, 'step')
          break
        case 'stepOut':
          await this.onStep(message, 'finish')
          break
        case 'disconnect':
          await this.onDisconnect(message)
          break
        default:
          this.response(message, {})
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`debug ${cmd} failed: ${msg}`)
      this.fail(message, msg)
    }
  }

  private collectUiBreakpoints(): void {
    const seen = new Set(this.pendingBreakpoints.map((b) => `${b.guestFile}:${b.line}`))
    for (const bp of this.api.debug.breakpoints) {
      if (!(bp instanceof this.api.SourceBreakpoint) || !bp.enabled) {
        continue
      }
      const guestFile = toGuestPath(bp.location.uri.fsPath)
      const line = bp.location.range.start.line + 1
      if (guestFile == null || line <= 0) {
        continue
      }
      const key = `${guestFile}:${line}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      this.pendingBreakpoints.push({ guestFile, line })
    }
  }

  private hasUserBreakpoints(): boolean {
    for (const bp of this.api.debug.breakpoints) {
      if (!(bp instanceof this.api.SourceBreakpoint) || !bp.enabled) {
        continue
      }
      if (toGuestPath(bp.location.uri.fsPath) != null) {
        return true
      }
    }
    return false
  }

  private dapStopReason(info: StoppedInfo, fallbackReason: string): string {
    const reason = info.reason
    if (reason.includes('breakpoint') || reason.includes('watchpoint') || info.breakpoint != null) {
      return 'breakpoint'
    }
    if (reason.includes('end-stepping') || reason.includes('step') || reason === 'location-reached') {
      return 'step'
    }
    if (reason === 'function-finished') {
      return 'step'
    }
    if (reason === 'entry' || reason === 'entry-point') {
      return 'entry'
    }
    // gdb reports breakpoint hits as SIGTRAP under signal-received on many targets.
    if (reason === 'signal-received') {
      const sig = (info.signalName ?? '').toUpperCase()
      if (sig === 'SIGTRAP' || sig === 'TRAP' || sig === '5') {
        return fallbackReason === 'step' ? 'step' : 'breakpoint'
      }
      if (sig === 'SIGINT' || sig === 'SIGSTOP') {
        return 'pause'
      }
      if (sig === 'SIGSEGV' || sig === 'SIGABRT' || sig === 'SIGBUS' || sig === 'SIGILL') {
        return 'exception'
      }
      // Unknown signal: keep the session usable instead of the "exception" UI.
      return fallbackReason === 'step' ? 'step' : 'pause'
    }
    return fallbackReason
  }

  private emitStopped(info: StoppedInfo, fallbackReason: string): void {
    this.threadId = info.threadId
    const reason = info.reason
    const sig = info.signalName ?? '-'
    const dapReason = this.dapStopReason(info, fallbackReason)
    this.log(`debug: stopped reason=${reason} signal=${sig} dap=${dapReason} func=${funcFromStopped(info) || '-'} thread=${this.threadId}`)
    if (info.raw != null) {
      this.log(`debug: ${info.raw}`)
    }
    if (reason.startsWith('exited') || reason === 'exited-normally') {
      const codeM = info.raw?.match(/exit-code="([0-7]+)"/)
      const exitCode = codeM != null ? parseInt(codeM[1]!, 8) : 0
      const banner = `[program exited with code ${exitCode}]`
      if (this.ttyActive && this.ttyDisplay != null) {
        this.ttyDisplay(`\r\n\x1b[90m${banner}\x1b[0m\r\n`)
      } else {
        this.event('output', { category: 'console', output: `\n${banner}\n` })
      }
      this.event('exited', { exitCode })
      this.event('terminated', {})
      return
    }
    const body: Record<string, unknown> = {
      reason: dapReason,
      threadId: this.threadId,
      allThreadsStopped: true
    }
    if (dapReason === 'exception' && info.signalName != null) {
      body.text = info.signalName
    }
    this.event('stopped', body)
  }

  /** Program stdout/stderr and gdb console text → the Debug Console. */
  private emitOutput(text: string, category: OutputCategory): void {
    if (text.length === 0) {
      return
    }
    // gdb prints a lot of console (~) chatter while loading symbols and skipping
    // libc files; only surface it once the program is actually running.
    if (category === 'console' && !this.started) {
      return
    }
    this.event('output', { category, output: text })
  }

  /**
   * `set exec-wrapper stdbuf -oL -e0` makes the inferior line-buffer stdout even
   * though gdb's stdout is a pipe, so output appears as it is printed. Only
   * enabled when stdbuf actually exists, otherwise -exec-run would fail to exec.
   */
  private async setLineBufferedOutput(): Promise<void> {
    if (this.mi == null) {
      return
    }
    let hasStdbuf = false
    try {
      const r = await guestRpc({ op: 'exec', cmd: 'command -v stdbuf', timeoutMs: 4000 })
      hasStdbuf = r.ok === true && (r.stdout ?? '').trim().length > 0
    } catch {
      hasStdbuf = false
    }
    if (!hasStdbuf) {
      this.log('debug: stdbuf missing — inferior stdout stays block-buffered')
      return
    }
    try {
      await this.mi.command('-interpreter-exec console "set exec-wrapper stdbuf -oL -e0"')
      this.log('debug: line-buffered inferior stdout via stdbuf')
    } catch (e) {
      this.log('debug: exec-wrapper stdbuf failed: ' + String(e))
    }
  }

  private async insertBreakpoint(guestFile: string, line: number): Promise<boolean> {
    if (this.mi == null) {
      return false
    }
    const base = guestFile.split('/').pop() ?? guestFile
    const cmds = [
      `-break-insert -f ${guestFile}:${line}`,
      `-break-insert --source ${base} --line ${line}`,
      `-break-insert ${guestFile}:${line}`
    ]
    for (const cmd of cmds) {
      try {
        await this.mi.command(cmd)
        this.log(`debug: ${cmd}`)
        return true
      } catch (e) {
        this.log(`debug: ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return false
  }

  private async startDebuggee(): Promise<void> {
    if (this.started || this.mi == null) {
      return
    }
    this.started = true
    this.collectUiBreakpoints()
    if (!this.breakpointsInstalled) {
      await this.applyPendingBreakpoints()
      if (this.pendingBreakpoints.length > 0) {
        this.breakpointsInstalled = true
      }
    }
    const userBps = this.pendingBreakpoints.length > 0 || this.hasUserBreakpoints()
    if (this.stopOnEntry && !userBps) {
      try {
        await this.mi.command('-break-insert -t main')
        this.log('debug: stop-on-entry main')
      } catch (e) {
        this.log('debug: stop-on-entry failed: ' + String(e))
      }
    } else if (userBps) {
      this.log(`debug: ${this.pendingBreakpoints.length} user breakpoint(s), skip stop-on-entry`)
    }
    this.log('debug: running')
    this.event('thread', { reason: 'started', threadId: this.threadId })
    const stopped = await this.mi.exec('run')
    this.emitStopped(stopped, userBps ? 'breakpoint' : 'entry')
  }

  private async applyPendingBreakpoints(): Promise<void> {
    if (this.mi == null || this.pendingBreakpoints.length === 0) {
      return
    }
    for (const bp of this.pendingBreakpoints) {
      const ok = await this.insertBreakpoint(bp.guestFile, bp.line)
      if (!ok) {
        this.log(`debug: breakpoint failed ${bp.guestFile}:${bp.line}`)
      }
    }
  }

  private async onLaunch(message: DapMessage): Promise<void> {
    this.breakpointsInstalled = false
    this.launched = false
    this.started = false
    const args = (message.arguments ?? {}) as Record<string, unknown>
    this.stopOnEntry = args.stopOnEntry !== false && !this.hasUserBreakpoints()
    const program = String(args.program ?? '')
    const guestSrc = toGuestPath(program)
    if (guestSrc == null) {
      throw new Error('program is outside guest workspace: ' + program)
    }

    const relName = guestSrc.startsWith(GUEST_WORK + '/')
      ? guestSrc.slice(GUEST_WORK.length + 1)
      : guestSrc.split('/').pop() ?? 'main.c'

    let source = ''
    const doc = this.api.workspace.textDocuments.find(
      (d) => toGuestPath(d.uri.fsPath) === guestSrc
    )
    if (doc != null) {
      source = doc.getText()
    }

    this.userSourcePaths.clear()
    this.userSourcePaths.add(guestSrc)
    this.userSourcePaths.add(relName)
    {
      const base = guestSrc.split('/').pop()
      if (base != null && base.length > 0) {
        this.userSourcePaths.add(base)
      }
    }
    const compiled = await guestRpc({
      op: 'debug_compile',
      name: relName,
      code: source || undefined
    })
    if (!compiled.ok || compiled.path == null) {
      throw new Error(compiled.stderr || 'debug_compile failed')
    }
    this.binaryPath = compiled.path

    this.log(`debug: starting gdb on ${this.binaryPath}`)
    this.mi = await openMiSession((text, category) => this.emitOutput(text, category))
    await this.mi.command('-gdb-set pagination off')
    await this.mi.command('-gdb-set confirm off')
    await this.mi.command('-gdb-set startup-with-shell off')
    await this.mi.command('-gdb-set disable-randomization on')
    await this.mi.command('-gdb-set mi-async off')
    // Give the program a real terminal (interactive stdin + live output).
    await this.setupInferiorTty(relName)
    // Without a tty, force line-buffered stdout so printf shows before exit.
    // stdbuf is coreutils-only, so this is best-effort on busybox-only guests.
    if (!this.ttyActive) {
      await this.setLineBufferedOutput()
    }
    try {
      await this.mi.command('-gdb-set architecture i386')
    } catch {
      /* gdb already knows the binary arch */
    }
    try {
      await this.mi.command('-gdb-set displaced-stepping off')
    } catch {
      /* older gdb */
    }
    try {
      // musl is statically linked with line info; without skip, `next` walks into puts/syscalls.
      // Use the canonical option name (older/newer gdb may reject the -rfu abbreviation).
      await this.mi.command('-interpreter-exec console "skip -rfunction ^__"')
    } catch {
      /* skip not supported */
    }
    await this.mi.command(`-file-exec-and-symbols ${this.binaryPath}`)
    await this.skipNonUserSources()

    this.launched = true
    this.response(message, {})
    if (this.configDone) {
      await this.startDebuggee()
    } else {
      window.setTimeout(() => {
        if (!this.started && this.launched) {
          this.log('debug: starting without configurationDone')
          void this.startDebuggee().catch((e) => {
            this.log('debug start failed: ' + String(e))
            this.event('terminated', {})
          })
        }
      }, 1500)
    }
  }

  private async onSetBreakpoints(message: DapMessage): Promise<void> {
    const args = (message.arguments ?? {}) as Record<string, unknown>
    const source = (args.source ?? {}) as { path?: string }
    const lines = (args.breakpoints ?? []) as Array<{ line?: number }>
    const guestFile =
      source.path != null ? toGuestPath(source.path) : null
    const verified: Array<{ id: number; verified: boolean; line: number }> = []

    this.pendingBreakpoints = []
    if (guestFile != null) {
      for (const bp of lines) {
        const line = Number(bp.line ?? 0)
        if (line > 0) {
          this.pendingBreakpoints.push({ guestFile, line })
        }
      }
    } else if (lines.length > 0 && source.path != null) {
      this.log(`debug: breakpoint path not in guest workspace: ${source.path}`)
    }

    if (this.mi != null && this.pendingBreakpoints.length > 0) {
      for (let i = 0; i < this.pendingBreakpoints.length; i++) {
        const bp = this.pendingBreakpoints[i]!
        const ok = await this.insertBreakpoint(bp.guestFile, bp.line)
        verified.push({ id: i + 1, verified: ok, line: bp.line })
      }
      this.breakpointsInstalled = true
    } else {
      // gdb not ready yet — accept breakpoints; apply in launch/configurationDone.
      for (let i = 0; i < this.pendingBreakpoints.length; i++) {
        verified.push({
          id: i + 1,
          verified: true,
          line: this.pendingBreakpoints[i]!.line
        })
      }
    }

    this.response(message, { breakpoints: verified })
  }

  private async onConfigurationDone(message: DapMessage): Promise<void> {
    this.configDone = true
    this.response(message, {})
    if (this.launched) {
      try {
        await this.startDebuggee()
      } catch (e) {
        this.log('debug start failed: ' + String(e))
        this.event('terminated', {})
      }
    }
  }

  private async onStackTrace(message: DapMessage): Promise<void> {
    if (this.mi == null) {
      this.response(message, { stackFrames: [], totalFrames: 0 })
      return
    }
    const args = (message.arguments ?? {}) as { startFrame?: number; levels?: number }
    const start = Number(args.startFrame ?? 0)
    const levels = Number(args.levels ?? 20)
    const line = await this.mi.command('-stack-list-frames')
    const frames = parseMiFrameList(line)
    const stackFrames = frames.slice(start, start + levels).map((f, i) => {
      const level = Number(f.level ?? i)
      const guestFile = guestFramePath(f)
      const lineNo = Number(f.line ?? '0') || 0
      const clientPath = guestFile ? toClientSourcePath(guestFile) : ''
      const sourceName = clientPath
        ? (clientPath.split('/').pop() ?? clientPath)
        : (f.func || f.function || '?')
      const frame: Record<string, unknown> = {
        id: 1000 + level,
        name: f.func || f.function || '?',
        line: lineNo || 1,
        column: 1
      }
      // Only attach a source when gdb gave a real path. An empty source object
      // makes Workbench use a debug: URI and crash if `source` returns no content.
      if (clientPath.length > 0) {
        frame.source = {
          name: sourceName,
          path: clientPath
        }
      }
      return frame
    })
    this.response(message, { stackFrames, totalFrames: frames.length })
  }

  private async onScopes(message: DapMessage): Promise<void> {
    this.response(message, {
      scopes: [
        { name: 'Locals', variablesReference: 1000, expensive: false },
        { name: 'Registers', variablesReference: 1001, expensive: true }
      ]
    })
  }

  private async onVariables(message: DapMessage): Promise<void> {
    if (this.mi == null) {
      this.response(message, { variables: [] })
      return
    }
    const args = (message.arguments ?? {}) as { variablesReference?: number }
    const ref = Number(args.variablesReference ?? 0)
    if (ref === 1001) {
      this.response(message, { variables: [] })
      return
    }
    try {
      try {
        await this.mi.command('-stack-select-frame 0')
      } catch {
        /* no frame yet */
      }
      const line = await this.mi.command('-stack-list-variables --simple-values')
      const vars = parseMiList(line, 'variables')
      const variables = vars.map((v, i) => ({
        name: v.name ?? `v${i}`,
        value: v.value ?? '?',
        variablesReference: 0
      }))
      this.response(message, { variables })
    } catch (e) {
      this.log('debug variables: ' + (e instanceof Error ? e.message : String(e)))
      this.response(message, { variables: [] })
    }
  }

  private async selectCurrentFrame(): Promise<void> {
    if (this.mi == null) {
      return
    }
    try {
      await this.mi.command(`-thread-select ${this.threadId}`)
    } catch {
      /* single-threaded */
    }
    try {
      await this.mi.command('-stack-select-frame 0')
    } catch {
      /* no frame yet */
    }
  }

  private async currentLine(): Promise<{ file: string; line: number; func: string } | null> {
    if (this.mi == null) {
      return null
    }
    try {
      const raw = await this.mi.command('-stack-info-frame')
      const f = parseMiFields(raw)
      return {
        file: f.fullname || f.file || f.filename || '',
        line: Number(f.line ?? '0') || 0,
        func: f.func || f.function || ''
      }
    } catch {
      return null
    }
  }

  private isUserSourceFile(full: string): boolean {
    const f = full.replace(/\\/g, '/')
    if (f.includes('/root/workspace') || f.includes('/workspace/')) {
      return true
    }
    const base = f.split('/').pop() ?? ''
    if (base.length > 0 && this.userSourcePaths.has(base)) {
      return true
    }
    for (const src of this.userSourcePaths) {
      if (f === src || f.endsWith('/' + src)) {
        return true
      }
    }
    return false
  }

  /**
   * Same approach vscode-cpptools suggests for gdb: skip every compilation unit
   * that is not in the workspace so `next` does not walk musl (puts.c, …).
   */
  private async skipNonUserSources(): Promise<void> {
    if (this.mi == null) {
      return
    }
    let files: Record<string, string>[] = []
    try {
      const raw = await this.mi.command('-file-list-exec-source-files')
      files = parseMiList(raw, 'files')
    } catch (e) {
      this.log('debug: -file-list-exec-source-files failed: ' + String(e))
      return
    }
    let n = 0
    for (const f of files) {
      const full = f.fullname || f.file || ''
      const name = f.file || full.split('/').pop() || ''
      if (name.length === 0) {
        continue
      }
      // Every workspace source (main.c AND its headers) is user code. Record it
      // by both full path and basename so `next`/`step` into a header stops there
      // instead of `finish`-ing back out — gdb frames sometimes only give a base.
      if (this.isUserSourceFile(full) || this.isUserSourceFile(name)) {
        if (full.length > 0) {
          this.userSourcePaths.add(full)
          const fbase = full.split('/').pop()
          if (fbase != null && fbase.length > 0) {
            this.userSourcePaths.add(fbase)
          }
        }
        this.userSourcePaths.add(name)
        continue
      }
      try {
        await this.mi.command(`-interpreter-exec console ${miQuote('skip file ' + name)}`)
        n++
      } catch {
        /* file may already be skipped */
      }
    }
    this.log(`debug: gdb skip ${n} non-workspace source file(s)`)
  }

  private isUserLoc(loc: { file: string; func: string } | null): boolean {
    if (loc == null) {
      return false
    }
    const func = loc.func
    if (func === '' || func === '??' || func === '__kernel_vsyscall' || func.startsWith('__')) {
      return false
    }
    return this.isUserSourceFile(loc.file)
  }

  private async advancePastLine(
    start: { file: string; line: number; func: string } | null
  ): Promise<StoppedInfo> {
    if (this.mi == null) {
      throw new Error('gdb is not running')
    }
    if (start != null && start.file.length > 0 && start.line > 0) {
      try {
        this.log(`debug: until ${start.file}:${start.line + 1}`)
        return await this.mi.execRaw(`-exec-until ${start.file}:${start.line + 1}`)
      } catch (e) {
        this.log('debug: until failed: ' + String(e))
      }
      try {
        await this.mi.command(`-break-insert -t ${start.file}:${start.line + 1}`)
        return await this.mi.exec('continue', this.threadId)
      } catch (e) {
        this.log('debug: temp breakpoint continue failed: ' + String(e))
      }
    }
    return await this.mi.exec('next', this.threadId)
  }

  /**
   * `next` over puts() with musl debug info stops in __kernel_vsyscall.
   * Finish frames until we are back in the student's function.
   */
  private async returnToUserCode(
    start: { file: string; line: number; func: string } | null,
    kind: 'next' | 'step',
    first: StoppedInfo
  ): Promise<StoppedInfo> {
    if (this.mi == null) {
      return first
    }
    let info = first
    for (let i = 0; i < 40; i++) {
      if (info.reason.startsWith('exited')) {
        return info
      }
      const loc = await this.currentLine()
      const here = {
        file: loc?.file ?? '',
        line: loc?.line ?? 0,
        func: loc?.func || funcFromStopped(info)
      }
      if (this.isUserLoc(here)) {
        if (
          kind === 'next' &&
          start != null &&
          here.func === start.func &&
          here.line === start.line
        ) {
          this.log('debug: still on same user line after libc, advancing')
          info = await this.advancePastLine(start)
          continue
        }
        return info
      }
      this.log(`debug: in ${here.func || '??'} — return to user code`)
      if (kind === 'next' && start != null) {
        try {
          info = await this.advancePastLine(start)
          continue
        } catch (e) {
          this.log('debug: advancePastLine failed: ' + String(e))
        }
      }
      try {
        info = await this.mi.exec('finish', this.threadId)
      } catch (e) {
        this.log('debug: finish failed: ' + String(e))
        info = await this.advancePastLine(start)
        return info
      }
    }
    return info
  }

  /**
   * Direct `call` targets on a source line that resolve to a workspace file.
   * `spec` is the gdb breakpoint location: the function name (so the temp
   * breakpoint lands after the prologue on the first body line, like VS Code)
   * or `*0xADDR` when the callee has no symbol.
   */
  private async userCallTargetsOnLine(
    file: string,
    line: number
  ): Promise<{ spec: string }[]> {
    if (this.mi == null) {
      return []
    }
    let raw: string
    try {
      raw = await this.mi.command(
        `-data-disassemble -f ${file} -l ${line} -n -1 -- 5`
      )
    } catch (e) {
      this.log('debug: disassemble failed: ' + String(e))
      return []
    }
    // mode-5 groups instructions per source line as src_and_asm_line={line="N",…}.
    const seen = new Set<string>()
    const found: { addr: string; sym: string }[] = []
    for (const block of raw.split('src_and_asm_line={')) {
      const lm = block.match(/^line="(\d+)"/)
      if (lm == null || Number(lm[1]) !== line) {
        continue
      }
      const callRe = /inst="[^"]*?\bcall[a-z]*\s+(0x[0-9a-fA-F]+)(?:\s+<([^>+]+))?/g
      let cm: RegExpExecArray | null
      while ((cm = callRe.exec(block)) != null) {
        const key = cm[1]!
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        found.push({ addr: cm[1]!, sym: cm[2] ?? '' })
      }
    }
    const targets: { spec: string }[] = []
    for (const t of found) {
      let userFile = false
      try {
        const info = await this.mi.command(
          `-interpreter-exec console ${miQuote('info line *' + t.addr)}`
        )
        const fm = info.replace(/\\/g, '').match(/of "([^"]+)"/)
        if (fm != null) {
          userFile = this.isUserSourceFile(fm[1]!)
        }
      } catch {
        /* unknown → treat as non-user */
      }
      if (userFile) {
        targets.push({ spec: t.sym.length > 0 ? t.sym : '*' + t.addr })
      }
    }
    return targets
  }

  /**
   * Step In for the v86 guest. v86 does not faithfully emulate the x86 trap flag,
   * so gdb's single-stepping (`step`/`next`/`stepi`, all TF/PTRACE_SINGLESTEP
   * based) "runs away" — a single step can execute the whole program. Only
   * software breakpoints (int3) are reliable. So we implement Step In purely with
   * breakpoints: find the direct `call`s on the current line, drop temporary
   * breakpoints on the ones that go to workspace code, then `-exec-until` the next
   * line. If a user callee is reached first we stop inside it (stepped in); if the
   * line has no user callee we stop on the next line (behaves like Step Over).
   */
  private async execStepInto(
    start: { file: string; line: number; func: string } | null
  ): Promise<StoppedInfo> {
    if (this.mi == null) {
      throw new Error('gdb is not running')
    }
    if (start == null || start.file.length === 0 || start.line <= 0) {
      return await this.advancePastLine(start)
    }

    const targets = await this.userCallTargetsOnLine(start.file, start.line)
    if (targets.length === 0) {
      this.log('debug: step-in — no user callee on this line, stepping over')
      return await this.advancePastLine(start)
    }

    const tempNums: string[] = []
    for (const t of targets) {
      try {
        const raw = await this.mi.command(`-break-insert -t ${t.spec}`)
        const m = raw.match(/number="(\d+)"/)
        if (m != null) {
          tempNums.push(m[1]!)
        }
      } catch (e) {
        this.log('debug: step-in break-insert failed: ' + String(e))
      }
    }

    let info: StoppedInfo
    try {
      info = await this.mi.execRaw(`-exec-until ${start.file}:${start.line + 1}`)
    } catch (e) {
      this.log('debug: step-in until failed: ' + String(e))
      info = await this.advancePastLine(start)
    } finally {
      for (const n of tempNums) {
        try {
          await this.mi.command(`-break-delete ${n}`)
        } catch {
          /* already deleted when hit */
        }
      }
    }

    const loc = await this.currentLine()
    if (loc != null) {
      this.log(`debug: step-in → ${loc.func || '?'} ${loc.file}:${loc.line}`)
    }
    return info
  }

  /** Source-level step. Next stays in user code; Step In follows the callee. */
  private async execStepOrInstruction(kind: 'continue' | 'next' | 'step' | 'finish'): Promise<StoppedInfo> {
    if (this.mi == null) {
      throw new Error('gdb is not running')
    }
    await this.selectCurrentFrame()
    if (kind === 'continue' || kind === 'finish') {
      try {
        return await this.mi.exec(kind, this.threadId)
      } catch (e) {
        if (!isBoundsError(e) || kind !== 'continue') {
          throw e
        }
        this.log('debug: continue failed, stepi then continue')
        try {
          await this.mi.exec('stepi', this.threadId)
        } catch (stepErr) {
          this.log('debug: stepi also failed: ' + String(stepErr))
        }
        return await this.mi.exec('continue', this.threadId)
      }
    }

    const start = await this.currentLine()
    if (kind === 'step') {
      return await this.execStepInto(start)
    }

    let info: StoppedInfo
    try {
      info = await this.mi.exec(kind, this.threadId)
    } catch (e) {
      if (!isBoundsError(e)) {
        throw e
      }
      this.log('debug: source step failed, falling back')
      info = await this.advancePastLine(start)
    }
    return await this.returnToUserCode(start, kind, info)
  }

  private async onSource(message: DapMessage): Promise<void> {
    const args = (message.arguments ?? {}) as {
      source?: { path?: string; name?: string }
      sourceReference?: number
    }
    const rawPath = String(args.source?.path ?? '')
    const guest = rawPath.length > 0 ? toGuestPath(rawPath) : null
    let content = ''
    if (guest != null) {
      const doc = this.api.workspace.textDocuments.find((d) => toGuestPath(d.uri.fsPath) === guest)
      if (doc != null) {
        content = doc.getText()
      } else {
        try {
          const r = await guestRpc({ op: 'read', path: guest })
          if (r.ok && r.content != null) {
            content = r.content
          }
        } catch (e) {
          this.log('debug source read failed: ' + String(e))
        }
      }
    }
    if (content.length === 0) {
      content = '/* source not available */\n'
    }
    const name = args.source?.name ?? guest?.split('/').pop() ?? 'source'
    const mimeType = /\.(c|h)$/i.test(name)
      ? 'text/x-c'
      : /\.(cpp|cc|cxx|hpp)$/i.test(name)
        ? 'text/x-c++src'
        : 'text/plain'
    this.response(message, { content, mimeType })
  }

  private async onEvaluate(message: DapMessage): Promise<void> {
    if (this.mi == null) {
      this.response(message, { result: '', variablesReference: 0 })
      return
    }
    const args = (message.arguments ?? {}) as { expression?: string; context?: string }
    const expr = String(args.expression ?? '').trim()
    if (expr.length === 0) {
      this.response(message, { result: '', variablesReference: 0 })
      return
    }
    await this.selectCurrentFrame()
    try {
      const raw = await this.mi.command(`-data-evaluate-expression ${miQuote(expr)}`)
      const fields = parseMiFields(raw)
      this.response(message, {
        result: fields.value ?? '',
        variablesReference: 0
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const err = /msg="((?:\\.|[^"\\])*)"/.exec(msg)
      const text = err?.[1]?.replace(/\\"/g, '"') ?? msg
      if (args.context === 'repl') {
        this.fail(message, text)
        return
      }
      this.response(message, { result: text, variablesReference: 0 })
    }
  }

  private async onContinue(message: DapMessage): Promise<void> {
    if (this.mi == null) {
      this.response(message, { allThreadsContinued: true })
      return
    }
    this.response(message, { allThreadsContinued: true })
    try {
      const stopped = await this.execStepOrInstruction('continue')
      this.emitStopped(stopped, 'breakpoint')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log('debug continue failed: ' + msg)
      this.event('stopped', {
        reason: 'pause',
        threadId: this.threadId,
        allThreadsStopped: true,
        description: msg
      })
    }
  }

  private async onStep(
    message: DapMessage,
    kind: 'next' | 'step' | 'finish'
  ): Promise<void> {
    if (this.mi == null) {
      this.response(message, {})
      return
    }
    this.response(message, {})
    try {
      const stopped = await this.execStepOrInstruction(kind)
      this.emitStopped(stopped, 'step')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`debug ${kind} failed: ${msg}`)
      this.event('stopped', {
        reason: 'step',
        threadId: this.threadId,
        allThreadsStopped: true,
        description: msg
      })
    }
  }

  private async onDisconnect(message: DapMessage): Promise<void> {
    try {
      if (this.mi != null) {
        await this.mi.command('-gdb-exit')
      }
    } catch {
      /* ignore */
    }
    this.mi?.close()
    this.mi = null
    this.closeInferiorTty()
    this.response(message, {})
  }
}

let registered = false

function isGuestDebugSource(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && toGuestPath(uri.fsPath) != null
}

function registerBreakpointCommands(api: typeof vscode, log: LogFn): void {
  api.commands.registerCommand('ucd.debug.toggleBreakpoint', () => {
    const editor = api.window.activeTextEditor
    if (editor == null) {
      return
    }
    const { document, selection } = editor
    if (!isGuestDebugSource(document.uri)) {
      void api.window.showWarningMessage('Breakpoints only work on /workspace C/C++ files.')
      return
    }
    const line = selection.active.line
    const uri = document.uri
    const existing = api.debug.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof api.SourceBreakpoint &&
        bp.enabled &&
        bp.location.uri.toString() === uri.toString() &&
        bp.location.range.start.line === line
    )
    if (existing.length > 0) {
      api.debug.removeBreakpoints(existing)
      log(`debug: removed breakpoint ${uri.fsPath}:${line + 1}`)
    } else {
      api.debug.addBreakpoints([
        new api.SourceBreakpoint(new api.Location(uri, new api.Position(line, 0)))
      ])
      log(`debug: added breakpoint ${uri.fsPath}:${line + 1}`)
    }
  })
}

export async function registerGuestDebugger(
  api: typeof vscode,
  log: LogFn = console.log
): Promise<void> {
  if (registered) {
    return
  }
  if (!isGuestControlReady()) {
    log('debug: guest not ready')
    return
  }

  let ready = false
  try {
    const r = await guestRpc({ op: 'debug_ready' }, 10_000)
    ready = r.gdb === true
  } catch (e) {
    log('debug: debug_ready query failed: ' + String(e))
    return
  }
  if (!ready) {
    log('debug: gdb is not installed in the guest image')
    return
  }

  registerBreakpointCommands(api, log)

  api.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
    createDebugAdapterDescriptor: () =>
      new api.DebugAdapterInlineImplementation(new UcdGdbDebugAdapter(api, log))
  })

  api.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
    resolveDebugConfiguration: (_folder, config) => {
      if (config == null) {
        return {
          type: DEBUG_TYPE,
          request: 'launch',
          name: 'Debug C in Alpine',
          program: '${file}',
          stopOnEntry: false
        }
      }
      if (config.type == null) {
        config.type = DEBUG_TYPE
      }
      if (config.request == null) {
        config.request = 'launch'
      }
      if (config.program == null) {
        config.program = '${file}'
      }
      if (config.stopOnEntry == null) {
        config.stopOnEntry = false
      }
      return config
    }
  })

  registered = true
  log(`debug: registered ${DEBUG_TYPE} (guest port ${DEBUG_PORT})`)
}
