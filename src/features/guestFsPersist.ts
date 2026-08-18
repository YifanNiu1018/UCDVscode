/**
 * Persist Alpine /root/workspace like a VMware disk, not IndexedDB.
 *
 *   alpine-vfs.js          = read-only base image (Alpine 9p)
 *   guest-disk/workspace.* = writable overlay next to ucdvsc.html
 *
 * file:// can <script src> sibling JS, but cannot overwrite files without
 * File System Access. Bind the ucdVscode folder once; we write guest-disk/.
 */
import { GUEST_WORK, guestRpc, isGuestControlReady } from './guestBridge'

const HANDLE_DB = 'ucd-guest-disk'
const HANDLE_STORE = 'handles'
const HANDLE_KEY = 'dir'
const HANDLE_DB_VERSION = 1
const MAX_FILE_BYTES = 512 * 1024
const SKIP_NAME = /^(a\.out|main)$|\.(o|a|so|bin|out)$/i
const DISK_DIR_NAME = 'guest-disk'
const OVERLAY_JSON = 'workspace.json'
const OVERLAY_JS = 'workspace.js'
const VM_STATE_BIN = 'v86state.bin'
const VM_STATE_META = 'v86state.json'

type StoredDir = { path: string; type: 'dir' }
type StoredFile = { path: string; type: 'file'; content: string }
export type StoredEntry = StoredDir | StoredFile

export type Snapshot = {
  version: 1
  savedAt: number
  entries: StoredEntry[]
}

declare global {
  interface Window {
    __UCD_GUEST_DISK__?: Snapshot | null
  }
}

type DirPickerWindow = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string
  }) => Promise<FileSystemDirectoryHandle>
}

type FsHandleWithPerm = FileSystemDirectoryHandle & {
  queryPermission?: (opts?: { mode?: string }) => Promise<PermissionState>
  requestPermission?: (opts?: { mode?: string }) => Promise<PermissionState>
}

let persistStarted = false
let saving = false
let debounceTimer: number | null = null
let lastFingerprint = ''
let diskDir: FileSystemDirectoryHandle | null = null
let bindPrompted = false
let onNeedBind: (() => void) | null = null
let vmSaveFn: (() => Promise<ArrayBuffer>) | null = null
let vmSaving = false
let vmPersistStarted = false

export type GuestDiskSaveInfo = {
  savedAt: number
  byteLength?: number
  source: 'vm' | 'workspace'
}

let lastSaveInfo: GuestDiskSaveInfo | null = null
const saveListeners = new Set<(info: GuestDiskSaveInfo) => void>()

function noteGuestDiskSaved(info: GuestDiskSaveInfo): void {
  lastSaveInfo = info
  for (const l of saveListeners) {
    try {
      l(info)
    } catch {
      /* ignore */
    }
  }
}

export function getLastGuestDiskSave(): GuestDiskSaveInfo | null {
  return lastSaveInfo
}

export function onGuestDiskSaved(listener: (info: GuestDiskSaveInfo) => void): () => void {
  saveListeners.add(listener)
  if (lastSaveInfo != null) {
    listener(lastSaveInfo)
  }
  return () => {
    saveListeners.delete(listener)
  }
}

