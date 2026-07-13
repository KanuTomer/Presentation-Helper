import { app, globalShortcut } from 'electron'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiService } from '../ai/service.js'
import { HelperClient, type HelperEvent } from './helperClient.js'
import type { AssistantResponse, AudioCaptureResult, AudioDevice, OperationState } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'

export class AudioController {
  readonly helper = new HelperClient()
  listening = false
  temporaryAudio?: string
  operation: OperationState = 'idle'
  devices: AudioDevice[] = []
  lastCapture?: Omit<AudioCaptureResult, 'path'>
  warning?: string
  onState?: () => void
  onResponse?: (response: AssistantResponse) => void
  onError?: (message: string) => void
  private busy = false
  private restarted = false
  constructor(private ai: AiService, private settings: SettingsStore) {}

  async initialize(): Promise<void> {
    await this.cleanupStale()
    this.helper.onState = () => this.notify()
    this.helper.onShortcutDown = () => { if (!this.busy) void this.startCapture().catch((error) => this.fail(error)) }
    this.helper.onShortcutUp = () => { if (this.listening) void this.stopAndProcess() }
    this.helper.onUnexpectedExit = () => void this.recoverHelper()
    await this.startHelper()
  }
  async configureShortcut(accelerator: string): Promise<void> {
    if (this.helper.available) await this.helper.command({ type: 'configureShortcut', accelerator }, ['shortcutConfigured', 'error'])
  }
  async refreshDevices(): Promise<AudioDevice[]> {
    if (!this.helper.available) { this.devices = []; this.notify(); return [] }
    const response = await this.helper.command({ type: 'listDevices' }, ['deviceList', 'error'])
    this.devices = Array.isArray(response.devices) ? response.devices.map((device) => {
      const value = device as Record<string, unknown>
      return { id: String(value.id), name: String(value.name), isDefault: Boolean(value.isDefault) }
    }) : []
    const selected = this.settings.settings.selectedAudioEndpointId
    if (selected && !this.devices.some((device) => device.id === selected)) {
      this.warning = 'The selected audio output is unavailable. PresenterAI will use the current Windows default output.'
      await this.settings.updateSettings({ selectedAudioEndpointId: undefined })
    }
    this.notify(); return this.devices
  }
  async startCapture(): Promise<void> {
    if (this.busy) return
    if (!this.helper.available) throw new Error(this.helper.lastError ?? 'Windows audio helper is unavailable.')
    this.busy = true; this.operation = 'listening'; this.warning = undefined; this.notify()
    const directory = this.tempDirectory(); await mkdir(directory, { recursive: true })
    this.temporaryAudio = join(directory, `${randomUUID()}.wav`)
    try {
      await this.helper.command({ type: 'startCapture', path: this.temporaryAudio, endpointId: this.settings.settings.selectedAudioEndpointId }, ['captureStarted', 'error'])
      this.listening = true; this.helper.setLifecycle('capturing')
      if (!globalShortcut.register('Escape', () => void this.cancel())) this.warning = 'Esc could not be registered globally; use Cancel in PresenterAI.'
      this.notify()
    } catch (error) {
      const path = this.temporaryAudio
      if (path) { await rm(path, { force: true }); await rm(`${path}.raw.wav`, { force: true }) }
      this.busy = false; this.operation = 'error'; this.temporaryAudio = undefined
      if (this.helper.state !== 'failed' && this.helper.state !== 'missing') this.helper.setLifecycle('ready')
      this.notify(); throw error
    }
  }
  async stopAndProcess(): Promise<void> {
    if (!this.listening || !this.temporaryAudio) return
    const path = this.temporaryAudio; this.listening = false; this.operation = 'transcribing'; this.notify()
    try {
      const event = await this.helper.command({ type: 'stopCapture' }, ['captureStopped', 'error'], 30_000)
      this.helper.setLifecycle('ready')
      const capture = captureResult(event)
      this.lastCapture = { durationMs: capture.durationMs, bytes: capture.bytes, sampleRate: capture.sampleRate, channels: capture.channels, endpointId: capture.endpointId }
      await this.settings.addUsage(0, 0, capture.durationMs / 60_000)
      const transcript = await this.ai.transcribe(path)
      this.operation = 'retrieving'; this.notify()
      this.operation = 'generating'; this.notify()
      const response = await this.ai.ask(transcript)
      this.onResponse?.(response); this.operation = 'idle'
    } catch (error) {
      if (this.helper.state !== 'failed' && this.helper.state !== 'missing') this.helper.setLifecycle('ready')
      this.operation = 'error'; this.onError?.((error as Error).message)
    } finally {
      globalShortcut.unregister('Escape')
      await rm(path, { force: true }); await rm(`${path}.raw.wav`, { force: true }); this.temporaryAudio = undefined; this.busy = false; this.notify()
    }
  }
  async cancel(): Promise<void> {
    this.ai.cancel()
    globalShortcut.unregister('Escape')
    if (this.listening) await this.helper.command({ type: 'cancel' }, ['captureCancelled', 'error']).catch(() => undefined)
    if (this.temporaryAudio) { await rm(this.temporaryAudio, { force: true }); await rm(`${this.temporaryAudio}.raw.wav`, { force: true }) }
    this.listening = false; this.busy = false; this.temporaryAudio = undefined; this.operation = 'idle'
    if (this.helper.state === 'capturing') this.helper.setLifecycle('ready')
    this.notify()
  }
  async dispose(): Promise<void> { await this.helper.stopProcess() }

  private async startHelper(): Promise<void> {
    if (!await this.helper.start()) return
    await this.configureShortcut(this.settings.settings.listenShortcut)
    await this.refreshDevices()
  }
  private async recoverHelper(): Promise<void> {
    this.listening = false
    if (this.busy || this.restarted) { this.operation = 'error'; this.onError?.('Windows audio helper stopped unexpectedly.'); this.notify(); return }
    this.restarted = true
    await this.startHelper()
    if (!this.helper.available) this.onError?.('Windows audio helper could not be restarted.')
  }
  private fail(error: unknown): void { this.operation = 'error'; this.onError?.((error as Error).message); this.notify() }
  private notify(): void { this.onState?.() }
  private tempDirectory(): string { return join(app.getPath('temp'), 'PresenterAI-audio') }
  private async cleanupStale(): Promise<void> {
    const directory = this.tempDirectory(); await mkdir(directory, { recursive: true })
    for (const file of await readdir(directory)) {
      const path = join(directory, file); const info = await stat(path)
      if (Date.now() - info.mtimeMs > 3_600_000) await rm(path, { force: true })
    }
  }
}

function captureResult(event: HelperEvent): AudioCaptureResult {
  const result = {
    path: String(event.path), durationMs: Number(event.durationMs), bytes: Number(event.bytes), sampleRate: Number(event.sampleRate),
    channels: Number(event.channels), endpointId: String(event.endpointId)
  }
  if (!result.path || result.path === 'undefined' || !result.endpointId || result.endpointId === 'undefined' ||
      !Number.isFinite(result.durationMs) || result.durationMs < 250 || !Number.isFinite(result.bytes) || result.bytes <= 44 ||
      result.sampleRate !== 16_000 || result.channels !== 1) throw new Error('The Windows helper returned invalid capture metadata.')
  return result
}
