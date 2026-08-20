/**
 * Full v86 VM snapshot (RAM + 9p + processes): save_state() blob persisted to
 * IndexedDB (and a bound folder when available) so a reopen skips cold boot.
 */
import {
  clearGuestVmDirty,
  clearState,
  ensureDiskDir,
  GUEST_MACHINE_TAG,
  getLastGuestDiskSave,
  isGuestVmDirty,
  noteGuestDiskSaved,
  parseSnapshot,
  readBinaryFile,
  readState,
  readTextFile,
  removeFile,
  STATE_BLOB_KEY,
  STATE_META_KEY,
  writeBinaryFile,
  writeState,
  writeTextFile,
  type GuestDiskSaveInfo
} from './guestDiskStore'

const VM_STATE_BIN = 'v86state.bin'
const VM_STATE_META = 'v86state.json'

let vmSaveFn: (() => Promise<ArrayBuffer>) | null = null
let vmSaving = false
let vmPersistStarted = false

function currentBaseImageId(): string | undefined {
  const id = window.__V86_VFS_ID__
  if (typeof id !== 'string' || id.length === 0) {
    return undefined
  }
  return `${id}|${GUEST_MACHINE_TAG}`
}

/** True when a stored snapshot cannot be safely restored on this alpine-vfs.js. */
function snapshotBaseImageMismatch(meta: GuestDiskSaveInfo | undefined): boolean {
  const current = currentBaseImageId()
  if (current == null) {
    return false
  }
  if (meta?.baseImageId == null || meta.baseImageId === '') {
    // Saved before we stamped images — unsafe after any guest image rebuild.
    return true
  }
  return meta.baseImageId !== current
}

async function readFsaVmMeta(
  dir: FileSystemDirectoryHandle
): Promise<GuestDiskSaveInfo | undefined> {
  const text = await readTextFile(dir, VM_STATE_META)
  if (text == null) {
    return undefined
  }
  try {
    const j = JSON.parse(text) as { savedAt?: number; byteLength?: number; baseImageId?: string }
    if (typeof j.savedAt !== 'number') {
      return undefined
    }
    return {
      savedAt: j.savedAt,
      byteLength: typeof j.byteLength === 'number' ? j.byteLength : undefined,
      source: 'vm',
      baseImageId: j.baseImageId
    }
  } catch {
    return undefined
  }
}

/** Read last save time from guest-disk meta (no user gesture). */
export async function loadLastGuestDiskSaveMeta(): Promise<GuestDiskSaveInfo | null> {
  const fromIdb = await readState<GuestDiskSaveInfo>(STATE_META_KEY)
  if (fromIdb != null && typeof fromIdb.savedAt === 'number') {
    noteGuestDiskSaved(fromIdb)
    return fromIdb
  }
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
  return getLastGuestDiskSave()
}

/** Drop only the full-VM snapshot (IndexedDB + v86state.bin), keep workspace overlay. */
export async function clearVmStateSnapshot(): Promise<void> {
  await clearState()
  try {
    const dir = await ensureDiskDir({ prompt: false })
    if (dir != null) {
      await removeFile(dir, VM_STATE_BIN)
      await removeFile(dir, VM_STATE_META)
    }
  } catch {
    /* ignore */
  }
}

