/**
 * Workspace overlay: mirror the guest /root/workspace into guest-disk/workspace.json
 * (a writable layer over the read-only Alpine base image) and restore it on boot.
 */
import { GUEST_WORK, guestRpc, isGuestControlReady } from './guestBridge'
import {
  clearDirHandle,
  dropLegacyIdbSnapshot,
  ensureDiskDir,
  forgetBoundDir,
  markGuestVmDirty,
  noteGuestDiskSaved,
  parseSnapshot,
  promptBindIfNeeded,
  readGrantedDirSnapshot,
  readTextFile,
  writeTextFile,
  type Snapshot,
  type StoredEntry
} from './guestDiskStore'
import { clearVmStateSnapshot, saveVmStateNow } from './guestVmSnapshot'

const MAX_FILE_BYTES = 512 * 1024
const SKIP_NAME = /^(a\.out|main)$|\.(o|a|so|bin|out)$/i
const OVERLAY_JSON = 'workspace.json'

let persistStarted = false
let saving = false
let debounceTimer: number | null = null
let lastFingerprint = ''

async function readSnapshotFromDir(
  dir: FileSystemDirectoryHandle
): Promise<Snapshot | undefined> {
  const json = await readTextFile(dir, OVERLAY_JSON)
  if (json != null && json.trim() !== '' && json.trim() !== 'null') {
    try {
      return parseSnapshot(JSON.parse(json))
    } catch {
      /* corrupt overlay — treat as none */
    }
  }
  return undefined
}

async function writeSnapshotToDir(
  dir: FileSystemDirectoryHandle,
  snap: Snapshot
): Promise<void> {
  const json = JSON.stringify(snap)
  await writeTextFile(dir, OVERLAY_JSON, json + '\n')
  window.__UCD_GUEST_DISK__ = snap
}

async function loadSnapshot(): Promise<Snapshot | undefined> {
  const fromScript = parseSnapshot(window.__UCD_GUEST_DISK__)
  if (fromScript != null) {
    return fromScript
  }
  const granted = await readGrantedDirSnapshot()
  if (granted != null) {
    const fromFsa = await readSnapshotFromDir(granted.dir)
    if (fromFsa != null) {
      window.__UCD_GUEST_DISK__ = fromFsa
      return fromFsa
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
  await clearVmStateSnapshot()
  const empty: Snapshot = { version: 1, savedAt: Date.now(), entries: [] }
  try {
    const dir = await ensureDiskDir({ prompt: false })
    if (dir != null) {
      await writeSnapshotToDir(dir, empty)
      return
    }
  } catch {
    /* ignore */
  }
  await clearDirHandle()
  forgetBoundDir()
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
      await promptBindIfNeeded()
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
  const stateBytes = await saveVmStateNow(true)
  return { files, stateBytes }
}

export function scheduleGuestWorkspacePersist(delayMs = 1200): void {
  markGuestVmDirty()
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
    if (!isGuestControlReady() || document.visibilityState === 'hidden') {
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
  }, 20_000)
}
