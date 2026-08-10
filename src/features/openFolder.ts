/**
 * Open Folder against Alpine guest FS (not host FSA, not VS Code Server).
 * File → Open Folder browses /root, /root/workspace, …
 */
import * as vscode from 'vscode'
import {
  GUEST_HOME,
  GUEST_WORK,
  guestPathToVscode,
  guestRpc,
  guestWrite,
  isGuestControlReady
} from './guestBridge'
import { getGuestFs } from './guestFsProvider'
import { scheduleGuestWorkspacePersist } from './guestFsPersist'

export type OpenFolderResult = boolean

function labelForGuest(guestAbs: string): string {
  if (guestAbs === '/' || guestAbs === '') {
    return '/'
  }
  if (guestAbs === GUEST_WORK) {
    return 'workspace'
  }
  const parts = guestAbs.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || guestAbs
}

async function setWorkspaceFromGuest(guestAbs: string, name?: string): Promise<void> {
  const uri = vscode.Uri.file(guestPathToVscode(guestAbs))
  const folders = vscode.workspace.workspaceFolders ?? []
  const already =
    folders.length === 1 && folders[0] != null && folders[0].uri.toString() === uri.toString()
  if (!already) {
    const ok = vscode.workspace.updateWorkspaceFolders(0, folders.length, {
      uri,
      name: name ?? labelForGuest(guestAbs)
    })
    if (!ok) {
      throw new Error('updateWorkspaceFolders failed')
    }
  }
  getGuestFs()?.setWatchGuestPath(guestAbs)
  getGuestFs()?.notifyChanged(guestAbs)
}

async function listGuestDirs(guestAbs: string): Promise<Array<{ name: string; path: string }>> {
  const r = await guestRpc({ op: 'list', path: guestAbs }, 15000)
  if (!r.ok || r.entries == null) {
    throw new Error(r.stderr || 'list failed')
  }
  return r.entries
    .filter((e) => e.type === 'dir')
    .map((e) => ({
      name: e.name,
      path:
        e.path && e.path.startsWith('/')
          ? e.path
          : guestAbs === '/'
            ? '/' + e.name
            : `${guestAbs.replace(/\/+$/, '')}/${e.name}`
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Drill-down picker starting at /root (shows workspace, hello.c, …). */
export async function pickGuestFolder(startAbs = GUEST_HOME): Promise<string | undefined> {
  if (!isGuestControlReady()) {
    void vscode.window.showWarningMessage('Alpine guest is not ready yet.')
    return undefined
  }
  let cur = startAbs
  for (;;) {
    const dirs = await listGuestDirs(cur)
    type Item = vscode.QuickPickItem & {
      guest: string
      action: 'use' | 'up' | 'enter' | 'import'
    }
    const items: Item[] = [
      {
        label: '$(folder-opened) Use this folder',
        description: cur,
        guest: cur,
        action: 'use'
      }
    ]
    if (cur !== '/') {
      const parent = cur === GUEST_HOME ? '/' : cur.slice(0, cur.lastIndexOf('/')) || '/'
      items.push({
        label: '$(arrow-up) Parent folder',
        description: parent,
        guest: parent,
        action: 'up'
      })
    }
    items.push({
      label: '$(desktop-download) Import folder from this computer…',
      description: 'Copy into /root/workspace, then open',
      guest: '__import__',
      action: 'import'
    })
    for (const d of dirs) {
      items.push({
        label: `$(folder) ${d.name}`,
        description: d.path,
        guest: d.path,
        action: 'enter'
      })
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Open Folder (Alpine)',
      placeHolder: cur,
      ignoreFocusOut: true
    })
    if (picked == null) {
      return undefined
    }
    if (picked.action === 'use') {
      return picked.guest
    }
    if (picked.action === 'import') {
      return '__import__'
    }
    cur = picked.guest
  }
}

const SKIP_IMPORT_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-classic',
  '__pycache__',
  '.chrome-classic-probe'
])

function looksBinary(name: string, bytes: Uint8Array): boolean {
  const lower = name.toLowerCase()
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|zst|wasm|ttf|woff2?|exe|so|o|a|bin)$/.test(lower)) {
    return true
  }
  const n = Math.min(bytes.length, 800)
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      return true
    }
  }
  return false
}

async function importDirectoryHandle(
  dir: FileSystemDirectoryHandle,
  relPrefix: string,
  onProgress: (msg: string) => void
): Promise<{ files: number; skipped: number }> {
  let files = 0
  let skipped = 0
  if (relPrefix !== '.' && relPrefix !== '') {
    await guestRpc({ op: 'mkdir', path: relPrefix })
  }
  for await (const [name, handle] of dir.entries()) {
    if (SKIP_IMPORT_NAMES.has(name) || name.startsWith('.')) {
      skipped++
      continue
    }
    const rel = relPrefix === '.' || relPrefix === '' ? name : `${relPrefix}/${name}`
    if (handle.kind === 'directory') {
      const sub = await importDirectoryHandle(handle, rel, onProgress)
      files += sub.files
      skipped += sub.skipped
      continue
    }
    const file = await handle.getFile()
    const buf = new Uint8Array(await file.arrayBuffer())
    if (looksBinary(name, buf)) {
      skipped++
      continue
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
    onProgress(rel)
    await guestWrite(rel, text)
    files++
  }
  return { files, skipped }
}

export async function importHostFolderIntoAlpine(): Promise<string | undefined> {
  if (!isGuestControlReady()) {
    void vscode.window.showWarningMessage('Alpine guest is not ready yet.')
    return undefined
  }
  const pickDir = (
    window as Window & {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  if (typeof pickDir !== 'function') {
    void vscode.window.showErrorMessage(
      'This browser has no File System Access API (Open Folder from computer). Use Chrome/Edge.'
    )
    return undefined
  }
  let dir: FileSystemDirectoryHandle
  try {
    dir = await pickDir({ mode: 'read' })
  } catch {
    return undefined
  }
  const destRel = dir.name.replace(/[/\\]/g, '_') || 'imported'
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Importing “${dir.name}” into Alpine…`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: destRel })
      const r = await importDirectoryHandle(dir, destRel, (msg) => {
        progress.report({ message: msg })
      })
      void vscode.window.showInformationMessage(
        `Imported ${r.files} files into /root/workspace/${destRel}` +
          (r.skipped > 0 ? ` (skipped ${r.skipped} binary/hidden)` : '')
      )
    }
  )
  getGuestFs()?.notifyChanged()
  scheduleGuestWorkspacePersist(400)
  return destRel
}

/** File → Open Folder (workspaceProvider.open) and Command Palette. */
export async function openUcdFolder(): Promise<OpenFolderResult> {
  try {
    const picked = await pickGuestFolder(GUEST_HOME)
    if (picked == null) {
      return false
    }
    if (picked === '__import__') {
      const rel = await importHostFolderIntoAlpine()
      if (rel == null) {
        return false
      }
      await setWorkspaceFromGuest(`${GUEST_WORK}/${rel}`)
      return true
    }
    await setWorkspaceFromGuest(picked)
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    void vscode.window.showErrorMessage('Open Folder failed: ' + msg)
    return false
  }
}

export async function registerOpenFolderCommands(api: typeof vscode): Promise<void> {
  api.commands.registerCommand('ucd.openFolder', () => openUcdFolder())
  api.commands.registerCommand('ucd.importHostFolder', async () => {
    const rel = await importHostFolderIntoAlpine()
    if (rel != null) {
      await setWorkspaceFromGuest(`${GUEST_WORK}/${rel}`)
    }
  })
}
