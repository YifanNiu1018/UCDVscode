/**
 * Install web-compatible extensions from a local .vsix / Open VSX gallery.
 *
 * Allowed:
 * - `"browser"` JS (e.g. vscodevim) — run on LocalProcess with data: URLs
 * - declarative (no `main`/`browser`): color/icon themes, grammars, snippets
 *
 * Rejected: Node-only (`main` without `browser`), e.g. clangd.
 */
import {
  getService,
  IExtensionsWorkbenchService,
  IWorkbenchExtensionEnablementService,
  IWorkbenchExtensionManagementService
} from '@codingame/monaco-vscode-api'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import * as vscode from 'vscode'

/** vs/workbench EnablementState — avoid deep vscode import in classic bundle. */
const DisabledGlobally = 10
const DisabledWorkspace = 11
const EnabledGlobally = 12
const EnabledWorkspace = 13

const DB_NAME = 'ucd-user-extensions'
const STORE = 'vsix'
const DB_VERSION = 1

type StoredVsix = { id: string; bytes: ArrayBuffer }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
}

async function saveVsix(id: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
    tx.objectStore(STORE).put({ id, bytes })
  })
  db.close()
}

async function deleteVsix(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'))
    tx.objectStore(STORE).delete(id)
  })
  db.close()
}

async function loadVsix(id: string): Promise<StoredVsix | undefined> {
  const db = await openDb()
  const row = await new Promise<StoredVsix | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result as StoredVsix | undefined)
    req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'))
  })
  db.close()
  return row
}

async function loadAllVsix(): Promise<StoredVsix[]> {
  const db = await openDb()
  const rows = await new Promise<StoredVsix[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve((req.result as StoredVsix[]) ?? [])
    req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'))
  })
  db.close()
  return rows
}

async function inflateRaw(comp: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot inflate VSIX (no DecompressionStream)')
  }
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([comp.slice()]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Read `extension/*` files out of a .vsix (zip). */
export async function unzipVsix(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const u8 = new Uint8Array(buf)
  const view = new DataView(buf)
  let eocd = -1
  const min = Math.max(0, u8.length - 22 - 65536)
  for (let i = u8.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new Error('Not a VSIX/zip file')
  }
  const entries = view.getUint16(eocd + 10, true)
  let cdOff = view.getUint32(eocd + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(cdOff, true) !== 0x02014b50) {
      throw new Error('Invalid VSIX central directory')
    }
    const method = view.getUint16(cdOff + 10, true)
    const compSize = view.getUint32(cdOff + 20, true)
    const nameLen = view.getUint16(cdOff + 28, true)
    const extraLen = view.getUint16(cdOff + 30, true)
    const commentLen = view.getUint16(cdOff + 32, true)
    const localOff = view.getUint32(cdOff + 42, true)
    const name = new TextDecoder().decode(u8.subarray(cdOff + 46, cdOff + 46 + nameLen))
    cdOff += 46 + nameLen + extraLen + commentLen
    if (!name.startsWith('extension/') || name.endsWith('/')) {
      continue
    }
    const rel = name.slice('extension/'.length)
    if (rel === '' || rel.includes('..')) {
      continue
    }
    const locNameLen = view.getUint16(localOff + 26, true)
    const locExtraLen = view.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + locNameLen + locExtraLen
    const comp = u8.subarray(dataStart, dataStart + compSize)
    let data: Uint8Array
    if (method === 0) {
      data = comp.slice()
    } else if (method === 8) {
      data = await inflateRaw(comp)
    } else {
      throw new Error(`Unsupported zip method ${method} in ${rel}`)
    }
    out.set(rel, data)
  }
  return out
}

function guessMime(p: string): string {
  const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : ''
  const map: Record<string, string> = {
    js: 'text/javascript',
    mjs: 'text/javascript',
    cjs: 'text/javascript',
    json: 'application/json',
    css: 'text/css',
    html: 'text/html',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    md: 'text/markdown',
    txt: 'text/plain',
    wasm: 'application/wasm',
    map: 'application/json'
  }
  return map[ext] ?? 'application/octet-stream'
}

const loadedIds = new Set<string>()
const loadedDisposers = new Map<string, () => Promise<void>>()

async function unloadRegistered(id: string): Promise<void> {
  const dispose = loadedDisposers.get(id)
  loadedDisposers.delete(id)
  loadedIds.delete(id)
  if (dispose != null) {
    try {
      await dispose()
    } catch (e) {
      console.warn('[UCD] dispose extension failed', id, e)
    }
  }
}

