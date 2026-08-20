/**
 * v86 runtime loading: fetch libv86 / Alpine / wasm-bios packs and, under
 * file://, serve them from inlined base64 (browsers block XHR of sibling files).
 */
import type { V86NetworkAdapter } from './guestBridge'

declare global {
  interface Window {
    V86?: new (options: Record<string, unknown>) => V86Emulator
    __V86_VFS_B64__?: Record<string, string>
    __V86_VFS_READY__?: boolean
    __V86_VFS_ID__?: string
    __UCD_V86_RUNTIME__?: {
      WASM_B64: string
      BIOS_B64: string
      VGA_B64: string
    }
  }
}

export interface V86Emulator {
  serial0_send: (data: string) => void
  add_listener: (event: string, cb: (...args: unknown[]) => void) => void
  network_adapter?: V86NetworkAdapter
  keyboard_set_enabled?: (enabled: boolean) => void
  destroy?: () => void
  save_state?: () => Promise<ArrayBuffer>
  restore_state?: (state: ArrayBuffer) => Promise<void>
  run?: () => Promise<void> | void
  stop?: () => Promise<void> | void
}

export function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) != null) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** file:// cannot XHR sibling assets (CORS). Serve Alpine pack + runtime from inlined b64. */
function installFileProtocolVfsShim(): void {
  const normalizeKey = (url: string): string => {
    let s = String(url)
    try {
      if (/^(https?:|file:)/i.test(s)) {
        s = new URL(s, location.href).pathname
      }
    } catch {
      /* keep s */
    }
    s = s.replace(/\\/g, '/')
    const img = s.indexOf('/images/')
    if (img >= 0) s = s.slice(img + 1)
    const v86Img = s.indexOf('/v86/images/')
    if (v86Img >= 0) s = s.slice(v86Img + '/v86/'.length)
    if (s.startsWith('./')) s = s.slice(2)
    while (s.startsWith('/')) s = s.slice(1)
    return s
  }

  const lookup = (url: string): ArrayBuffer | null => {
    const m = window.__V86_VFS_B64__
    if (m == null) return null
    const key = normalizeKey(url)
    let b64 = m[key]
    if (b64 == null) {
      const base = key.split('/').pop()
      if (base != null) {
        b64 = m[base] ?? m[`images/alpine-rootfs-flat/${base}`]
      }
    }
    if (b64 == null) return null
    return b64ToBuf(b64)
  }

  const XHR = window.XMLHttpRequest
  function Shim(this: XMLHttpRequest) {
    const xhr = new XHR()
    let method = 'GET'
    let url = ''
    let responseType = ''
    const listeners: Record<string, Array<(ev: Event) => void>> = {}
    const api: Record<string, unknown> = {
      UNSENT: 0,
      OPENED: 1,
      HEADERS_RECEIVED: 2,
      LOADING: 3,
      DONE: 4,
      readyState: 0,
      status: 0,
      statusText: '',
      response: null,
      responseText: '',
      onload: null,
      onerror: null,
      onprogress: null,
      onreadystatechange: null,
      open(m: string, u: string) {
        method = m
        url = u
        api.readyState = 1
      },
      setRequestHeader() {},
      overrideMimeType() {},
      getResponseHeader() {
        return null
      },
      getAllResponseHeaders() {
        return ''
      },
      addEventListener(type: string, fn: (ev: Event) => void) {
        ;(listeners[type] || (listeners[type] = [])).push(fn)
      },
      removeEventListener(type: string, fn: (ev: Event) => void) {
        listeners[type] = (listeners[type] || []).filter((x) => x !== fn)
      },
      abort() {},
      send() {
        const fire = (type: string) => {
          const ev = { type, target: api } as unknown as Event
          const handler = api[`on${type}`] as ((e: Event) => void) | null
          handler?.(ev)
          for (const fn of listeners[type] || []) fn(ev)
        }
        const buf = lookup(url)
        if (buf == null) {
          xhr.responseType = ((api.responseType as string) ||
            responseType) as XMLHttpRequestResponseType
          xhr.onload = () => {
            api.readyState = 4
            api.status = xhr.status
            api.statusText = xhr.statusText
            api.response = xhr.response
            api.responseText = xhr.responseText
            fire('readystatechange')
            fire('load')
          }
          xhr.onerror = () => {
            api.readyState = 4
            api.status = 0
            fire('error')
          }
          xhr.open(method, url)
          xhr.send()
          return
        }
        const rt = (api.responseType as string) || responseType
        api.readyState = 4
        api.status = 200
        api.statusText = 'OK'
        if (rt === 'json') {
          api.response = JSON.parse(new TextDecoder().decode(buf))
        } else {
          api.response = buf.slice(0)
        }
        fire('readystatechange')
        fire('load')
      }
    }
    Object.defineProperty(api, 'responseType', {
      get: () => responseType,
      set: (v: string) => {
        responseType = v
      }
    })
    return api
  }
  Shim.prototype = XHR.prototype
  window.XMLHttpRequest = Shim as unknown as typeof XMLHttpRequest
}

/**
 * Load the inlined Alpine/wasm/bios packs and return the v86 constructor's
 * asset options. Throws when the packs are missing (fatal under file://).
 */
export async function prepareFileProtocolV86(
  onStatus: (msg: string) => void
): Promise<Record<string, unknown>> {
  const asset = (p: string) => new URL(p, document.baseURI).href
  onStatus('Loading Alpine VFS pack (file://, ~200MB)…')
  await Promise.all([
    loadScript(asset('alpine-vfs.js')),
    loadScript(asset('v86-runtime-assets.js'))
  ])
  if (window.__V86_VFS_READY__ !== true || window.__V86_VFS_B64__ == null) {
    throw new Error(
      'alpine-vfs.js missing next to ucdvsc.html — run: bash scripts/setup-v86.sh && npm run build:classic'
    )
  }
  const rt = window.__UCD_V86_RUNTIME__
  if (rt?.WASM_B64 == null || rt.BIOS_B64 == null || rt.VGA_B64 == null) {
    throw new Error(
      'v86-runtime-assets.js incomplete — run: bash scripts/setup-v86.sh && npm run build:classic'
    )
  }
  installFileProtocolVfsShim()
  const wasmBytes = b64ToBuf(rt.WASM_B64)
  return {
    wasm_fn: async (env: WebAssembly.Imports) => {
      const { instance } = await WebAssembly.instantiate(wasmBytes, env)
      return instance.exports
    },
    bios: { buffer: b64ToBuf(rt.BIOS_B64) },
    vga_bios: { buffer: b64ToBuf(rt.VGA_B64) },
    filesystem: {
      baseurl: 'images/alpine-rootfs-flat/',
      basefs: 'images/alpine-fs.json'
    }
  }
}
