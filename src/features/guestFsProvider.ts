/**
 * Live Workbench filesystem backed by guest paths via guestRpc.
 *   file:///workspace/...  ↔  /root/workspace/...
 *   file:///root/...       ↔  /root/...
 *   file:///tmp/...        ↔  /tmp/...
 */
import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerFileSystemOverlay,
  type IFileChange
} from '@codingame/monaco-vscode-files-service-override'
import { Emitter, type Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  GUEST_WORK,
  guestPathToVscode,
  guestRpc,
  isGuestControlReady,
  isGuestFsVscodePath,
  onGuestControlReady,
  vscodePathToGuest
} from './guestBridge'
import { scheduleGuestWorkspacePersist } from './guestFsPersist'

function toGuest(resource: URI): string {
  const g = vscodePathToGuest(resource.path)
  if (g == null) {
    throw FileSystemProviderError.create(
      'Not a guest path: ' + resource.path,
      FileSystemProviderErrorCode.FileNotFound
    )
  }
  return g
}

export class GuestWorkspaceFileSystemProvider {
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive

  private readonly _onDidChangeCapabilities = new Emitter<void>()
  readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event

  private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event

  private pollTimer: number | null = null
  private lastFingerprint = ''
  /** Guest abs path currently shown as explorer root (for poll). */
  private watchGuestPath = GUEST_WORK

  constructor() {
    onGuestControlReady((ready) => {
      if (ready) {
        this.fireRootRefresh()
        this.startPolling()
      } else {
        this.stopPolling()
      }
    })
  }

  setWatchGuestPath(guestAbs: string): void {
    this.watchGuestPath = guestAbs || GUEST_WORK
    this.lastFingerprint = ''
    this.fireRootRefresh()
  }

  private vscodeUriForGuest(guestAbs: string): URI {
    return URI.file(guestPathToVscode(guestAbs))
  }

  private fireRootRefresh(): void {
    this._onDidChangeFile.fire([
      { type: FileChangeType.UPDATED, resource: this.vscodeUriForGuest(this.watchGuestPath) },
      { type: FileChangeType.UPDATED, resource: URI.file('/workspace') },
      { type: FileChangeType.UPDATED, resource: URI.file('/root') }
    ])
  }