async function unloadAndForget(id: string): Promise<void> {
  await unloadRegistered(id)
  try {
    await deleteVsix(id)
  } catch (e) {
    console.warn('[UCD] delete vsix failed', id, e)
  }
}

async function reloadFromIdb(id: string): Promise<void> {
  if (loadedIds.has(id)) {
    return
  }
  const row = await loadVsix(id)
  if (row == null) {
    return
  }
  const files = await unzipVsix(row.bytes)
  await registerVsixFiles(files)
}

export async function registerVsixFiles(files: Map<string, Uint8Array>): Promise<string> {
  const pkg = files.get('package.json')
  if (pkg == null) {
    throw new Error('VSIX has no extension/package.json')
  }
  const manifest = JSON.parse(new TextDecoder().decode(pkg)) as {
    name: string
    publisher: string
    version?: string
    engines?: { vscode?: string }
    browser?: string
    main?: string
    contributes?: Record<string, unknown>
    activationEvents?: string[]
    extensionKind?: string | string[]
  }
  const id = `${manifest.publisher}.${manifest.name}`
  if (loadedIds.has(id)) {
    return id
  }
  const hasBrowser = typeof manifest.browser === 'string' && manifest.browser.trim() !== ''
  const hasMain = typeof manifest.main === 'string' && manifest.main.trim() !== ''
  // Themes / grammars / snippets: no JS. vim-like: browser entry. Node-only: main only.
  if (!hasBrowser && hasMain) {
    throw new Error(
      `${id} is a desktop (Node) extension with no web entry. UCDVSC can only run ` +
        `declarative extensions (themes, grammars) or web extensions with a package.json "browser" field (e.g. vscodevim).`
    )
  }

  // LocalProcess runs on the main thread (already up). LocalWebWorker needs a
  // module/blob EH worker, which file:// blocks (blob:null / CORS).
  const kind = ExtensionHostKind.LocalProcess
  const { registerFileUrl, whenReady, dispose } = registerExtension(manifest as never, kind, {
    system: false
  })
  for (const [p, data] of files) {
    const mime = guessMime(p)
    const url = bytesToDataUrl(data, mime)
    registerFileUrl(p, url, { mimeType: mime, size: data.byteLength })
    if (p.endsWith('.js')) {
      registerFileUrl(p.slice(0, -3), url, { mimeType: mime, size: data.byteLength })
    }
  }
  try {
    await Promise.race([
      whenReady(),
      new Promise<void>((_, reject) => {
        window.setTimeout(() => reject(new Error('whenReady timed out')), 8_000)
      })
    ])
  } catch (e) {
    console.warn('[UCD] extension whenReady', id, e)
  }
  loadedIds.add(id)
  loadedDisposers.set(id, () => dispose())
  return id
}

function bytesToDataUrl(data: Uint8Array, mime: string): string {
  const chunk = 8192
  let binary = ''
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

export async function restoreUserExtensions(): Promise<string[]> {
  const rows = await loadAllVsix()
  let disabled = new Set<string>()
  try {
    const mgmt = await getService(IWorkbenchExtensionManagementService)
    const enablement = await getService(IWorkbenchExtensionEnablementService)
    const installed = await mgmt.getInstalled()
    for (const ext of installed) {
      const id = ext.identifier?.id
      if (id != null && !enablement.isEnabled(ext)) {
        disabled.add(id.toLowerCase())
      }
    }
  } catch (e) {
    console.warn('[UCD] could not read extension enablement', e)
  }
  const ids: string[] = []
  for (const row of rows) {
    if (disabled.has(row.id.toLowerCase())) {
      console.info('[UCD] skip disabled extension', row.id)
      continue
    }
    try {
      const files = await unzipVsix(row.bytes)
      ids.push(await registerVsixFiles(files))
    } catch (e) {
      console.warn('[UCD] restore extension failed', row.id, e)
    }
  }
  return ids
}

function pickVsixFile(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.vsix,application/zip'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      input.remove()
      resolve(f)
    })
    input.addEventListener('cancel', () => {
      input.remove()
      resolve(undefined)
    })
    input.click()
  })
}