/** Load the full v86 save_state buffer: IndexedDB first, then a bound folder. */
export async function loadVmStateBuffer(
  onStatus?: (msg: string) => void
): Promise<ArrayBuffer | undefined> {
  const meta = await readState<GuestDiskSaveInfo>(STATE_META_KEY)
  const blob = await readState<Blob>(STATE_BLOB_KEY)
  if (blob != null && blob.size > 64) {
    if (snapshotBaseImageMismatch(meta)) {
      const why =
        meta?.baseImageId == null
          ? 'no base-image tag (saved before guest image upgrade)'
          : `base image changed (${meta.baseImageId} → ${currentBaseImageId()})`
      console.warn('[ucd] discarding incompatible VM snapshot:', why)
      onStatus?.(`Discarding stale VM snapshot (${why}) — cold boot`)
      await clearState()
      return undefined
    }
    return await blob.arrayBuffer()
  }
  const dir = await ensureDiskDir({ prompt: false })
  if (dir != null) {
    const fsaMeta = await readFsaVmMeta(dir)
    const fromFsa = await readBinaryFile(dir, VM_STATE_BIN)
    if (fromFsa != null) {
      if (snapshotBaseImageMismatch(fsaMeta)) {
        onStatus?.('Discarding stale VM snapshot on disk — cold boot')
        try {
          await removeFile(dir, VM_STATE_BIN)
          await removeFile(dir, VM_STATE_META)
        } catch {
          /* ignore */
        }
        return undefined
      }
      return fromFsa
    }
  }
  try {
    const metaUrl = new URL('./guest-disk/' + VM_STATE_META, document.baseURI).href
    const binUrl = new URL('./guest-disk/' + VM_STATE_BIN, document.baseURI).href
    let fileMeta: GuestDiskSaveInfo | undefined
    try {
      const mr = await fetch(metaUrl)
      if (mr.ok) {
        const j = (await mr.json()) as { baseImageId?: string; savedAt?: number }
        if (typeof j.savedAt === 'number') {
          fileMeta = { savedAt: j.savedAt, source: 'vm', baseImageId: j.baseImageId }
        }
      }
    } catch {
      /* file:// CORS or missing meta */
    }
    const r = await fetch(binUrl)
    if (r.ok) {
      const buf = await r.arrayBuffer()
      if (buf.byteLength > 64) {
        if (snapshotBaseImageMismatch(fileMeta)) {
          onStatus?.('Discarding stale guest-disk/v86state.bin — cold boot')
          return undefined
        }
        return buf
      }
    }
  } catch {
    /* file:// CORS */
  }
  return undefined
}

export async function saveVmStateNow(force = false): Promise<number> {
  if (vmSaveFn == null || vmSaving) {
    return 0
  }
  if (!isGuestVmDirty() && !force) {
    return 0
  }
  vmSaving = true
  try {
    const buf = await vmSaveFn()
    const savedAt = Date.now()
    const info: GuestDiskSaveInfo = {
      savedAt,
      byteLength: buf.byteLength,
      source: 'vm',
      baseImageId: currentBaseImageId()
    }
    await writeState(new Blob([buf]), info)
    // A bound folder additionally gets a real file the user can copy elsewhere;
    // losing that permission must not invalidate the IndexedDB copy.
    try {
      const dir = await ensureDiskDir({ prompt: false })
      if (dir != null) {
        await writeBinaryFile(dir, VM_STATE_BIN, buf)
        await writeTextFile(
          dir,
          VM_STATE_META,
          JSON.stringify({
            version: 1,
            savedAt,
            byteLength: buf.byteLength,
            baseImageId: info.baseImageId
          }) + '\n'
        )
      }
    } catch (e) {
      console.warn('[ucd] VM snapshot saved to IndexedDB only', e)
    }
    clearGuestVmDirty()
    noteGuestDiskSaved(info)
    return buf.byteLength
  } finally {
    vmSaving = false
  }
}

/**
 * Periodic + tab-hide full VM snapshot (RAM + 9p + processes). Each save stops
 * the CPU and writes tens of MiB, so it only runs when dirty (edits/compile)
 * and at most every 10 minutes; the workspace overlay is what keeps edits safe.
 */
export function startGuestVmStatePersist(saveFn: () => Promise<ArrayBuffer>): void {
  vmSaveFn = saveFn
  if (vmPersistStarted) {
    return
  }
  vmPersistStarted = true
  let lastFlush = 0
  const flush = (minGapMs: number): void => {
    if (Date.now() - lastFlush < minGapMs) {
      return
    }
    lastFlush = Date.now()
    void saveVmStateNow().catch((e) => {
      console.warn('[ucd] save VM state failed', e)
    })
  }
  // Closing with unsaved guest state asks for confirmation. The dialog is also
  // the one window in which a >100 MiB write reliably finishes, so the save
  // starts here: cancelling leaves a saved snapshot and no second prompt.
  window.addEventListener('beforeunload', (e) => {
    if (!isGuestVmDirty()) {
      return
    }
    flush(0)
    e.preventDefault()
    e.returnValue = ''
  })
  window.addEventListener('pagehide', () => flush(0))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush(60_000)
    }
  })
  // save_state pauses the CPU and serializes all RAM — do it rarely.
  window.setInterval(() => {
    if (!isGuestVmDirty()) {
      return
    }
    flush(0)
  }, 600_000)
}
