#!/usr/bin/env node
/**
 * Route 1: classic-script Workbench → UCD/ucdVscode/
 *
 * Usage (from src/):
 *   npm run build:classic
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..') // src/
const repoRoot = path.resolve(appRoot, '..') // UCD/
const require = createRequire(path.join(appRoot, 'package.json'))
const dist = path.join(appRoot, 'dist')
const outDir = path.join(appRoot, 'dist-classic')
const publishDir = path.join(repoRoot, 'ucdVscode')

function findHtmlEntry() {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const m = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/)
  if (!m) throw new Error('Cannot find entry script in dist/index.html — run vite build first')
  return path.join(dist, 'assets', m[1])
}

function b64(filePath) {
  return fs.readFileSync(filePath).toString('base64')
}

function listAssets(prefix, ext) {
  return fs
    .readdirSync(path.join(dist, 'assets'))
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
}

console.log('==> esbuild single ESM graph')
const entry = findHtmlEntry()
const esmPath = path.join(outDir, '_workbench.esm.mjs')
fs.mkdirSync(outDir, { recursive: true })

const esbuildBin = path.join(appRoot, 'node_modules/esbuild/bin/esbuild')
if (!fs.existsSync(esbuildBin)) {
  throw new Error('esbuild not found at ' + esbuildBin + ' — run: cd src && npm install')
}
execFileSync(
  esbuildBin,
  [entry, '--bundle', '--format=esm', '--platform=browser', `--outfile=${esmPath}`],
  { stdio: 'inherit' }
)

let code = fs.readFileSync(esmPath, 'utf8')

console.log('==> inline critical wasm as data URLs (onig for TextMate; skip huge tree-sitter)')
const wasmFiles = listAssets('', '.wasm')
const wasmData = {}
for (const f of wasmFiles) {
  const full = path.join(dist, 'assets', f)
  const size = fs.statSync(full).size
  const keep =
    f.startsWith('onig-') ||
    f.startsWith('diff_wasm') ||
    size < 500_000
  if (!keep) {
    console.log('  skip wasm', f, `(${(size / 1024 / 1024).toFixed(1)} MiB)`)
    continue
  }
  wasmData[f] = 'data:application/wasm;base64,' + b64(full)
  console.log('  wasm', f, `(${(size / 1024).toFixed(0)} KiB)`)
}
const wasmPrelude = `
globalThis.__UCD_WASM_URL__ = ${JSON.stringify(wasmData)};
function __ucdWasmUrl(name){
  var u = globalThis.__UCD_WASM_URL__[name];
  if(!u) throw new Error('missing inlined wasm: '+name);
  return u;
}
`

function rewriteWasmUrls(src, label) {
  return src.replace(
    /new\s+URL\(\s*(["'`])(\.?\/?[A-Za-z0-9_.-]+\.wasm)\1\s*,\s*import\.meta\.url\s*\)/g,
    (match, _q, name) => {
      const base = name.replace(/^\.\//, '')
      if (wasmData[base]) {
        console.log('  wasm ref → data', label ? label + ':' + base : base)
        // Literal data: URL so TextMate workers (blob scope) can load onig.wasm
        return `new URL(${JSON.stringify(wasmData[base])})`
      }
      return match
    }
  )
}

console.log('==> inline workers as blob URLs')
const workerFiles = listAssets('worker-', '.js')
const workerMap = {}
for (const f of workerFiles) {
  workerMap[f] = rewriteWasmUrls(
    fs.readFileSync(path.join(dist, 'assets', f), 'utf8'),
    f
  )
}
const workerPrelude = `
globalThis.__UCD_WORKER_URL__ = Object.create(null);
(function(){
  var sources = ${JSON.stringify(workerMap)};
  Object.keys(sources).forEach(function(name){
    var blob = new Blob([sources[name]], { type: 'text/javascript' });
    globalThis.__UCD_WORKER_URL__[name] = URL.createObjectURL(blob);
  });
})();
function __ucdWorkerUrl(name){
  var u = globalThis.__UCD_WORKER_URL__[name];
  if(!u) throw new Error('missing inlined worker: '+name);
  return u;
}
function __ucdDynamicImport(spec){
  console.warn('[UCD] dynamic import stubbed in classic bundle:', spec);
  return Promise.reject(new Error('dynamic import unavailable in classic file:// bundle: ' + spec));
}
`

// new URL("worker-XXX.js", import.meta.url) / template / ./worker
code = code.replace(
  /new\s+URL\(\s*(["'`])(\.?\/?worker-[A-Za-z0-9_-]+\.js)\1\s*,\s*import\.meta\.url\s*\)/g,
  (_, _q, name) => {
    const base = name.replace(/^\.\//, '')
    console.log('  worker ref → blob', base)
    return `__ucdWorkerUrl(${JSON.stringify(base)})`
  }
)

code = rewriteWasmUrls(code, 'main')

console.log('==> inline static assets for file:// fetch shim')
const assetDir = path.join(dist, 'assets')
const assetExtOk = new Set([
  '.json',
  '.ttf',
  '.woff',
  '.woff2',
  '.svg',
  '.png',
  '.ico',
  '.css',
])
const assetB64 = {}
let assetBytes = 0
for (const f of fs.readdirSync(assetDir)) {
  const ext = path.extname(f).toLowerCase()
  if (!assetExtOk.has(ext)) continue
  // Skip huge KaTeX font pack — not required for Workbench bring-up
  if (f.startsWith('KaTeX_')) continue
  const full = path.join(assetDir, f)
  const size = fs.statSync(full).size
  if (size > 2_000_000) {
    console.log('  skip large asset', f, `(${(size / 1024 / 1024).toFixed(1)} MiB)`)
    continue
  }
  assetB64[f] = b64(full)
  assetBytes += size
}
console.log(
  `  inlined ${Object.keys(assetB64).length} assets (${(assetBytes / 1024 / 1024).toFixed(1)} MiB raw)`
)

const mimeByExt = {
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
}
const assetPrelude = `
globalThis.__UCD_ASSET_B64__ = ${JSON.stringify(assetB64)};
(function(){
  var mime = ${JSON.stringify(mimeByExt)};
  function basename(u){
    try {
      var p = String(u).split('?')[0].split('#')[0];
      var i = p.lastIndexOf('/');
      return i >= 0 ? p.slice(i+1) : p;
    } catch (e) { return ''; }
  }
  function b64ToU8(b64){
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function assetResponse(name){
    var raw = globalThis.__UCD_ASSET_B64__[name];
    if (!raw) return null;
    var ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    return new Response(b64ToU8(raw), {
      status: 200,
      headers: { 'Content-Type': mime[ext] || 'application/octet-stream' }
    });
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    try {
      var url = typeof input === 'string' ? input : (input && input.url);
      // Never hijack http(s) — Open VSX / unpkg / gallery must hit the network
      if (/^https?:/i.test(String(url))) {
        return origFetch(input, init);
      }
      var name = basename(url);
      if (!name || name === 'undefined') {
        return Promise.reject(new TypeError('UCD classic: invalid asset url ' + url));
      }
      var res = assetResponse(name);
      if (res) return Promise.resolve(res);
    } catch (e) {}
    return origFetch(input, init);
  };
  // XHR used by some VS Code asset loaders
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){
    this.__ucdUrl = url;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body){
    try {
      if (/^https?:/i.test(String(this.__ucdUrl))) {
        return XS.apply(this, arguments);
      }
      var name = basename(this.__ucdUrl);
      var raw = name && globalThis.__UCD_ASSET_B64__[name];
      if (raw) {
        var self = this;
        var u8 = b64ToU8(raw);
        var ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
        setTimeout(function(){
          Object.defineProperty(self, 'status', { configurable: true, get: function(){ return 200; }});
          Object.defineProperty(self, 'readyState', { configurable: true, get: function(){ return 4; }});
          Object.defineProperty(self, 'response', { configurable: true, get: function(){ return self.responseType === 'arraybuffer' ? u8.buffer : u8; }});
          Object.defineProperty(self, 'responseText', { configurable: true, get: function(){
            return new TextDecoder().decode(u8);
          }});
          Object.defineProperty(self, 'responseURL', { configurable: true, get: function(){ return String(self.__ucdUrl); }});
          self.onreadystatechange && self.onreadystatechange();
          self.onload && self.onload();
        }, 0);
        return;
      }
    } catch (e) {}
    return XS.apply(this, arguments);
  };
})();
`

code = code.replace(/import\.meta\.url/g, 'document.baseURI')
code = code.replace(/import\.meta\.resolve\b/g, '(function(s){ return s })')
code = code.replace(/import\.meta\b/g, '({ url: document.baseURI })')

// CSS @font-face / background-image cannot use fetch shim — file:// font/image
// URLs are CORS-blocked. Rewrite known assets to data: URLs in the bundle.
{
  console.log('==> rewrite asset new URL(...) to data: (fonts/icons)')
  let rewritten = 0
  code = code.replace(
    /new\s+URL\(\s*(["'`])(\.?\/?[^"'`]+)\1\s*,\s*document\.baseURI\s*\)(\.href)?/g,
    (match, _q, name, hrefSuffix) => {
      const base = name.replace(/^\.\//, '')
      const raw = assetB64[base]
      if (!raw) return match
      const ext = path.extname(base).toLowerCase()
      const mime = mimeByExt[ext] || 'application/octet-stream'
      const dataUrl = `data:${mime};base64,${raw}`
      rewritten++
      if (hrefSuffix) return JSON.stringify(dataUrl)
      return `new URL(${JSON.stringify(dataUrl)})`
    }
  )
  console.log(`  rewritten ${rewritten} asset URL refs → data:`)
}

// Dynamic import() works syntactically in classic scripts, but on file:// it
// still hits module CORS — stub it so boot can continue.
// Protect method definitions named `import` (e.g. `async import(...)`).
code = code.replace(/\basync\s+import\s*\(/g, 'async __UCD_IMPORT_METHOD__(')
code = code.replace(/(^|[^.\w$])import\s*\(/gm, '$1__ucdDynamicImport(')
code = code.replace(/\basync\s+__UCD_IMPORT_METHOD__\s*\(/g, 'async import(')

// Vite preload helper injects <link modulepreload/stylesheet> for chunks that
// are already inside this bundle — on file:// that hits CORS and aborts boot.
// Replace its exported preload fn `n` with a no-op that just runs the importer.
{
  const marker = '"dist/assets/preload-helper-'
  const idx = code.indexOf(marker)
  if (idx < 0) {
    console.warn('warning: preload-helper module not found — CSS preload may still fail on file://')
  } else {
    // Inside the helper factory, `n = function(n26, r25, i25) { ... }`
    const nAssign = code.indexOf('\n    n = function(', idx)
    if (nAssign < 0) {
      console.warn('warning: could not locate preload helper n=function')
    } else {
      // Find matching closing of that function assignment ending at `;\n  }\n});`
      // Replace from `n = function(` through the end of that function body.
      const start = nAssign + 1 // skip leading newline
      let depth = 0
      let i = code.indexOf('{', start)
      let end = -1
      for (; i < code.length; i++) {
        const ch = code[i]
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            end = i + 1
            // consume trailing `;` if present
            if (code[end] === ';') end++
            break
          }
        }
      }
      if (end < 0) {
        console.warn('warning: failed to parse preload helper function bounds')
      } else {
        const stub =
          'n = function(n26) {\n' +
          '      // classic bundle: deps already inlined — skip link preload\n' +
          '      return Promise.resolve().then(function(){ return n26(); });\n' +
          '    };'
        code = code.slice(0, start) + stub + code.slice(end)
        console.log('==> stubbed Vite preload helper (no file:// CSS/modulepreload)')
      }
    }
  }
}

// Strip ESM exports so we can wrap as classic script
code = code.replace(/^export\s*\{[^;]*\}\s*;?\s*$/gm, '')
code = code.replace(/\bexport\s+default\b/g, '/* export default */')
code = code.replace(/\bexport\s+(async\s+)?function\b/g, '$1function')
code = code.replace(/\bexport\s+(const|let|var|class)\b/g, '$1')

