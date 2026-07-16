import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HelperLifecycle } from '../../shared/contracts.js'

export const HELPER_PROTOCOL_VERSION = 2
const REQUIRED_FEATURES = [
  'wasapi-system-loopback', 'device-selection', 'hold-shortcut', 'pcm16k-mono',
  'hook-ready', 'single-file-capture', 'bounded-capture', 'capture-limit-events', 'operation-ids'
] as const

export interface HelperEvent {
  type: string
  requestId?: string
  operationId?: string
  code?: string
  message?: string
  protocolVersion?: number
  features?: string[]
  fatal?: boolean
  [key: string]: unknown
}

interface PendingRequest {
  terminalTypes: Set<string>
  complete(event: HelperEvent): void
}

export class HelperClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HelperClientError' }
}

export interface HelperClientOptions {
  executablePath?: () => string
  spawnProcess?: typeof spawn
  startupTimeoutMs?: number
}

export class HelperClient {
  private process?: ChildProcessWithoutNullStreams
  private callbacks = new Map<string, PendingRequest>()
  private stopping = false
  private starting?: Promise<boolean>
  private exited?: Promise<void>
  private resolveExit?: () => void
  private fatalError?: string
  state: HelperLifecycle = 'missing'
  lastError?: string
  features: string[] = []
  onShortcutDown?: () => void
  onShortcutUp?: () => void
  onCaptureLimitReached?: (operationId: string, reason: string) => void
  onUnexpectedExit?: () => void
  onState?: () => void

  constructor(private options: HelperClientOptions = {}) {}

  get available(): boolean { return this.state === 'ready' || this.state === 'capturing' }

  start(): Promise<boolean> {
    if (this.starting) return this.starting
    const attempt = this.startOnce().finally(() => {
      if (this.starting === attempt) this.starting = undefined
    })
    this.starting = attempt
    return attempt
  }

