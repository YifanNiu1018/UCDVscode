/**
 * Guest language servers over the agent's :1236 port, registered through the
 * *calling extension's* vscode API (not the global vscode proxy that
 * vscode-languageclient uses internally — that proxy never wired providers
 * into the workbench here).
 */
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter
} from 'vscode-jsonrpc/browser'
import {
  createMessageConnection
} from 'vscode-jsonrpc/browser'

type MessageTransports = { reader: MessageReader; writer: MessageWriter }
import {
  CompletionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  type CompletionItem,
  type CompletionList,
  type Hover,
  type InitializeParams
} from 'vscode-languageserver-protocol/browser'
import type * as vscode from 'vscode'
import {
  GUEST_WORK,
  VSCODE_WORK_ALIAS,
  concatU8,
  connectGuestLsp,
  encodeLspHandshake,
  guestRpc,
  vscodePathToGuest,
  type TcpConn
} from './guestBridge'

interface ServerSpec {
  readonly id: string
  readonly label: string
  readonly languages: readonly string[]
}

const SERVERS: readonly ServerSpec[] = [
  { id: 'clangd', label: 'clangd', languages: ['c', 'cpp'] },
  { id: 'pyright', label: 'Pyright', languages: ['python'] },
  {
    id: 'typescript',
    label: 'TypeScript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']
  },
  { id: 'bash', label: 'Bash', languages: ['shellscript'] }
]

const HEADER_SEP = '\r\n\r\n'
const INIT_TIMEOUT_MS = 120_000

type LogFn = (msg: string) => void

function indexOfHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i
    }
  }
  return -1
}

class ConnMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | undefined
  private buffer: Uint8Array = new Uint8Array(0)

  listen(callback: DataCallback): Disposable {
    this.callback = callback
    this.drain()
    return { dispose: () => { this.callback = undefined } }
  }

  append(chunk: Uint8Array): void {
    this.buffer = concatU8(this.buffer, chunk)
    this.drain()
  }

  private drain(): void {
    if (this.callback == null) {
      return
    }
    for (;;) {
      const sep = indexOfHeaderEnd(this.buffer)
      if (sep < 0) {
        return
      }
      const header = new TextDecoder('ascii').decode(this.buffer.subarray(0, sep))
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (match == null) {
        this.fireError(new Error('LSP header without Content-Length'))
        this.buffer = this.buffer.subarray(sep + 4)
        continue
      }
      const len = Number(match[1])
      if (this.buffer.length < sep + 4 + len) {
        return
      }
      const body = new TextDecoder().decode(this.buffer.subarray(sep + 4, sep + 4 + len))
      this.buffer = this.buffer.subarray(sep + 4 + len)
      try {
        this.callback(JSON.parse(body) as Message)
      } catch (e) {
        this.fireError(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  signalClose(): void {
    this.fireClose()
  }

  signalError(e: Error): void {
    this.fireError(e)
  }
}

class ConnMessageWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly conn: TcpConn) {
    super()
  }

  async write(msg: Message): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(msg))
    const header = new TextEncoder().encode(`Content-Length: ${body.length}${HEADER_SEP}`)
    this.conn.write(concatU8(header, body))
  }

  end(): void {
    /* nothing buffered */
  }
}