const iife = `${workerPrelude}
${wasmPrelude}
${assetPrelude}
(async function __ucdWorkbenchMain() {
"use strict";
${code}
})().catch(function(err){
  console.error('[UCD classic bundle]', err);
  var d=document.createElement('pre');
  d.style.cssText='padding:24px;color:#f88;white-space:pre-wrap;background:#1e1e1e';
  d.textContent=String(err && err.stack || err);
  document.body.appendChild(d);
});
`

const bundlePath = path.join(outDir, 'workbench.bundle.js')
fs.writeFileSync(bundlePath, iife)
console.log('wrote', bundlePath, `(${(Buffer.byteLength(iife) / 1024 / 1024).toFixed(1)} MiB)`)

// Copy v86 + file:// packs when requested (large).
if (process.argv.includes('--with-v86')) {
  const v86Src = path.join(dist, 'v86')
  if (fs.existsSync(v86Src)) {
    console.log('==> copy v86 assets into dist-classic/v86')
    fs.cpSync(v86Src, path.join(outDir, 'v86'), { recursive: true })
  } else {
    console.warn('warning: dist/v86 missing — run vite build first')
  }

  const vfsName = 'alpine-vfs.js'
  const vfsOut = path.join(outDir, vfsName)
  let vfsSrc = [path.join(publishDir, vfsName), path.join(appRoot, 'offline', vfsName)].find((p) =>
    fs.existsSync(p)
  )
  if (vfsSrc == null) {
    const alpineFs = path.join(repoRoot, 'v86/images/alpine-fs.json')
    const gen = path.join(appRoot, 'offline/make-alpine-vfs.py')
    if (fs.existsSync(alpineFs) && fs.existsSync(gen)) {
      console.log('==> generate alpine-vfs.js')
      execFileSync('python3', [gen], { stdio: 'inherit', cwd: repoRoot })
      vfsSrc = path.join(publishDir, vfsName)
    }
  }
  if (vfsSrc == null || !fs.existsSync(vfsSrc)) {
    throw new Error('missing alpine-vfs.js — run: bash scripts/setup-v86.sh')
  }
  console.log('==> copy alpine-vfs.js from', path.relative(repoRoot, vfsSrc))
  fs.copyFileSync(vfsSrc, vfsOut)

  // wasm + BIOS as classic script (XHR of .wasm is CORS-blocked on file://)
  const wasmFile = path.join(outDir, 'v86/build/v86.wasm')
  const biosFile = path.join(outDir, 'v86/bios/seabios.bin')
  const vgaFile = path.join(outDir, 'v86/bios/vgabios.bin')
  if (fs.existsSync(wasmFile) && fs.existsSync(biosFile) && fs.existsSync(vgaFile)) {
    console.log('==> write v86-runtime-assets.js (wasm/bios data URLs)')
    const runtime = `/* auto-generated for classic file:// v86 boot */
(function (g) {
  g.__UCD_V86_RUNTIME__ = {
    WASM_B64: ${JSON.stringify(b64(wasmFile))},
    BIOS_B64: ${JSON.stringify(b64(biosFile))},
    VGA_B64: ${JSON.stringify(b64(vgaFile))}
  };
})(typeof window !== 'undefined' ? window : globalThis);
`
    fs.writeFileSync(path.join(outDir, 'v86-runtime-assets.js'), runtime)
    console.log(
      `  wrote v86-runtime-assets.js (${(Buffer.byteLength(runtime) / 1024 / 1024).toFixed(1)} MiB)`
    )
  } else {
    console.warn('warning: cannot write v86-runtime-assets.js (missing wasm/bios)')
  }

  // Alpine 9p + wasm/bios are already in alpine-vfs.js / v86-runtime-assets.js.
  // Keep only libv86.js for the emulator runtime.
  const v86Dir = path.join(outDir, 'v86')
  const libv86 = path.join(v86Dir, 'build/libv86.js')
  if (fs.existsSync(libv86)) {
    const libBytes = fs.readFileSync(libv86)
    fs.rmSync(v86Dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(v86Dir, 'build'), { recursive: true })
    fs.writeFileSync(path.join(v86Dir, 'build/libv86.js'), libBytes)
    console.log('==> slim v86/ → build/libv86.js only')
  }
} else {
  console.log('==> skip v86 copy (pass --with-v86 to include)')
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UCDVSC</title>
  <style>
    html, body { margin: 0; height: 100%; background: #1e1e1e; color: #ccc; }
    #ucd-boot {
      font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      padding: 20px 24px; color: #9cdcfe;
    }
  </style>
  <script>
    (function () {
      if (!location.search) return;
      var p = new URLSearchParams(location.search);
      var changed = false;
      if (p.get('mode') === 'full-workbench') { p.delete('mode'); changed = true; }
      if (p.get('ucdTransport') === 'tcp') { p.delete('ucdTransport'); changed = true; }
      if (!changed) return;
      var q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    })();
  </script>
</head>
<body>
  <div id="ucd-boot">Loading UCDVSC…</div>
  <!-- Route 1: classic script — no type="module", no file:// module CORS -->
  <script src="./workbench.bundle.js"></script>
</body>
</html>
`
fs.writeFileSync(path.join(outDir, 'ucdvsc.html'), html)
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# UCDVSC

Open [ucdvsc.html](ucdvsc.html).

First time: Command Palette → **UCDVSC: Bind Disk Folder…**, pick this folder.

Snapshot: \`guest-disk/v86state.bin\` (tab close / every 45s / Save VM Snapshot). Reopen to restore RAM, processes, and filesystem.
`
)