export async function installVsixFromFile(): Promise<void> {
  const file = await pickVsixFile()
  if (file == null) {
    return
  }
  try {
    const buf = await file.arrayBuffer()
    const files = await unzipVsix(buf)
    const id = await registerVsixFiles(files)
    await saveVsix(id, buf.slice(0))
    void vscode.window.showInformationMessage(`Installed ${id}.`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    void vscode.window.showErrorMessage('Install VSIX failed: ' + msg)
  }
}

function openVsixUrl(publisher: string, name: string, version: string): string {
  return `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${publisher}.${name}-${version}.vsix`
}

async function downloadVsixBytes(
  publisher: string,
  name: string,
  version: string,
  extraUrl?: string
): Promise<ArrayBuffer> {
  const urls = [...(extraUrl != null && extraUrl !== '' ? [extraUrl] : []), openVsixUrl(publisher, name, version)]
  let last = 'download failed'
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return await res.arrayBuffer()
      }
      last = `${url} → HTTP ${res.status}`
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(last)
}

async function resolveLatestVersion(publisher: string, name: string): Promise<string> {
  const res = await fetch(`https://open-vsx.org/api/${publisher}/${name}/latest`)
  if (!res.ok) {
    throw new Error(`Open VSX ${publisher}.${name} latest → HTTP ${res.status}`)
  }
  const j = (await res.json()) as { version?: string }
  if (typeof j.version !== 'string' || j.version.trim() === '') {
    throw new Error(`Open VSX ${publisher}.${name}: no version`)
  }
  return j.version
}

type GallerySpec = {
  publisher: string
  name: string
  version?: string
  downloadUri?: string
}

function splitExtensionId(id: string): { publisher: string; name: string } | null {
  const i = id.indexOf('.')
  if (i <= 0 || i >= id.length - 1) {
    return null
  }
  return { publisher: id.slice(0, i), name: id.slice(i + 1) }
}

function gallerySpecFromInstallArg(arg: unknown): GallerySpec | null {
  if (typeof arg === 'string') {
    return splitExtensionId(arg)
  }
  if (arg == null || typeof arg !== 'object') {
    return null
  }
  const rec = arg as {
    scheme?: string
    identifier?: { id?: string }
    publisher?: string
    name?: string
    version?: string
    gallery?: {
      publisher?: string
      name?: string
      version?: string
      assets?: { download?: { uri?: string; fallbackUri?: string } }
    }
    manifest?: { publisher?: string; name?: string; version?: string }
  }
  if (typeof rec.scheme === 'string' && rec.scheme !== '') {
    return null
  }
  const gallery = rec.gallery
  if (gallery != null && typeof gallery.publisher === 'string' && typeof gallery.name === 'string') {
    return {
      publisher: gallery.publisher,
      name: gallery.name,
      version: typeof gallery.version === 'string' ? gallery.version : rec.version,
      downloadUri: gallery.assets?.download?.uri ?? gallery.assets?.download?.fallbackUri
    }
  }
  const id = rec.identifier?.id ?? (typeof rec.publisher === 'string' && typeof rec.name === 'string'
    ? `${rec.publisher}.${rec.name}`
    : rec.manifest != null && typeof rec.manifest.publisher === 'string' && typeof rec.manifest.name === 'string'
      ? `${rec.manifest.publisher}.${rec.manifest.name}`
      : '')
  const parts = splitExtensionId(id)
  if (parts == null) {
    return null
  }
  return {
    ...parts,
    version:
      (typeof rec.version === 'string' ? rec.version : undefined) ??
      (typeof rec.manifest?.version === 'string' ? rec.manifest.version : undefined)
  }
}

async function activateWebExtensionFromVsix(
  publisher: string,
  name: string,
  version: string,
  downloadUri?: string
): Promise<boolean> {
  const id = `${publisher}.${name}`
  if (loadedIds.has(id)) {
    return false
  }
  console.info('[UCD] downloading web extension vsix', id, version)
  const buf = await downloadVsixBytes(publisher, name, version, downloadUri)
  const files = await unzipVsix(buf)
  await registerVsixFiles(files)
  await saveVsix(id, buf.slice(0))
  console.info('[UCD] web extension ready', id)
  return true
}

