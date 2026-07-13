import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HelperLifecycle } from '../../shared/contracts.js'

export interface HelperEvent { type: string; requestId?: string; code?: string; message?: string; protocolVersion?: number; features?: string[]; [key: string]: unknown }

export class HelperClient {
  private process?: ChildProcessWithoutNullStreams
  private callbacks = new Map<string, (event: HelperEvent) => void>()
  private stopping = false
  state: HelperLifecycle = 'missing'
  lastError?: string
  features: string[] = []
  onShortcutDown?: () => void
  onShortcutUp?: () => void
  onUnexpectedExit?: () => void
  onState?: () => void

  get available(): boolean { return this.state === 'ready' || this.state === 'capturing' }
  async start(): Promise<boolean> {
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'windows-helper', 'PresenterAI.WindowsHelper.exe')
      : join(app.getAppPath(), 'resources', 'windows-helper', 'PresenterAI.WindowsHelper.exe')
    if (!existsSync(executable)) { this.setState('missing', 'Windows audio helper is not installed.'); return false }
    this.setState('starting')
    this.stopping = false
    this.process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    createInterface({ input: this.process.stdout }).on('line', (line) => this.handleLine(line))
    createInterface({ input: this.process.stderr }).on('line', (line) => { this.lastError = line.slice(0, 600); this.onState?.() })
    this.process.once('exit', (_code, signal) => {
      const expected = this.stopping
      this.process = undefined
      for (const callback of this.callbacks.values()) callback({ type: 'error', code: 'helper_exited', message: 'Windows helper exited before replying.' })
      this.callbacks.clear()
      if (!expected) { this.setState('failed', `Windows helper exited unexpectedly${signal ? ` (${signal})` : ''}.`); this.onUnexpectedExit?.() }
    })
    try {
      const hello = await this.command({ type: 'hello', protocolVersion: 1 }, ['ready', 'error'], 5_000)
      if (hello.protocolVersion !== 1) throw new Error(`Unsupported helper protocol ${hello.protocolVersion ?? 'unknown'}.`)
      this.features = Array.isArray(hello.features) ? hello.features.map(String) : []
      this.setState('ready'); return true
    } catch (error) { this.setState('failed', (error as Error).message); this.process?.kill(); return false }
  }
  async stopProcess(): Promise<void> {
    if (!this.process) return
    this.stopping = true
    await this.command({ type: 'shutdown' }, ['shutdownComplete', 'error'], 2_000).catch(() => undefined)
    const process = this.process
    setTimeout(() => { if (process && !process.killed) process.kill() }, 500)
    this.process = undefined; this.setState('missing')
  }
  command(command: Record<string, unknown>, terminalTypes: string[], timeoutMs = 15_000): Promise<HelperEvent> {
    if (!this.process) return Promise.reject(new Error('Windows audio helper is unavailable.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.callbacks.delete(requestId); reject(new Error('Windows helper timed out.')) }, timeoutMs)
      this.callbacks.set(requestId, (event) => {
        if (!terminalTypes.includes(event.type)) return
        clearTimeout(timer); this.callbacks.delete(requestId)
        if (event.type === 'error') reject(new Error(event.message ?? 'Windows helper failed.')); else resolve(event)
      })
      this.process!.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`)
    })
  }
  setLifecycle(state: HelperLifecycle): void { this.setState(state) }
  private handleLine(line: string): void {
    try {
      const event = JSON.parse(line) as HelperEvent
      if (event.type === 'shortcutDown') this.onShortcutDown?.()
      else if (event.type === 'shortcutUp') this.onShortcutUp?.()
      if (event.requestId) this.callbacks.get(event.requestId)?.(event)
    } catch { this.lastError = 'The Windows helper emitted an invalid protocol message.'; this.onState?.() }
  }
  private setState(state: HelperLifecycle, error?: string): void { this.state = state; this.lastError = error; this.onState?.() }
}