/** Read last save time from guest-disk meta (no user gesture). */
export async function loadLastGuestDiskSaveMeta(): Promise<GuestDiskSaveInfo | null> {
  const dir = await ensureDiskDir({ prompt: false })
  if (dir != null) {
    const text = await readTextFile(dir, VM_STATE_META)
    if (text != null) {
      try {
        const meta = JSON.parse(text) as { savedAt?: number; byteLength?: number }
        if (typeof meta.savedAt === 'number') {
          const info: GuestDiskSaveInfo = {
            savedAt: meta.savedAt,
            byteLength: typeof meta.byteLength === 'number' ? meta.byteLength : undefined,
            source: 'vm'
          }
          noteGuestDiskSaved(info)
          return info
        }
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const r = await fetch(new URL('./guest-disk/' + VM_STATE_META, document.baseURI).href)
    if (r.ok) {
      const meta = (await r.json()) as { savedAt?: number; byteLength?: number }
      if (typeof meta.savedAt === 'number') {
        const info: GuestDiskSaveInfo = {
          savedAt: meta.savedAt,
          byteLength: typeof meta.byteLength === 'number' ? meta.byteLength : undefined,
          source: 'vm'
        }
        noteGuestDiskSaved(info)
        return info
      }
    }
  } catch {
    /* file:// */
  }
  const overlay = parseSnapshot(window.__UCD_GUEST_DISK__)
  if (overlay != null && typeof overlay.savedAt === 'number') {
    const info: GuestDiskSaveInfo = { savedAt: overlay.savedAt, source: 'workspace' }
    noteGuestDiskSaved(info)
    return info
  }
  return lastSaveInfo
}

export function setGuestDiskBindPrompt(fn: () => void): void {
  onNeedBind = fn
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, HANDLE_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
}

async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY)
  })
  db.close()
}

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const db = await openHandleDb()
    const row = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly')
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY)
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined)
      req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'))
    })
    db.close()
    return row
  } catch {
    return undefined
  }
}

async function clearDirHandle(): Promise<void> {
  try {
    const db = await openHandleDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'))
      tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY)
    })
    db.close()
  } catch {
    /* ignore */
  }
}

/** Drop the old IndexedDB snapshot (file contents). Overlay now lives on disk. */
function dropLegacyIdbSnapshot(): void {
  try {
    indexedDB.deleteDatabase('ucd-guest-fs')
  } catch {
    /* ignore */
  }
}

async function permissionState(
  handle: FsHandleWithPerm,
  mode: 'read' | 'readwrite'
): Promise<PermissionState> {
  if (typeof handle.queryPermission !== 'function') {
    return 'granted'
  }
  try {
    return await handle.queryPermission({ mode })
  } catch {
    return 'prompt'
  }
}

/** `request` must only be true inside a user click (FSA activation). */
async function ensurePermission(
  handle: FsHandleWithPerm,
  mode: 'read' | 'readwrite',
  request: boolean
): Promise<boolean> {
  if ((await permissionState(handle, mode)) === 'granted') {
    return true
  }
  if (!request || typeof handle.requestPermission !== 'function') {
    return false
  }
  try {
    return (await handle.requestPermission({ mode })) === 'granted'
  } catch {
    // e.g. "User activation is required to request permissions"
    return false
  }
}

async function writeBinaryFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(data)
  await w.close()
}

async function readBinaryFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<ArrayBuffer | undefined> {
  try {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    if (file.size < 64) {
      return undefined
    }
    return await file.arrayBuffer()
  } catch {
    return undefined
  }
}

async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch {
    /* ignore */
  }
}

async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(text)
  await w.close()
}

