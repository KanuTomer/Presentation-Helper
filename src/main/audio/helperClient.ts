import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

type HelperEvent = { type: string; requestId?: string; path?: string; message?: string; [key: string]: unknown }

export class HelperClient {
  private process?: ChildProcessWithoutNullStreams
  private callbacks = new Map<string, (event: HelperEvent) => void>()
  onShortcutDown?: () => void
  onShortcutUp?: () => void
  onUnexpectedExit?: () => void

  get available(): boolean { return Boolean(this.process && !this.process.killed) }
  start(): boolean {
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'windows-helper', 'PresenterAI.WindowsHelper.exe')
      : join(app.getAppPath(), 'resources', 'windows-helper', 'PresenterAI.WindowsHelper.exe')
    if (!existsSync(executable)) return false
    this.process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      try {
        const event = JSON.parse(line) as HelperEvent
        if (event.type === 'shortcutDown') this.onShortcutDown?.()
        else if (event.type === 'shortcutUp') this.onShortcutUp?.()
        if (event.requestId) this.callbacks.get(event.requestId)?.(event)
      } catch { /* helper stderr carries diagnostics; malformed stdout is ignored */ }
    })
    this.process.once('exit', () => { this.process = undefined; this.onUnexpectedExit?.() })
    this.send({ type: 'hello', requestId: randomUUID(), protocolVersion: 1 })
    return true
  }
  stopProcess(): void { this.process?.kill(); this.process = undefined }
  command(command: Record<string, unknown>, terminalTypes: string[]): Promise<HelperEvent> {
    if (!this.process) return Promise.reject(new Error('Windows audio helper is unavailable. Run npm run helper:build after installing .NET 8.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.callbacks.delete(requestId); reject(new Error('Windows helper timed out.')) }, 15_000)
      this.callbacks.set(requestId, (event) => {
        if (!terminalTypes.includes(event.type)) return
        clearTimeout(timer); this.callbacks.delete(requestId)
        if (event.type === 'error') reject(new Error(event.message ?? 'Windows helper failed.')); else resolve(event)
      })
      this.send({ ...command, requestId })
    })
  }
  private send(value: Record<string, unknown>): void { this.process?.stdin.write(`${JSON.stringify(value)}\n`) }
}