async function installWebExtensionWithFeedback(spec: GallerySpec): Promise<void> {
  const version = spec.version ?? (await resolveLatestVersion(spec.publisher, spec.name))
  const id = `${spec.publisher}.${spec.name}`
  try {
    void vscode.window.showInformationMessage(`Installing ${id} ${version}…`)
    const ok = await activateWebExtensionFromVsix(spec.publisher, spec.name, version, spec.downloadUri)
    if (ok) {
      void vscode.window.showInformationMessage(`Loaded ${id}.`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[UCDVSC] web extension install failed', id, e)
    void vscode.window.showErrorMessage(`Failed to load extension ${id}: ${msg}`)
  }
}

/**
 * Call after workbench initialize: activate already-installed gallery web
 * extensions, and intercept future Install clicks.
 */
export async function hookGalleryWebExtensions(): Promise<void> {
  const wb = await getService(IExtensionsWorkbenchService)
  const origInstall = wb.install.bind(wb) as (
    arg: unknown,
    installOptions?: unknown,
    progressLocation?: unknown
  ) => Promise<unknown>
  ;(wb as { install: typeof wb.install }).install = (async (arg, installOptions, progressLocation) => {
    const spec = gallerySpecFromInstallArg(arg)
    if (spec != null) {
      await installWebExtensionWithFeedback(spec)
    }
    try {
      return (await origInstall(arg, installOptions, progressLocation)) as Awaited<
        ReturnType<IExtensionsWorkbenchService['install']>
      >
    } catch (e) {
      console.warn('[UCD] native gallery install failed (web extension may still be loaded)', e)
      if (spec == null) {
        throw e
      }
      return arg as Awaited<ReturnType<IExtensionsWorkbenchService['install']>>
    }
  }) as typeof wb.install

  const origUninstall = wb.uninstall.bind(wb)
  ;(wb as { uninstall: typeof wb.uninstall }).uninstall = (async (extension) => {
    const id = extension?.identifier?.id
    try {
      await origUninstall(extension)
    } finally {
      if (typeof id === 'string' && id !== '') {
        await unloadAndForget(id)
        void vscode.window.showInformationMessage(`Uninstalled ${id}`)
      }
    }
  }) as typeof wb.uninstall

  const origSetEnablement = wb.setEnablement.bind(wb)
  ;(wb as { setEnablement: typeof wb.setEnablement }).setEnablement = (async (
    extensions,
    enablementState
  ) => {
    await origSetEnablement(extensions, enablementState)
    const list = Array.isArray(extensions) ? extensions : [extensions]
    const disabled =
      enablementState === DisabledGlobally || enablementState === DisabledWorkspace
    const enabled = enablementState === EnabledGlobally || enablementState === EnabledWorkspace
    for (const ext of list) {
      const id = ext?.identifier?.id
      if (typeof id !== 'string' || id === '') {
        continue
      }
      if (disabled) {
        await unloadRegistered(id)
        void vscode.window.showInformationMessage(`Disabled ${id}`)
      } else if (enabled) {
        try {
          await reloadFromIdb(id)
          void vscode.window.showInformationMessage(`Enabled ${id}`)
        } catch (e) {
          console.warn('[UCD] re-enable failed', id, e)
        }
      }
    }
  }) as typeof wb.setEnablement

  const mgmt = await getService(IWorkbenchExtensionManagementService)
  mgmt.onDidUninstallExtension((e) => {
    const id = e.identifier?.id
    if (typeof id === 'string' && id !== '') {
      void unloadAndForget(id)
    }
  })
  mgmt.onDidInstallExtensions((results) => {
    void (async () => {
      for (const r of results) {
        const fromId = r.identifier?.id != null ? splitExtensionId(r.identifier.id) : null
        const spec: GallerySpec | null =
          gallerySpecFromInstallArg(r.local) ??
          gallerySpecFromInstallArg(r.source) ??
          (fromId != null ? { publisher: fromId.publisher, name: fromId.name } : null)
        if (spec == null) {
          if (r.error != null) {
            console.warn('[UCD] gallery install error', r.identifier?.id, r.error)
          }
          continue
        }
        if (loadedIds.has(`${spec.publisher}.${spec.name}`)) {
          continue
        }
        await installWebExtensionWithFeedback(spec)
      }
    })()
  })

  try {
    const installed = await mgmt.getInstalled()
    let changed = false
    for (const ext of installed) {
      if (ext.isBuiltin) {
        continue
      }
      const spec = gallerySpecFromInstallArg(ext)
      if (spec == null) {
        continue
      }
      try {
        const version = spec.version ?? (await resolveLatestVersion(spec.publisher, spec.name))
        if (await activateWebExtensionFromVsix(spec.publisher, spec.name, version, spec.downloadUri)) {
          changed = true
        }
      } catch (e) {
        console.warn('[UCD] activate installed web extension failed', spec.publisher + '.' + spec.name, e)
      }
    }
    if (changed) {
      /* restored silently */
    }
  } catch (e) {
    console.warn('[UCD] scan installed extensions failed', e)
  }
}