async function readTextFile(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<string | undefined> {
  try {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    return await file.text()
  } catch {
    return undefined
  }
}

function parseSnapshot(raw: unknown): Snapshot | undefined {
  if (raw == null || typeof raw !== 'object') {
    return undefined
  }
  const s = raw as Snapshot
  if (s.version !== 1 || !Array.isArray(s.entries)) {
    return undefined
  }
  return s
}

async function readSnapshotFromDir(
  dir: FileSystemDirectoryHandle
): Promise<Snapshot | undefined> {
  const json = await readTextFile(dir, OVERLAY_JSON)
  if (json != null && json.trim() !== '' && json.trim() !== 'null') {
    try {
      return parseSnapshot(JSON.parse(json))
    } catch {
      /* fall through */
    }
  }
  const js = await readTextFile(dir, OVERLAY_JS)
  if (js == null) {
    return undefined
  }
  const m = js.match(/window\.__UCD_GUEST_DISK__\s*=\s*([\s\S]*?);?\s*$/)
  if (m == null || m[1] == null || m[1].trim() === 'null') {
    return undefined
  }
  try {
    return parseSnapshot(JSON.parse(m[1]))
  } catch {
    return undefined
  }
}

async function writeSnapshotToDir(
  dir: FileSystemDirectoryHandle,
  snap: Snapshot
): Promise<void> {
  const json = JSON.stringify(snap)
  await writeTextFile(dir, OVERLAY_JSON, json + '\n')
  await writeTextFile(dir, OVERLAY_JS, 'window.__UCD_GUEST_DISK__=' + json + ';\n')
  window.__UCD_GUEST_DISK__ = snap
}

async function resolveGuestDiskDir(
  picked: FileSystemDirectoryHandle
): Promise<FileSystemDirectoryHandle> {
  if (picked.name === DISK_DIR_NAME) {
    return picked
  }
  return await picked.getDirectoryHandle(DISK_DIR_NAME, { create: true })
}

/** User picks ucdVscode (or guest-disk). Overlay is written as real files. */
export async function bindGuestDiskFolder(): Promise<boolean> {
  const w = window as DirPickerWindow
  if (typeof w.showDirectoryPicker !== 'function') {
    throw new Error(
      'This browser has no File System Access API (use Chrome/Edge). Cannot write the disk image.'
    )
  }
  const picked = await w.showDirectoryPicker({
    id: 'ucd-guest-disk',
    mode: 'readwrite',
    startIn: 'downloads'
  })
  const dir = await resolveGuestDiskDir(picked)
  if (!(await ensurePermission(dir as FsHandleWithPerm, 'readwrite', true))) {
    throw new Error('Write permission for guest-disk was not granted')
  }
  diskDir = dir
  await saveDirHandle(dir)
  return true
}

export async function hasStoredGuestDiskHandle(): Promise<boolean> {
  if (diskDir != null) {
    return true
  }
  return (await loadDirHandle()) != null
}

/** True if we have a remembered folder but Chrome still needs a click to use it. */
export async function guestDiskNeedsAuthorization(): Promise<boolean> {
  const handle = diskDir ?? (await loadDirHandle())
  if (handle == null) {
    return false
  }
  return (await permissionState(handle as FsHandleWithPerm, 'readwrite')) !== 'granted'
}

/** Call from a click handler, then reload to restore the VM snapshot. */
export async function authorizeStoredGuestDisk(): Promise<boolean> {
  const handle = diskDir ?? (await loadDirHandle())
  if (handle == null) {
    return false
  }
  const ok = await ensurePermission(handle as FsHandleWithPerm, 'readwrite', true)
  if (ok) {
    diskDir = handle
  }
  return ok
}

async function ensureDiskDir(opts: { prompt: boolean }): Promise<FileSystemDirectoryHandle | null> {
  if (diskDir != null) {
    if (await ensurePermission(diskDir as FsHandleWithPerm, 'readwrite', false)) {
      return diskDir
    }
    diskDir = null
  }
  const saved = await loadDirHandle()
  if (saved != null && (await ensurePermission(saved as FsHandleWithPerm, 'readwrite', false))) {
    diskDir = saved
    return diskDir
  }
  if (!opts.prompt) {
    return null
  }
  const ok = await bindGuestDiskFolder()
  return ok ? diskDir : null
}

async function loadSnapshot(): Promise<Snapshot | undefined> {
  const fromScript = parseSnapshot(window.__UCD_GUEST_DISK__)
  if (fromScript != null) {
    return fromScript
  }
  const saved = await loadDirHandle()
  if (saved != null) {
    const perm = await (saved as FsHandleWithPerm).queryPermission?.({ mode: 'readwrite' })
    if (perm === 'granted') {
      diskDir = saved
      const fromFsa = await readSnapshotFromDir(saved)
      if (fromFsa != null) {
        window.__UCD_GUEST_DISK__ = fromFsa
        return fromFsa
      }
    }
  }
  try {
    const r = await fetch(new URL('./guest-disk/workspace.json', document.baseURI).href)
    if (r.ok) {
      const fromFetch = parseSnapshot(await r.json())
      if (fromFetch != null) {
        return fromFetch
      }
    }
  } catch {
    /* file:// CORS — script tag is the read path */
  }
  return undefined
}

export async function clearGuestWorkspacePersist(): Promise<void> {
  lastFingerprint = ''
  window.__UCD_GUEST_DISK__ = null
  const empty: Snapshot = { version: 1, savedAt: Date.now(), entries: [] }
  try {
    const dir = await ensureDiskDir({ prompt: false })
    if (dir != null) {
      await writeSnapshotToDir(dir, empty)
      await removeFile(dir, VM_STATE_BIN)
      await removeFile(dir, VM_STATE_META)
      return
    }
  } catch {
    /* ignore */
  }
  await clearDirHandle()
  diskDir = null
}

/** Load full v86 save_state buffer from guest-disk/v86state.bin. */
export async function loadVmStateBuffer(): Promise<ArrayBuffer | undefined> {
  const dir = await ensureDiskDir({ prompt: false })
  if (dir != null) {
    const fromFsa = await readBinaryFile(dir, VM_STATE_BIN)
    if (fromFsa != null) {
      return fromFsa
    }
  }
  try {
    const r = await fetch(new URL('./guest-disk/' + VM_STATE_BIN, document.baseURI).href)
    if (r.ok) {
      const buf = await r.arrayBuffer()
      if (buf.byteLength > 64) {
        return buf
      }
    }
  } catch {
    /* file:// CORS */
  }
  return undefined
}

export async function saveVmStateNow(): Promise<number> {
  if (vmSaveFn == null || vmSaving) {
    return 0
  }
  const dir = await ensureDiskDir({ prompt: false })
  if (dir == null) {
    if (!bindPrompted && !(await hasStoredGuestDiskHandle())) {
      bindPrompted = true
      onNeedBind?.()
    }
    return 0
  }
  vmSaving = true
  try {
    const buf = await vmSaveFn()
    const savedAt = Date.now()
    await writeBinaryFile(dir, VM_STATE_BIN, buf)
    await writeTextFile(
      dir,
      VM_STATE_META,
      JSON.stringify({
        version: 1,
        savedAt,
        byteLength: buf.byteLength
      }) + '\n'
    )
    noteGuestDiskSaved({ savedAt, byteLength: buf.byteLength, source: 'vm' })
    return buf.byteLength
  } finally {
    vmSaving = false
  }
}

/** Periodic + tab-hide full VM snapshot (RAM + 9p + processes). */
export function startGuestVmStatePersist(saveFn: () => Promise<ArrayBuffer>): void {
  vmSaveFn = saveFn
  if (vmPersistStarted) {
    return
  }
  vmPersistStarted = true
  const flush = (): void => {
    void saveVmStateNow().catch((e) => {
      console.warn('[ucd] save VM state failed', e)
    })
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  })
  window.setInterval(flush, 45000)
}