  private async startOnce(): Promise<boolean> {
    if (this.process) await this.stopProcess()
    const executable = this.options.executablePath?.() ?? (app.isPackaged
      ? join(process.resourcesPath, 'windows-helper', 'PresenterAI.WindowsHelper.exe')
      : join(app.getAppPath(), 'resources', 'windows-helper', 'PresenterAI.WindowsHelper.exe'))
    if (!existsSync(executable)) { this.setState('missing', 'Windows audio helper is not installed.'); return false }
    this.setState('starting')
    this.fatalError = undefined
    this.stopping = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = (this.options.spawnProcess ?? spawn)(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      this.setState('failed', 'Windows helper could not be launched.')
      return false
    }
    this.process = child
    this.exited = new Promise<void>((resolve) => { this.resolveExit = resolve })
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) this.lastError = line.trim().slice(0, 600)
      this.onState?.()
    })
    child.once('error', (error) => this.handleExit(child, undefined, undefined, error))
    child.once('exit', (code, signal) => this.handleExit(child, code, signal))
    try {
      // A freshly published self-contained .NET executable can spend tens of
      // seconds in first-run antivirus inspection. Keep this bounded, but do not
      // misclassify that cold start as a protocol failure.
      const hello = await this.command(
        { type: 'hello', protocolVersion: HELPER_PROTOCOL_VERSION },
        ['ready', 'error'],
        this.options.startupTimeoutMs ?? 60_000
      )
      if (hello.protocolVersion !== HELPER_PROTOCOL_VERSION) {
        throw new HelperClientError('protocol_mismatch', `Unsupported helper protocol ${hello.protocolVersion ?? 'unknown'}.`)
      }
      if (hello.shortcutReady !== true) {
        throw new HelperClientError('shortcut_hook_unavailable', 'The Windows helper keyboard hook is not ready.')
      }
      this.features = Array.isArray(hello.features) ? hello.features.map(String) : []
      const missing = REQUIRED_FEATURES.filter((feature) => !this.features.includes(feature))
      if (missing.length) throw new HelperClientError('feature_mismatch', `Windows helper is missing required features: ${missing.join(', ')}.`)
      this.setState('ready')
      return true
    } catch (error) {
      this.setState('failed', safeMessage(error, 'Windows helper failed to start.'))
      // A rejected handshake is an expected startup failure, not a later helper
      // crash. Mark the termination as intentional before killing the child so
      // its exit event cannot overwrite the actionable protocol/feature error.
      this.stopping = true
      if (this.process === child) child.kill()
      return false
    }
  }

  async stopProcess(): Promise<void> {
    const child = this.process
    if (!child) { this.setState('missing'); return }
    this.stopping = true
    await this.command({ type: 'shutdown' }, ['shutdownComplete', 'error'], 2_000).catch(() => undefined)
    const forced = setTimeout(() => { if (this.process === child && !child.killed) child.kill() }, 500)
    await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
    clearTimeout(forced)
    if (this.process === child && !child.killed) child.kill()
    this.process = undefined
    this.setState('missing')
  }

  command(command: Record<string, unknown>, terminalTypes: string[], timeoutMs = 15_000): Promise<HelperEvent> {
    const child = this.process
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new HelperClientError('helper_unavailable', 'Windows audio helper is unavailable.'))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let completed = false
      const finish = (event: HelperEvent): void => {
        if (completed) return
        completed = true
        clearTimeout(timer)
        this.callbacks.delete(requestId)
        if (event.type === 'error') reject(new HelperClientError(event.code ?? 'helper_error', safeProtocolMessage(event.message)))
        else resolve(event)
      }
      const timer = setTimeout(() => finish({ type: 'error', code: 'helper_timeout', message: 'Windows helper timed out.' }), timeoutMs)
      this.callbacks.set(requestId, { terminalTypes: new Set(terminalTypes), complete: finish })
      child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`, (error) => {
        if (error) finish({ type: 'error', code: 'helper_write_failed', message: 'PresenterAI could not send a command to the Windows helper.' })
      })
    })
  }

  setLifecycle(state: HelperLifecycle): void { this.setState(state) }
  setFailure(message: string): void { this.setState('failed', message.slice(0, 600)) }

  private handleLine(line: string): void {
    if (line.length > 65_536) { this.failProtocol('The Windows helper emitted an oversized protocol message.'); return }
    try {
      const event = JSON.parse(line) as HelperEvent
      if (!event || typeof event.type !== 'string') throw new Error('missing event type')
      if (event.type === 'error' && !event.requestId && event.fatal === true) {
        this.fatalError = event.code === 'shortcut_hook_unavailable'
          ? 'The Windows shortcut hook could not be installed. Check security software and retry the audio helper.'
          : safeProtocolMessage(event.message)
        this.lastError = this.fatalError
        this.onState?.()
      }
      if (event.type === 'shortcutDown') this.onShortcutDown?.()
      else if (event.type === 'shortcutUp') this.onShortcutUp?.()
      else if (event.type === 'captureLimitReached' && typeof event.operationId === 'string') {
        this.onCaptureLimitReached?.(event.operationId, typeof event.reason === 'string' ? event.reason : 'maximum_duration')
      }
      if (event.requestId) {
        const pending = this.callbacks.get(event.requestId)
        if (pending?.terminalTypes.has(event.type)) pending.complete(event)
      }
    } catch {
      this.failProtocol('The Windows helper emitted an invalid protocol message.')
    }
  }

  private failProtocol(message: string): void {
    const child = this.process
    if (!child) return
    const wasStarting = this.state === 'starting'
    this.fatalError = message
    for (const pending of this.callbacks.values()) {
      pending.complete({ type: 'error', code: 'protocol_error', message })
    }
    this.callbacks.clear()
    // Termination is initiated here, so handleExit must not emit a second
    // crash notification. Active capture is notified synchronously before the
    // child can produce more corrupt output or keep WASAPI running.
    this.stopping = true
    this.setState('failed', message)
    if (!wasStarting) this.onUnexpectedExit?.()
    if (!child.killed) child.kill()
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code?: number | null, signal?: NodeJS.Signals | null, spawnError?: Error): void {
    if (this.process !== child) return
    const expected = this.stopping
    const wasStarting = this.state === 'starting'
    this.process = undefined
    this.resolveExit?.(); this.resolveExit = undefined
    const message = this.fatalError ?? (spawnError
      ? 'Windows helper could not be launched.'
      : `Windows helper exited${code === null || code === undefined ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`)
    this.fatalError = undefined
    for (const pending of this.callbacks.values()) pending.complete({ type: 'error', code: 'helper_exited', message })
    this.callbacks.clear()
    if (!expected) {
      this.setState('failed', message)
      if (!wasStarting) this.onUnexpectedExit?.()
    }
  }

  private setState(state: HelperLifecycle, error?: string): void {
    this.state = state
    this.lastError = error
    this.onState?.()
  }
}

function safeProtocolMessage(message: unknown): string {
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 600) : 'Windows helper failed.'
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 600) : fallback
}