function openTransport(serverId: string, timeoutMs = 30_000): Promise<MessageTransports> {
  return new Promise((resolve, reject) => {
    const conn = connectGuestLsp()
    const reader = new ConnMessageReader()
    let acked = false
    let settled = false
    let rx: Uint8Array = new Uint8Array(0)

    const fail = (e: Error): void => {
      if (settled) {
        if (acked) {
          reader.signalError(e)
        }
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
      () => fail(new Error(`guest LSP ${serverId}: handshake timeout`)),
      timeoutMs
    )

    conn.on('connect', () => {
      try {
        conn.write(encodeLspHandshake(serverId, GUEST_WORK))
      } catch (e) {
        window.clearTimeout(timer)
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })

    conn.on('data', (data: unknown) => {
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      if (acked) {
        reader.append(chunk)
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
      rx = new Uint8Array(0)
      window.clearTimeout(timer)

      let ack: { ok?: boolean; stderr?: string }
      try {
        ack = JSON.parse(payload) as { ok?: boolean; stderr?: string }
      } catch (e) {
        fail(new Error(`guest LSP ${serverId}: bad ack: ${String(e)}`))
        return
      }
      if (ack.ok !== true) {
        fail(new Error(`guest LSP ${serverId}: ${ack.stderr ?? 'refused'}`))
        return
      }

      acked = true
      settled = true
      resolve({ reader, writer: new ConnMessageWriter(conn) })
      if (rest.length > 0) {
        reader.append(rest)
      }
    })

    const onGone = (why: string) => () => {
      window.clearTimeout(timer)
      if (acked) {
        reader.signalClose()
      } else {
        fail(new Error(`guest LSP ${serverId}: ${why}`))
      }
    }
    conn.on('close', onGone('closed before ack'))
    conn.on('shutdown', onGone('shutdown before ack'))
  })
}

/** Workbench file:///workspace/… → guest file:///root/workspace/… for LSP. */
function toProtocolUri(uri: vscode.Uri): string {
  const guest = vscodePathToGuest(uri.path)
  return guest == null ? uri.toString() : uri.with({ path: guest }).toString()
}

function completionItems(
  api: typeof vscode,
  raw: CompletionItem[] | CompletionList | null | undefined
): vscode.CompletionItem[] {
  if (raw == null) {
    return []
  }
  const list = Array.isArray(raw) ? raw : (raw.items ?? [])
  return list.map((item) => {
    const label =
      typeof item.label === 'string'
        ? item.label
        : typeof item.label === 'object' && item.label != null
          ? String((item.label as { label: string }).label)
          : String(item.label)
    const out = new api.CompletionItem(label)
    if (item.kind != null) {
      out.kind = item.kind as vscode.CompletionItemKind
    }
    if (item.detail != null) {
      out.detail = item.detail
    }
    if (item.documentation != null) {
      const doc = item.documentation
      out.documentation =
        typeof doc === 'string'
          ? doc
          : typeof doc === 'object' && 'value' in doc
            ? String((doc as { value: string }).value)
            : String(doc)
    }
    if (item.insertText != null) {
      const insert = item.insertText
      out.insertText =
        typeof insert === 'string'
          ? insert
          : typeof insert === 'object' && 'value' in insert
            ? String((insert as { value: string }).value)
            : String(insert)
    }
    if (item.filterText != null) {
      out.filterText = item.filterText
    }
    return out
  })
}

class GuestLspSession {
  private disposables: vscode.Disposable[] = []
  private synced = new Set<string>()

  constructor(
    private readonly spec: ServerSpec,
    private readonly log: LogFn
  ) {}

  async start(api: typeof vscode): Promise<void> {
    this.log(`LSP: connecting ${this.spec.label}…`)
    const transport = await openTransport(this.spec.id)
    const conn = createMessageConnection(transport.reader, transport.writer)
    conn.onError(([err]) => {
      this.log(`LSP ${this.spec.label} error: ${err.message}`)
    })
    conn.onClose(() => {
      this.log(`LSP ${this.spec.label} connection closed`)
    })
    conn.listen()

    const rootUri = toProtocolUri(api.Uri.file(VSCODE_WORK_ALIAS))
    const initParams: InitializeParams = {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          completion: {
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext']
            }
          },
          hover: { contentFormat: ['markdown', 'plaintext'] }
        }
      },
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }]
    }

    await Promise.race([
      conn.sendRequest(InitializeRequest.type, initParams),
      new Promise<never>((_, reject) =>
        window.setTimeout(
          () => reject(new Error(`${this.spec.label} initialize timed out`)),
          INIT_TIMEOUT_MS
        )
      )
    ])
    conn.sendNotification(InitializedNotification.type, {})

    const openDoc = (doc: vscode.TextDocument): void => {
      if (!this.spec.languages.includes(doc.languageId)) {
        return
      }
      const uri = toProtocolUri(doc.uri)
      if (this.synced.has(uri)) {
        return
      }
      this.synced.add(uri)
      conn.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText()
        }
      })
    }

    const changeDoc = (e: vscode.TextDocumentChangeEvent): void => {
      if (!this.spec.languages.includes(e.document.languageId)) {
        return
      }
      const uri = toProtocolUri(e.document.uri)
      if (!this.synced.has(uri)) {
        openDoc(e.document)
      }
      conn.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: e.document.version },
        contentChanges: [{ text: e.document.getText() }]
      })
    }

    const closeDoc = (doc: vscode.TextDocument): void => {
      const uri = toProtocolUri(doc.uri)
      if (!this.synced.has(uri)) {
        return
      }
      this.synced.delete(uri)
      conn.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri }
      })
    }

    for (const doc of api.workspace.textDocuments) {
      openDoc(doc)
    }

    this.disposables.push(
      api.workspace.onDidOpenTextDocument(openDoc),
      api.workspace.onDidChangeTextDocument(changeDoc),
      api.workspace.onDidCloseTextDocument(closeDoc),
      api.languages.registerCompletionItemProvider(
        this.spec.languages.map((language) => ({ language, scheme: 'file' })),
        {
          provideCompletionItems: async (doc, position, token) => {
            openDoc(doc)
            const result = await conn.sendRequest(
              CompletionRequest.type,
              {
                textDocument: { uri: toProtocolUri(doc.uri) },
                position: { line: position.line, character: position.character }
              },
              token
            )
            return completionItems(api, result)
          }
        },
        '.',
        '"',
        "'"
      ),
      api.languages.registerHoverProvider(
        this.spec.languages.map((language) => ({ language, scheme: 'file' })),
        {
          provideHover: async (doc, position, token) => {
            openDoc(doc)
            const result = (await conn.sendRequest(
              HoverRequest.type,
              {
                textDocument: { uri: toProtocolUri(doc.uri) },
                position: { line: position.line, character: position.character }
              },
              token
            )) as Hover | null
            if (result == null) {
              return null
            }
            const contents =
              typeof result.contents === 'string'
                ? result.contents
                : Array.isArray(result.contents)
                  ? result.contents
                      .map((c) => (typeof c === 'string' ? c : c.value))
                      .join('\n')
                  : result.contents.value
            return new api.Hover(contents)
          }
        }
      ),
      { dispose: () => conn.dispose() }
    )

    this.log(`LSP: ${this.spec.label} ready (${this.spec.languages.join(', ')})`)
  }

  async stop(): Promise<void> {
    for (const d of this.disposables) {
      try {
        d.dispose()
      } catch {
        /* ignore */
      }
    }
    this.disposables = []
    this.synced.clear()
  }
}