function absPath(parent: string, entry: { name: string; path?: string }): string {
  if (entry.path != null && entry.path.startsWith('/')) {
    return entry.path.replace(/\/+$/, '') || '/'
  }
  const base = parent === '/' ? '' : parent.replace(/\/+$/, '')
  return `${base}/${entry.name}`
}

function shouldSkipFile(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return SKIP_NAME.test(base)
}

async function walkWorkspace(
  guestAbs: string,
  out: StoredEntry[],
  ignoreReady: boolean
): Promise<void> {
  const r = await guestRpc({ op: 'list', path: guestAbs }, 20000, ignoreReady)
  if (!r.ok || r.entries == null) {
    return
  }
  for (const e of r.entries) {
    const p = absPath(guestAbs, e)
    if (e.type === 'dir') {
      out.push({ path: p, type: 'dir' })
      await walkWorkspace(p, out, ignoreReady)
      continue
    }
    if (shouldSkipFile(p)) {
      continue
    }
    const st = await guestRpc({ op: 'stat', path: p }, 10000, ignoreReady)
    if (st.ok && typeof st.size === 'number' && st.size > MAX_FILE_BYTES) {
      continue
    }
    const read = await guestRpc({ op: 'read', path: p }, 30000, ignoreReady)
    if (!read.ok || read.content == null || read.content.includes('\0')) {
      continue
    }
    out.push({ path: p, type: 'file', content: read.content })
  }
}

async function snapshotFromGuest(ignoreReady = false): Promise<StoredEntry[]> {
  const out: StoredEntry[] = []
  await walkWorkspace(GUEST_WORK, out, ignoreReady)
  return out
}

