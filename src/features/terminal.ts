import {
  ITerminalChildProcess,
  SimpleTerminalBackend,
  SimpleTerminalProcess
} from '@codingame/monaco-vscode-terminal-service-override'
import ansiColors from 'ansi-colors'
import * as vscode from 'vscode'
import {
  connectGuestShell,
  isGuestControlReady,
  onGuestControlReady,
  type TcpConn
} from './guestBridge'
import { getGuestFs } from './guestFsProvider'

/**
 * Workbench terminal → guest shell on TCP :1235.
 * Prefer PTY (`script`); otherwise line-mode with sticky cwd (cd works).
 */
export class TerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> =>
    isGuestControlReady() ? '/bin/sh' : 'fake'

  override createProcess = async (): Promise<ITerminalChildProcess> => {
    const dataEmitter = new vscode.EventEmitter<string>()

    class GuestOrFakeTerminalProcess extends SimpleTerminalProcess {
      private conn: TcpConn | null = null
      private fakeMode = true
      /** When true, echo keystrokes locally (line-mode). PTY echoes remotely. */
      private localEcho = true
      private column = 0
      private unsubReady: (() => void) | null = null
      private decoder = new TextDecoder()
      private seenBanner = ''

      async start(): Promise<undefined> {
        ansiColors.enabled = true
        if (isGuestControlReady()) {
          this.attachGuest()
        } else {
          this.fakeMode = true
          dataEmitter.fire(`${ansiColors.yellow('Waiting for Alpine…')}\r\n`)
          this.unsubReady = onGuestControlReady((ready) => {
            if (ready && this.fakeMode && this.conn == null) {
              this.attachGuest()
            }
          })
        }
        return undefined
      }

      private attachGuest(): void {
        try {
          this.conn = connectGuestShell()
          this.fakeMode = false
          this.localEcho = true
          this.seenBanner = ''

          this.conn.on('connect', () => {
            /* silent */
          })
          this.conn.on('data', (data: unknown) => {
            const u8 =
              data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
            let text = this.decoder.decode(u8, { stream: true })
            this.seenBanner += text
            if (this.seenBanner.includes('__UCD_PTY__') || this.seenBanner.includes('PTY via script')) {
              this.localEcho = false
            }
            if (
              this.seenBanner.includes('__UCD_LINE__') ||
              this.seenBanner.includes('line mode') ||
              this.seenBanner.includes('sticky cwd')
            ) {
              this.localEcho = true
            }
            text = text
              .replace(/__UCD_PTY__\r?\n?/g, '')
              .replace(/__UCD_LINE__\r?\n?/g, '')
            // Heuristic: after mkdir/touch in guest, nudge explorer
            if (/\b(mkdir|touch|rm|mv|cp)\b/.test(this.seenBanner.slice(-200))) {
              getGuestFs()?.notifyChanged()
            }
            if (text.length > 0) {
              dataEmitter.fire(text)
            }
          })
          this.conn.on('close', () => {
            dataEmitter.fire(`\r\n${ansiColors.yellow('[guest shell closed]')}\r\n`)
            this.conn = null
            getGuestFs()?.notifyChanged()
          })
          this.conn.on('shutdown', () => {
            dataEmitter.fire(`\r\n${ansiColors.yellow('[guest shell shutdown]')}\r\n`)
            this.conn = null
          })
        } catch (e) {
          this.fakeMode = true
          dataEmitter.fire(
            `${ansiColors.red('Guest shell failed: ' + String(e))}\r\n${ansiColors.green('$')} `
          )
          this.column = 2
        }
      }

      override shutdown(): void {
        this.unsubReady?.()
        this.unsubReady = null
        try {
          this.conn?.close()
        } catch {
          /* ignore */
        }
        this.conn = null
      }

      override input(data: string): void {
        if (!this.fakeMode && this.conn != null) {
          let echo = ''
          let toGuest = ''
          for (const c of data) {
            const code = c.charCodeAt(0)
            if (c === '\r') {
              if (this.localEcho) {
                echo += '\r\n'
              }
              toGuest += '\n'
            } else if (code === 127 || c === '\b') {
              if (this.localEcho) {
                echo += '\b \b'
              }
              toGuest += '\x7f'
            } else {
              if (this.localEcho) {
                echo += c
              }
              toGuest += c
            }
          }
          if (echo.length > 0) {
            dataEmitter.fire(echo)
          }
          if (toGuest.length > 0) {
            this.conn.write(new TextEncoder().encode(toGuest))
          }
          return
        }
        for (const c of data) {
          if (c.charCodeAt(0) === 13) {
            dataEmitter.fire(`\r\n${ansiColors.green('$')} `)
            this.column = 2
          } else if (c.charCodeAt(0) === 127) {
            if (this.column > 2) {
              dataEmitter.fire('\b \b')
              this.column--
            }
          } else {
            dataEmitter.fire(c)
            this.column++
          }
        }
      }

      resize(_cols: number, _rows: number): void {}

      override clearBuffer(): void | Promise<void> {}

      override sendSignal(): void {}
    }

    return new GuestOrFakeTerminalProcess(1, 1, '/root/workspace', dataEmitter.event)
  }
}
