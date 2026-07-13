import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, CaptureCompatibilityResult, DocumentInfo, UsageSummary } from '../../shared/contracts.js'

interface StoredData {
  settings: AppSettings
  windowBounds?: { x: number; y: number; width: number; height: number }
  documents: DocumentInfo[]
  captureResults: CaptureCompatibilityResult[]
  usage: UsageSummary
}

const defaults: StoredData = {
  settings: {
    opacity: 0.92, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
    strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
    askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space', projectSummary: ''
  },
  documents: [], captureResults: [], usage: { inputTokens: 0, outputTokens: 0, audioMinutes: 0, estimatedUsd: 0 }
}

export class SettingsStore {
  private data: StoredData = structuredClone(defaults)
  private path = ''

  async initialize(): Promise<void> {
    this.path = join(app.getPath('userData'), 'presenterai.json')
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredData>
      this.data = {
        ...structuredClone(defaults), ...saved,
        settings: { ...defaults.settings, ...saved.settings },
        usage: { ...defaults.usage, ...saved.usage },
        documents: saved.documents ?? [], captureResults: saved.captureResults ?? []
      }
    } catch { await this.flush() }
  }

  get settings(): AppSettings { return structuredClone(this.data.settings) }
  get documents(): DocumentInfo[] { return structuredClone(this.data.documents) }
  get captureResults(): CaptureCompatibilityResult[] { return structuredClone(this.data.captureResults) }
  get usage(): UsageSummary { return structuredClone(this.data.usage) }
  get windowBounds(): StoredData['windowBounds'] { return this.data.windowBounds && { ...this.data.windowBounds } }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.data.settings = { ...this.data.settings, ...patch }
    this.data.settings.opacity = Math.min(1, Math.max(0.45, this.data.settings.opacity))
    await this.flush(); return this.settings
  }
  async setWindowBounds(bounds: NonNullable<StoredData['windowBounds']>): Promise<void> { this.data.windowBounds = bounds; await this.flush() }
  async setDocuments(documents: DocumentInfo[]): Promise<void> { this.data.documents = documents; await this.flush() }
  async addUsage(inputTokens: number, outputTokens: number, audioMinutes = 0): Promise<void> {
    this.data.usage.inputTokens += inputTokens; this.data.usage.outputTokens += outputTokens; this.data.usage.audioMinutes += audioMinutes
    const model = this.data.settings.modelMode === 'strong' ? this.data.settings.strongModel : this.data.settings.normalModel
    const textCost = model.includes('terra') ? (inputTokens * 2.5 + outputTokens * 15) / 1_000_000 : (inputTokens + outputTokens * 6) / 1_000_000
    this.data.usage.estimatedUsd += textCost + audioMinutes * 0.003
    await this.flush()
  }
  async clearSessionUsage(): Promise<void> { this.data.usage = structuredClone(defaults.usage); await this.flush() }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(temp, this.path)
  }
}