  /** Force explorer to re-query guest (e.g. after terminal mkdir). */
  notifyChanged(guestOrRel = '.'): void {
    const guest =
      guestOrRel === '.' || guestOrRel === ''
        ? this.watchGuestPath
        : guestOrRel.startsWith('/')
          ? guestOrRel
          : GUEST_WORK + '/' + guestOrRel.replace(/^\/+/, '')
    this._onDidChangeFile.fire([
      { type: FileChangeType.UPDATED, resource: this.vscodeUriForGuest(guest) }
    ])
    this.fireRootRefresh()
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
      void this.pollOnce()
    }, 2500)
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollOnce(): Promise<void> {
    if (!isGuestControlReady()) {
      return
    }
    try {
      const fp = await this.fingerprint(this.watchGuestPath)
      if (fp !== this.lastFingerprint) {
        this.lastFingerprint = fp
        this.fireRootRefresh()
      }
    } catch {
      /* ignore poll errors */
    }
  }

  private async fingerprint(guestAbs: string): Promise<string> {
    const r = await guestRpc({ op: 'list', path: guestAbs }, 10000)
    if (!r.ok || r.entries == null) {
      return ''
    }
    return r.entries
      .map((e) => e.type + ':' + e.name)
      .sort()
      .join('|')
  }

  watch(): { dispose: () => void } {
    return { dispose: () => undefined }
  }

  async stat(resource: URI): Promise<{
    type: FileType
    ctime: number
    mtime: number
    size: number
  }> {
    if (resource.scheme !== 'file' || !isGuestFsVscodePath(resource.path)) {
      throw FileSystemProviderError.create(
        'File not found',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    if (!isGuestControlReady()) {
      const g = vscodePathToGuest(resource.path)
      if (g === '/root' || g === GUEST_WORK || g === '/workspace' || g === '/') {
        return { type: FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 }
      }
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({ op: 'stat', path: toGuest(resource) })
    if (!r.ok) {
      throw FileSystemProviderError.create(
        r.stderr || 'stat failed',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    return {
      type: r.type === 'dir' ? FileType.Directory : FileType.File,
      ctime: typeof r.ctime === 'number' ? r.ctime : 0,
      mtime: typeof r.mtime === 'number' ? r.mtime : Date.now(),
      size: typeof r.size === 'number' ? r.size : 0
    }
  }

  async readdir(resource: URI): Promise<Array<[string, FileType]>> {
    if (resource.scheme !== 'file' || !isGuestFsVscodePath(resource.path)) {
      throw FileSystemProviderError.create(
        'File not found',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    if (!isGuestControlReady()) {
      return []
    }
    const r = await guestRpc({ op: 'list', path: toGuest(resource) })
    if (!r.ok || r.entries == null) {
      throw FileSystemProviderError.create(
        r.stderr || 'list failed',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    return r.entries.map((e) => [
      e.name,
      e.type === 'dir' ? FileType.Directory : FileType.File
    ])
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    if (!isGuestControlReady()) {
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({ op: 'read', path: toGuest(resource) })
    if (!r.ok || r.content == null) {
      throw FileSystemProviderError.create(
        r.stderr || 'read failed',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    return new TextEncoder().encode(r.content)
  }

  async writeFile(
    resource: URI,
    content: Uint8Array,
    _opts: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    if (!isGuestControlReady()) {
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({
      op: 'write',
      path: toGuest(resource),
      content: new TextDecoder().decode(content)
    })
    if (!r.ok) {
      throw FileSystemProviderError.create(
        r.stderr || 'write failed',
        FileSystemProviderErrorCode.Unknown
      )
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.UPDATED, resource }])
    scheduleGuestWorkspacePersist()
  }

  async mkdir(resource: URI): Promise<void> {
    if (!isGuestControlReady()) {
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({ op: 'mkdir', path: toGuest(resource) })
    if (!r.ok) {
      throw FileSystemProviderError.create(
        r.stderr || 'mkdir failed',
        FileSystemProviderErrorCode.Unknown
      )
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }])
    scheduleGuestWorkspacePersist()
  }

  async delete(resource: URI, opts: { recursive: boolean }): Promise<void> {
    if (!isGuestControlReady()) {
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({
      op: 'unlink',
      path: toGuest(resource),
      recursive: !!opts.recursive
    })
    if (!r.ok) {
      throw FileSystemProviderError.create(
        r.stderr || 'delete failed',
        FileSystemProviderErrorCode.FileNotFound
      )
    }
    this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }])
    scheduleGuestWorkspacePersist()
  }

  async rename(from: URI, to: URI, _opts: { overwrite: boolean }): Promise<void> {
    if (!isGuestControlReady()) {
      throw FileSystemProviderError.create(
        'Guest not ready',
        FileSystemProviderErrorCode.Unavailable
      )
    }
    const r = await guestRpc({
      op: 'rename',
      from: toGuest(from),
      to: toGuest(to)
    })
    if (!r.ok) {
      throw FileSystemProviderError.create(
        r.stderr || 'rename failed',
        FileSystemProviderErrorCode.Unknown
      )
    }
    this._onDidChangeFile.fire([
      { type: FileChangeType.DELETED, resource: from },
      { type: FileChangeType.ADDED, resource: to }
    ])
    scheduleGuestWorkspacePersist()
  }
}

let guestFs: GuestWorkspaceFileSystemProvider | null = null

export function getGuestFs(): GuestWorkspaceFileSystemProvider | null {
  return guestFs
}

/** Register high-priority overlay so explorer reads/writes guest live. */
export function registerGuestWorkspaceFs(): GuestWorkspaceFileSystemProvider {
  if (guestFs != null) {
    return guestFs
  }
  guestFs = new GuestWorkspaceFileSystemProvider()
  registerFileSystemOverlay(100, guestFs as never)
  ;(globalThis as unknown as { __ucdGuestFs?: GuestWorkspaceFileSystemProvider }).__ucdGuestFs =
    guestFs
  return guestFs
}