// cleanup intermediate
fs.unlinkSync(esmPath)

// Publish clean runnable tree → UCD/ucdVscode/
console.log('==> publish →', publishDir)
fs.mkdirSync(publishDir, { recursive: true })
const publishNames = [
  'ucdvsc.html',
  'workbench.bundle.js',
  'v86-runtime-assets.js',
  'alpine-vfs.js',
  'v86',
  'README.md'
]
for (const name of publishNames) {
  const src = path.join(outDir, name)
  const dst = path.join(publishDir, name)
  if (!fs.existsSync(src)) {
    console.warn('  skip missing', name)
    continue
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
  console.log('  +', name)
}

function removeShippedGuestDiskStub(root) {
  const dir = path.join(root, 'guest-disk')
  if (!fs.existsSync(dir)) {
    return
  }
  if (fs.existsSync(path.join(dir, 'v86state.bin'))) {
    console.log('  keep guest-disk/ (VM snapshot present)')
    return
  }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('  - guest-disk/ (not shipped)')
}
removeShippedGuestDiskStub(outDir)
removeShippedGuestDiskStub(publishDir)
fs.rmSync(path.join(outDir, 'index.html'), { force: true })
fs.rmSync(path.join(publishDir, 'index.html'), { force: true })
fs.rmSync(path.join(publishDir, '请读我.txt'), { force: true })
fs.rmSync(path.join(outDir, 'README.txt'), { force: true })
fs.rmSync(path.join(publishDir, 'README.txt'), { force: true })
fs.rmSync(path.join(publishDir, 'UCDVsc.zip'), { force: true })
fs.rmSync(path.join(outDir, 'try-offline-vfs.js'), { force: true })
fs.rmSync(path.join(publishDir, 'try-offline-vfs.js'), { force: true })
console.log('done →', publishDir)
