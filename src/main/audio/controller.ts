import { app } from 'electron'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiService } from '../ai/service.js'
import { HelperClient } from './helperClient.js'
import type { AssistantResponse, OperationState } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'

export class AudioController {
  readonly helper = new HelperClient()
  listening = false
  temporaryAudio?: string
  operation: OperationState = 'idle'
  onState?: () => void
  onResponse?: (response: AssistantResponse) => void
  onError?: (message: string) => void
  private busy = false
  constructor(private ai: AiService, private settings: SettingsStore) {}
  async initialize(): Promise<void> {
    await this.cleanupStale(); this.helper.start()
    if (this.helper.available) await this.configureShortcut(this.settings.settings.listenShortcut)
    this.helper.onShortcutDown = () => { if (!this.busy) void this.startCapture() }
    this.helper.onShortcutUp = () => { if (this.listening) void this.stopAndProcess() }
    this.helper.onUnexpectedExit = () => { this.listening = false; this.operation = 'error'; this.onState?.(); this.onError?.('Windows audio helper stopped unexpectedly.') }
  }
  async configureShortcut(accelerator: string): Promise<void> {
    if (this.helper.available) await this.helper.command({ type: 'configureShortcut', accelerator }, ['shortcutConfigured', 'error'])
  }
  async startCapture(): Promise<void> {
    if (this.busy) return
    this.busy = true; this.operation = 'listening'; this.notify()
    const directory = this.tempDirectory(); await mkdir(directory, { recursive: true })
    this.temporaryAudio = join(directory, `${randomUUID()}.wav`)
    try { await this.helper.command({ type: 'startCapture', path: this.temporaryAudio }, ['captureStarted', 'error']); this.listening = true; this.notify() }
    catch (error) { this.busy = false; this.operation = 'error'; this.temporaryAudio = undefined; this.notify(); throw error }
  }
  async stopAndProcess(): Promise<void> {
    if (!this.listening || !this.temporaryAudio) return
    const path = this.temporaryAudio; this.listening = false; this.operation = 'transcribing'; this.notify()
    try {
      await this.helper.command({ type: 'stopCapture' }, ['captureStopped', 'error'])
      const transcript = await this.ai.transcribe(path)
      this.operation = 'retrieving'; this.notify()
      this.operation = 'generating'; this.notify()
      const response = await this.ai.ask(transcript)
      this.onResponse?.(response); this.operation = 'idle'
    } catch (error) { this.operation = 'error'; this.onError?.((error as Error).message) }
    finally { await rm(path, { force: true }); this.temporaryAudio = undefined; this.busy = false; this.notify() }
  }
  async cancel(): Promise<void> {
    this.ai.cancel()
    if (this.listening) await this.helper.command({ type: 'cancel' }, ['captureCancelled', 'error']).catch(() => undefined)
    if (this.temporaryAudio) await rm(this.temporaryAudio, { force: true })
    this.listening = false; this.busy = false; this.temporaryAudio = undefined; this.operation = 'idle'; this.notify()
  }
  dispose(): void { this.helper.stopProcess() }
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
