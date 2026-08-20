/**
 * ucd-v86-compile extension: contributes the Run/snapshot/debug commands and
 * wires the status bar + output channel to a V86Compiler instance. Registered
 * before initializeMonacoService (builtin extension-host snapshot).
 */
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  GUEST_WORK,
  guestRpc,
  guestWrite,
  isGuestControlReady,
  vscodePathToGuest
} from './guestBridge'
import { getGuestFs } from './guestFsProvider'
import {
  clearGuestWorkspacePersist,
  bindGuestDiskFolder,
  persistGuestWorkspaceAfterBind,
  setGuestDiskBindPrompt,
  saveVmStateNow,
  loadLastGuestDiskSaveMeta,
  onGuestDiskSaved,
  getLastGuestDiskSave,
  type GuestDiskSaveInfo
} from './guestFsPersist'
import { registerGuestLanguageServers } from './lsp'
import { registerGuestDebugger } from './debug'
import { V86Compiler } from './v86Compiler'

const compiler = new V86Compiler()

const { getApi, registerFileUrl } = registerExtension(
    {
      name: 'ucd-v86-compile',
      publisher: 'ucd',
      version: '1.0.0',
      engines: {
        vscode: '*'
      },
      browser: 'extension.js',
      activationEvents: ['*'],
      contributes: {
        commands: [
          {
            command: 'ucd.v86.run',
            title: 'Run C in Alpine',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.bindGuestDisk',
            title: 'Bind Disk Folder…',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.saveVmState',
            title: 'Save VM Snapshot',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.v86.clearPersistedWorkspace',
            title: 'Clear VM Snapshot',
            category: 'UCDVSC'
          },
          {
            command: 'ucd.debug.toggleBreakpoint',
            title: 'Toggle Breakpoint',
            category: 'UCDVSC'
          }
        ],
        keybindings: [
          {
            command: 'ucd.v86.run',
            key: 'ctrl+alt+b',
            mac: 'cmd+alt+b',
            when: 'editorTextFocus'
          },
          {
            command: 'ucd.debug.toggleBreakpoint',
            key: 'f9',
            when: 'editorTextFocus'
          }
        ],
        debuggers: [
          {
            type: 'ucd-gdb',
            label: 'UCD GDB (Alpine guest)',
            languages: ['c', 'cpp'],
            ...({ breakpoints: [{ language: 'c' }, { language: 'cpp' }] } as object),
            configurationAttributes: {
              launch: {
                required: ['program'],
                properties: {
                  program: {
                    type: 'string',
                    description: 'Path to the C/C++ source file to debug (guest workspace).',
                    default: '${file}'
                  },
                  stopOnEntry: {
                    type: 'boolean',
                    description: 'Stop at program entry.',
                    default: true
                  }
                }
              }
            },
            initialConfigurations: [
              {
                type: 'ucd-gdb',
                request: 'launch',
                name: 'Debug C in Alpine',
                program: '${file}',
                stopOnEntry: false
              }
            ]
          }
        ]
      }
    },
    ExtensionHostKind.LocalProcess,
    { system: true }
  )

  registerFileUrl('./extension.js', 'data:text/javascript;base64,' + window.btoa('// ucd-v86-compile'))

  void getApi().then(async (vscode) => {
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    status.text = '$(vm) Alpine: booting…'
    status.tooltip = 'Run C in Alpine (Ctrl+Alt+B / Cmd+Alt+B)'
    status.command = 'ucd.v86.run'
    status.show()

    const saveStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    saveStatus.command = 'ucd.v86.saveVmState'
    saveStatus.show()

    const channel = vscode.window.createOutputChannel('Alpine / v86')

    const formatSaveClock = (ms: number): string =>
      new Date(ms).toLocaleTimeString('en-US', { hour12: false })
    const formatSaveFull = (ms: number): string =>
      new Date(ms).toLocaleString('en-US', { hour12: false })

    const paintSaveStatus = (info: GuestDiskSaveInfo | null = getLastGuestDiskSave()): void => {
      if (info == null) {
        saveStatus.text = '$(history) Snapshot: —'
        saveStatus.tooltip =
          'No VM snapshot yet. Bind a disk folder to auto-save. Click to save now.'
        return
      }
      const size =
        typeof info.byteLength === 'number'
          ? `\nSize: ${(info.byteLength / (1024 * 1024)).toFixed(1)} MiB`
          : ''
      const kind = info.source === 'vm' ? 'VM snapshot' : 'workspace'
      saveStatus.text = `$(history) Saved ${formatSaveClock(info.savedAt)}`
      saveStatus.tooltip =
        `Last auto-save (${kind}): ${formatSaveFull(info.savedAt)}${size}\nClick to save VM snapshot now.`
    }
    paintSaveStatus()
    onGuestDiskSaved((info) => {
      paintSaveStatus(info)
      if (info.source !== 'vm') {
        return
      }
      channel.appendLine(
        `disk saved @ ${formatSaveFull(info.savedAt)}` +
          (info.byteLength != null
            ? ` (${(info.byteLength / (1024 * 1024)).toFixed(1)} MiB)`
            : '')
      )
    })

    const setStatus = (msg: string) => {
      status.text = `$(vm) ${msg}`
      channel.appendLine(msg)
    }

    async function bindDiskFromUi(): Promise<boolean> {
      try {
        await bindGuestDiskFolder()
        const r = await persistGuestWorkspaceAfterBind()
        paintSaveStatus()
        if (r.files > 0 || r.stateBytes > 0) {
          void vscode.window.showInformationMessage(
            `Disk folder bound. Workspace ${r.files} files, snapshot ${(r.stateBytes / (1024 * 1024)).toFixed(1)} MiB.`
          )
        } else {
          void vscode.window.showInformationMessage(
            'Disk folder bound. The VM snapshot will be saved here automatically.'
          )
        }
        return true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        void vscode.window.showErrorMessage('Failed to bind disk folder: ' + msg)
        return false
      }
    }

    setGuestDiskBindPrompt(() => {
      void vscode.window
        .showWarningMessage(
          'Bind a disk folder so UCDVSC can save the VM snapshot. Pick the ucdVscode folder.',
          'Bind Disk Folder…'
        )
        .then(async (choice) => {
          if (choice === 'Bind Disk Folder…') {
            await bindDiskFromUi()
          }
        })
    })

    async function syncDocument(doc: { uri: { fsPath: string; scheme: string }; getText: () => string }) {
      if (doc.uri.scheme !== 'file' || !isGuestControlReady()) {
        return
      }
      const rel = vscodePathToGuest(doc.uri.fsPath)
      if (rel == null || rel === '.') {
        return
      }
      await guestWrite(rel, doc.getText())
      channel.appendLine(`synced → guest:${rel}`)
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Connecting to guest',
          cancellable: false
        },
        async () => {
          await compiler.start(setStatus)
          await compiler.waitUntilReady()
        }
      )
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setStatus(`boot failed: ${err}`)
      void vscode.window.showErrorMessage(`v86 boot failed: ${err}`)
    }

    if (compiler.isReady) {
      void vscode.window.showInformationMessage('Connected to guest')
      setStatus('Alpine ready')
      void loadLastGuestDiskSaveMeta().then(() => paintSaveStatus())

      if (isGuestControlReady()) {
        try {
          await guestRpc({ op: 'mkdir', path: '.' })
          getGuestFs()?.notifyChanged()
          channel.appendLine('explorer: live guest FS ready (file:///workspace → /root/workspace)')
          registerGuestLanguageServers(vscode, (msg) => channel.appendLine(msg))
          void registerGuestDebugger(vscode, (msg) => channel.appendLine(msg))
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file('/workspace/main.c')
            )
            await vscode.window.showTextDocument(doc, { preview: false })
          } catch {
            /* main.c may not exist yet */
          }
        } catch (e) {
          channel.appendLine('guest fs ready hook: ' + String(e))
        }
      }
    }

    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Live guest FS writeFile already wrote the bytes and scheduled persist.
      if (isGuestControlReady()) {
        return
      }
      void syncDocument(doc).catch((e) => {
        channel.appendLine('save sync failed: ' + String(e))
      })
    })

    // main.c opened after guest ready (see start hook above)

    vscode.commands.registerCommand('ucd.v86.bindGuestDisk', () => bindDiskFromUi())

    vscode.commands.registerCommand('ucd.v86.saveVmState', async () => {
      try {
        const bytes = await saveVmStateNow(true)
        if (bytes <= 0) {
          void vscode.window.showWarningMessage(
            'Snapshot was not written. Bind a disk folder first and wait until Alpine is ready.'
          )
          return
        }
        void vscode.window.showInformationMessage(
          `Saved VM snapshot ${(bytes / (1024 * 1024)).toFixed(1)} MiB → guest-disk/v86state.bin`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        void vscode.window.showErrorMessage('Failed to save VM snapshot: ' + msg)
      }
    })

    vscode.commands.registerCommand('ucd.v86.clearPersistedWorkspace', async () => {
      await clearGuestWorkspacePersist()
      void vscode.window.showInformationMessage(
        'Cleared guest-disk snapshot and workspace overlay. Next open will cold-boot Alpine (this session stays as-is).'
      )
    })

    // ── VS Code-style run: build + execute in the integrated terminal ────────
    type RunDoc = { uri: { fsPath: string; scheme: string }; getText: () => string }
    let runTerminal: import('vscode').Terminal | null = null
    vscode.window.onDidCloseTerminal((t) => {
      if (t === runTerminal) {
        runTerminal = null
      }
    })

    const shQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

    function buildRunCommand(guestPath: string): string | null {
      const slash = guestPath.lastIndexOf('/')
      const dir = slash > 0 ? guestPath.slice(0, slash) : GUEST_WORK
      const base = guestPath.slice(slash + 1)
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
      const cd = `cd ${shQuote(dir)}`
      const bin = shQuote('./' + stem)
      if (ext === 'c') {
        return `${cd} && gcc -g ${shQuote(base)} -o ${shQuote(stem)} && ${bin}`
      }
      if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c++') {
        return `${cd} && g++ -g ${shQuote(base)} -o ${shQuote(stem)} && ${bin}`
      }
      if (ext === 'py') {
        return `${cd} && python3 ${shQuote(base)}`
      }
      if (ext === 'sh') {
        return `${cd} && sh ${shQuote(base)}`
      }
      return null
    }

    async function runInIntegratedTerminal(doc: RunDoc): Promise<boolean> {
      const guest = vscodePathToGuest(doc.uri.fsPath)
      if (guest == null) {
        return false
      }
      const cmd = buildRunCommand(guest)
      if (cmd == null) {
        return false
      }
      try {
        await syncDocument(doc)
      } catch {
        /* the on-disk copy may already be current */
      }
      const created = runTerminal == null
      if (runTerminal == null) {
        runTerminal = vscode.window.createTerminal({ name: 'UCDVSC Run' })
      }
      runTerminal.show(true)
      // A freshly spawned terminal is still attaching to the guest shell PTY;
      // wait a beat before sending or the first keystrokes are dropped.
      if (created) {
        await new Promise((r) => window.setTimeout(r, 900))
      }
      runTerminal.sendText(cmd, true)
      return true
    }

    vscode.commands.registerCommand('ucd.v86.run', async () => {
      const editor = vscode.window.activeTextEditor
      if (editor == null) {
        void vscode.window.showWarningMessage('No active editor')
        return
      }
      if (!compiler.isReady) {
        void vscode.window.showWarningMessage('Alpine guest is still booting')
        return
      }
      // Prefer the integrated terminal (real stdout/stderr, stdin, exit code).
      if (isGuestControlReady()) {
        const ran = await runInIntegratedTerminal(editor.document).catch((e) => {
          channel.appendLine('terminal run failed: ' + String(e))
          return false
        })
        if (ran) {
          const name = editor.document.uri.fsPath.split('/').pop() ?? ''
          setStatus(`Running ${name} in terminal`)
          return
        }
        // Unsupported language for terminal run → fall back to the C runner.
      }
      const code = editor.document.getText()
      // Always try to persist before compile when TCP is up
      if (isGuestControlReady()) {
        try {
          await syncDocument(editor.document)
        } catch {
          /* compile may still work via payload */
        }
      }
      channel.show(true)
      channel.appendLine(`——— run (${compiler.activeTransport}) ———`)
      try {
        const result = await compiler.compile(code, setStatus)
        channel.append(result.body)
        if (!result.body.endsWith('\n')) {
          channel.appendLine('')
        }
        channel.appendLine(`[via ${result.via}]`)
        if (result.failed) {
          setStatus(`Finished with errors (exit ${result.exitCode}, ${result.via})`)
          void vscode.window.showErrorMessage(`Compile/run failed (exit ${result.exitCode})`)
        } else {
          setStatus(`Finished (exit ${result.exitCode}, ${result.via})`)
          /* success: status bar + output channel are enough */
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        setStatus(`error: ${err}`)
        void vscode.window.showErrorMessage(err)
      }
    })
  }).catch((e) => {
    console.error('[UCD] v86 extension API failed', e)
    const bar = document.createElement('div')
    bar.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:8px 16px;background:#5a1d1d;color:#f48771;font:13px/1.4 ui-sans-serif,system-ui,sans-serif'
    bar.textContent =
      'Alpine/v86 failed to start: ' + (e instanceof Error ? e.message : String(e))
    document.body.appendChild(bar)
  })
