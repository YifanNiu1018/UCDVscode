/**
 * Persistence substrate shared by the VM-snapshot and workspace-overlay layers:
 *
 *   - IndexedDB stores (bound-folder handle + full VM state blob/meta)
 *   - File System Access helpers (read/write files in the bound guest-disk/)
 *   - the single bound-directory handle + its bind prompt
 *   - the "disk saved" event bus and the shared vm-dirty flag
 *
 * alpine-vfs.js is the read-only base image; everything writable lives either in
 * IndexedDB (survives reload without a gesture) or the bound guest-disk/ folder.
 */

const HANDLE_DB = 'ucd-guest-disk'
const HANDLE_STORE = 'handles'
const HANDLE_KEY = 'dir'
const HANDLE_DB_VERSION = 1
const DISK_DIR_NAME = 'guest-disk'
const STATE_DB = 'ucd-vm-state'
const STATE_STORE = 'state'
export const STATE_BLOB_KEY = 'v86:blob'
export const STATE_META_KEY = 'v86:meta'
const STATE_DB_VERSION = 1

/**
 * v86 guest RAM / VGA. Must be powers of two. Smaller RAM is the biggest
 * emulator + snapshot win; changing these tags out old IndexedDB snapshots.
 */
export const GUEST_RAM_BYTES = 512 * 1024 * 1024
export const GUEST_VGA_BYTES = 2 * 1024 * 1024
export const GUEST_MACHINE_TAG = `m${GUEST_RAM_BYTES / (1024 * 1024)}-${GUEST_VGA_BYTES / (1024 * 1024)}`

type StoredDir = { path: string; type: 'dir' }
type StoredFile = { path: string; type: 'file'; content: string }
export type StoredEntry = StoredDir | StoredFile

export type Snapshot = {
  version: 1
  savedAt: number
  entries: StoredEntry[]
}

export type GuestDiskSaveInfo = {
  savedAt: number
  byteLength?: number
  source: 'vm' | 'workspace'
  /** alpine-vfs.js __V86_VFS_ID__ at save time; mismatches → cold boot. */
  baseImageId?: string
}

declare global {
  interface Window {
    __UCD_GUEST_DISK__?: Snapshot | null
    /** Set by alpine-vfs.js; must match a saved VM snapshot's baseImageId. */
    __V86_VFS_ID__?: string
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

let diskDir: FileSystemDirectoryHandle | null = null
let bindPrompted = false
let onNeedBind: (() => void) | null = null
let vmDirty = false

// ── shared save-info bus ────────────────────────────────────────────────────

let lastSaveInfo: GuestDiskSaveInfo | null = null
const saveListeners = new Set<(info: GuestDiskSaveInfo) => void>()

export function noteGuestDiskSaved(info: GuestDiskSaveInfo): void {
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

// ── shared vm-dirty flag ────────────────────────────────────────────────────

/** Guest state changed since the last VM snapshot (terminal, edits, compiles). */
export function markGuestVmDirty(): void {
  vmDirty = true
}

export function isGuestVmDirty(): boolean {
  return vmDirty
}

export function clearGuestVmDirty(): void {
  vmDirty = false
}

// ── bind prompt ─────────────────────────────────────────────────────────────

export function setGuestDiskBindPrompt(fn: () => void): void {
  onNeedBind = fn
}

/** Ask the user (once) to bind a disk folder when none is stored yet. */
export async function promptBindIfNeeded(): Promise<void> {
  if (bindPrompted || (await hasStoredGuestDiskHandle())) {
    return
  }
  bindPrompted = true
  onNeedBind?.()
}

// ── bound-folder handle (IndexedDB) ─────────────────────────────────────────

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

export async function clearDirHandle(): Promise<void> {
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

/** Forget the in-memory bound-dir handle (used when clearing persisted state). */
export function forgetBoundDir(): void {
  diskDir = null
}

// ── full VM state (IndexedDB) ───────────────────────────────────────────────

/**
 * The VM snapshot lives in IndexedDB, not the bound folder: OPFS is refused on
 * file:// and a File System Access handle loses its permission on every reload,
 * so only IndexedDB can be read during boot without a user gesture. Blob and
 * meta are separate keys so reading the timestamp never pulls the whole image.
 */
function openStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_DB, STATE_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
}

export async function readState<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openStateDb()
    const row = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readonly')
      const req = tx.objectStore(STATE_STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'))
    })
    db.close()
    return row
  } catch {
    return undefined
  }
}

export async function writeState(blob: Blob, meta: GuestDiskSaveInfo): Promise<void> {
  const db = await openStateDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'))
      const store = tx.objectStore(STATE_STORE)
      store.put(blob, STATE_BLOB_KEY)
      store.put(meta, STATE_META_KEY)
    })
  } finally {
    db.close()
  }
}

export async function clearState(): Promise<void> {
  try {
    const db = await openStateDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'))
      const store = tx.objectStore(STATE_STORE)
      store.delete(STATE_BLOB_KEY)
      store.delete(STATE_META_KEY)
    })
    db.close()
  } catch {
    /* ignore */
  }
}

/** Drop the old IndexedDB snapshot (file contents). Overlay now lives on disk. */
export function dropLegacyIdbSnapshot(): void {
  try {
    indexedDB.deleteDatabase('ucd-guest-fs')
  } catch {
    /* ignore */
  }
}

// ── File System Access helpers ──────────────────────────────────────────────

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

export async function writeBinaryFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(data)
  await w.close()
}

export async function readBinaryFile(
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

export async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch {
    /* ignore */
  }
}

export async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(text)
  await w.close()
}

export async function readTextFile(
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

export function parseSnapshot(raw: unknown): Snapshot | undefined {
  if (raw == null || typeof raw !== 'object') {
    return undefined
  }
  const s = raw as Snapshot
  if (s.version !== 1 || !Array.isArray(s.entries)) {
    return undefined
  }
  return s
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

export async function ensureDiskDir(opts: {
  prompt: boolean
}): Promise<FileSystemDirectoryHandle | null> {
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

/**
 * Read the overlay snapshot from a bound folder if its handle is still granted.
 * Also adopts the handle as the active bound dir. Used during boot (no gesture).
 */
export async function readGrantedDirSnapshot(): Promise<
  { dir: FileSystemDirectoryHandle } | null
> {
  const saved = await loadDirHandle()
  if (saved == null) {
    return null
  }
  const perm = await (saved as FsHandleWithPerm).queryPermission?.({ mode: 'readwrite' })
  if (perm !== 'granted') {
    return null
  }
  diskDir = saved
  return { dir: saved }
}