async function fingerprintWorkspace(ignoreReady = false): Promise<string> {
  const r = await guestRpc(
    {
      op: 'exec',
      cmd:
        "find /root/workspace \\( -type f -o -type d \\) -exec stat -c '%F %s %Y %n' {} + 2>/dev/null | sort",
      timeoutMs: 15000
    },
    20000,
    ignoreReady
  )
  if (r.ok && (r.stdout ?? '').trim() !== '') {
    return r.stdout!.trim()
  }
  const r2 = await guestRpc({ op: 'list', path: GUEST_WORK }, 10000, ignoreReady)
  if (!r2.ok || r2.entries == null) {
    return ''
  }
  return r2.entries
    .map((e) => `${e.type}:${e.name}`)
    .sort()
    .join('|')
}

function sortForRestore(entries: StoredEntry[]): StoredEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1
    }
    const da = a.path.split('/').length
    const db = b.path.split('/').length
    return da - db || a.path.localeCompare(b.path)
  })
}

/** Apply guest-disk overlay after agent listens, before explorer. */
export async function restoreGuestWorkspace(): Promise<number> {
  dropLegacyIdbSnapshot()
  const snap = await loadSnapshot()
  if (snap == null) {
    return 0
  }

  const wipe = await guestRpc(
    {
      op: 'exec',
      cmd: 'rm -rf /root/workspace && mkdir -p /root/workspace',
      timeoutMs: 20000
    },
    25000,
    true
  )
  if (!wipe.ok) {
    throw new Error(wipe.stderr || 'failed to reset /root/workspace before restore')
  }

  let n = 0
  for (const e of sortForRestore(snap.entries)) {
    if (!e.path.startsWith(GUEST_WORK + '/') && e.path !== GUEST_WORK) {
      continue
    }
    if (e.type === 'dir') {
      await guestRpc({ op: 'mkdir', path: e.path }, 15000, true)
      continue
    }
    const w = await guestRpc(
      { op: 'write', path: e.path, content: e.content },
      30000,
      true
    )
    if (w.ok) {
      n++
    }
  }
  try {
    lastFingerprint = await fingerprintWorkspace(true)
  } catch {
    lastFingerprint = ''
  }
  return n
}

export async function persistGuestWorkspaceNow(): Promise<number> {
  if (!isGuestControlReady() || saving) {
    return 0
  }
  saving = true
  try {
    const entries = await snapshotFromGuest()
    const snap: Snapshot = { version: 1, savedAt: Date.now(), entries }
    const dir = await ensureDiskDir({ prompt: false })
    if (dir == null) {
      if (!bindPrompted && !(await hasStoredGuestDiskHandle())) {
        bindPrompted = true
        onNeedBind?.()
      }
      return 0
    }
    await writeSnapshotToDir(dir, snap)
    noteGuestDiskSaved({ savedAt: snap.savedAt, source: 'workspace' })
    try {
      lastFingerprint = await fingerprintWorkspace()
    } catch {
      /* ignore */
    }
    return entries.filter((e) => e.type === 'file').length
  } finally {
    saving = false
  }
}

/** After binding a folder, flush workspace overlay + full VM snapshot. */
export async function persistGuestWorkspaceAfterBind(): Promise<{
  files: number
  stateBytes: number
}> {
  const files = isGuestControlReady() ? await persistGuestWorkspaceNow() : 0
  const stateBytes = await saveVmStateNow()
  return { files, stateBytes }
}

export function scheduleGuestWorkspacePersist(delayMs = 1200): void {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer)
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    void persistGuestWorkspaceNow().catch((e) => {
      console.warn('[ucd] persist workspace failed', e)
    })
  }, delayMs)
}

export function startGuestWorkspacePersist(): void {
  if (persistStarted) {
    return
  }
  persistStarted = true
  dropLegacyIdbSnapshot()
  window.addEventListener('pagehide', () => {
    void persistGuestWorkspaceNow().catch(() => undefined)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void persistGuestWorkspaceNow().catch(() => undefined)
    }
  })
  window.setInterval(() => {
    if (!isGuestControlReady()) {
      return
    }
    void (async () => {
      try {
        const fp = await fingerprintWorkspace()
        if (fp !== lastFingerprint) {
          lastFingerprint = fp
          await persistGuestWorkspaceNow()
        }
      } catch {
        /* ignore */
      }
    })()
  }, 8000)
}
