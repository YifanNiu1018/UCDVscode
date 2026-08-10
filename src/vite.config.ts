import { defineConfig } from 'vite'
import * as fs from 'fs'
import path from 'path'
import vsixPlugin from '@codingame/monaco-vscode-rollup-vsix-plugin'

const v86Root = path.resolve(__dirname, '../v86')

export default defineConfig({
  // Relative base so dist/ can be opened as a folder (file:// or any static host)
  base: './',
  build: {
    target: 'esnext'
  },
  worker: {
    format: 'es'
  },
  plugins: [
    vsixPlugin(),
    {
      name: 'load-vscode-css-as-string',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        const resolved = (await this.resolve(source, importer, options))!
        if (
          resolved.id.match(
            /node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/
          )
        ) {
          return {
            ...resolved,
            id: resolved.id + '?inline'
          }
        }
        return undefined
      }
    },
    {
      // For the *-language-features extensions which use SharedArrayBuffer
      name: 'configure-response-headers',
      apply: 'serve',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
          next()
        })
      },
      configurePreviewServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
          next()
        })
      }
    },
    {
      name: 'serve-v86-assets',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/v86', (req, res, next) => {
          const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
          const file = path.normalize(path.join(v86Root, urlPath))
          if (!file.startsWith(v86Root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            next()
            return
          }
          const ext = path.extname(file).toLowerCase()
          const types: Record<string, string> = {
            '.js': 'application/javascript',
            '.wasm': 'application/wasm',
            '.json': 'application/json',
            '.bin': 'application/octet-stream',
            '.zst': 'application/octet-stream'
          }
          res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
          fs.createReadStream(file).pipe(res)
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use('/v86', (req, res, next) => {
          const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
          const distV86 = path.resolve(__dirname, 'dist/v86')
          const fromDist = path.normalize(path.join(distV86, urlPath))
          const fromRepo = path.normalize(path.join(v86Root, urlPath))
          const file =
            fromDist.startsWith(distV86) && fs.existsSync(fromDist) && fs.statSync(fromDist).isFile()
              ? fromDist
              : fromRepo.startsWith(v86Root) &&
                  fs.existsSync(fromRepo) &&
                  fs.statSync(fromRepo).isFile()
                ? fromRepo
                : null
          if (file == null) {
            next()
            return
          }
          const ext = path.extname(file).toLowerCase()
          const types: Record<string, string> = {
            '.js': 'application/javascript',
            '.wasm': 'application/wasm',
            '.json': 'application/json',
            '.bin': 'application/octet-stream',
            '.zst': 'application/octet-stream'
          }
          res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
          fs.createReadStream(file).pipe(res)
        })
      }
    },
    {
      name: 'copy-v86-into-dist',
      apply: 'build',
      closeBundle() {
        const dest = path.resolve(__dirname, 'dist/v86')
        const copy = (from: string, to: string) => {
          if (!fs.existsSync(from)) {
            console.warn('[copy-v86] missing', from)
            return
          }
          fs.mkdirSync(path.dirname(to), { recursive: true })
          fs.cpSync(from, to, { recursive: true })
        }
        console.log('[copy-v86] copying Alpine assets into dist/v86 …')
        copy(path.join(v86Root, 'build'), path.join(dest, 'build'))
        copy(path.join(v86Root, 'bios'), path.join(dest, 'bios'))
        copy(
          path.join(v86Root, 'images/alpine-fs.json'),
          path.join(dest, 'images/alpine-fs.json')
        )
        copy(
          path.join(v86Root, 'images/alpine-rootfs-flat'),
          path.join(dest, 'images/alpine-rootfs-flat')
        )
        console.log('[copy-v86] done')
      }
    }
  ],
  esbuild: {
    minifySyntax: false
  },
  optimizeDeps: {
    include: [
      '@codingame/monaco-vscode-api/extensions',
      '@codingame/monaco-vscode-api',
      '@codingame/monaco-vscode-api/monaco',
      'vscode/localExtensionHost',
      '@vscode/vscode-languagedetection',
      'marked'
    ],
    exclude: []
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    fs: {
      allow: [v86Root, __dirname]
    }
  },
  resolve: {
    dedupe: ['vscode', 'monaco-editor']
  }
})