const sessions = new Map<string, GuestLspSession>()

async function availableServers(): Promise<Record<string, boolean>> {
  try {
    const r = await guestRpc({ op: 'lsp_servers' }, 15_000)
    return r.servers ?? {}
  } catch (e) {
    console.warn('[UCD] lsp_servers query failed:', e)
    return {}
  }
}

/**
 * Spawn a guest language server only when a matching file is open. Starting
 * Pyright (a second Node process) on every boot made the v86 guest crawl even
 * when the user was only editing C.
 */
async function startOnDemand(api: typeof vscode, log: LogFn): Promise<void> {
  const avail = await availableServers()
  const usable = SERVERS.filter((s) => avail[s.id] === true)
  if (usable.length === 0) {
    log('LSP: no language servers installed in the guest image')
    return
  }
  log(
    'LSP: available ' +
      usable.map((s) => s.id).join(', ') +
      ' — start when a matching file is opened'
  )

  const starting = new Set<string>()
  const ensure = async (languageId: string): Promise<void> => {
    for (const spec of usable) {
      if (!spec.languages.includes(languageId)) {
        continue
      }
      if (sessions.has(spec.id) || starting.has(spec.id)) {
        continue
      }
      starting.add(spec.id)
      const session = new GuestLspSession(spec, log)
      sessions.set(spec.id, session)
      try {
        await session.start(api)
      } catch (e) {
        sessions.delete(spec.id)
        const msg = e instanceof Error ? e.message : String(e)
        log(`LSP: ${spec.label} failed — ${msg}`)
        console.warn(`[UCD] language server ${spec.label} failed:`, e)
      } finally {
        starting.delete(spec.id)
      }
    }
  }

  api.workspace.onDidOpenTextDocument((doc) => {
    void ensure(doc.languageId)
  })
  for (const doc of api.workspace.textDocuments) {
    void ensure(doc.languageId)
  }
}

/** Call once guest TCP control is up (from ucd-v86-compile, not ucd-main). */
export function registerGuestLanguageServers(api: typeof vscode, log: LogFn = console.log): void {
  void startOnDemand(api, log)
}

export async function stopGuestLanguageServers(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  await Promise.all(all.map((s) => s.stop()))
}
