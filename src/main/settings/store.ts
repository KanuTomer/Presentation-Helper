import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, CaptureCompatibilityResult, DocumentInfo, UsageSummary } from '../../shared/contracts.js'
import type { TranscriptionUsage } from '../ai/transcription.js'
import {
  MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
  MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION,
  USAGE_PRICING_VERSION
} from '../ai/pricing.js'

export { USAGE_PRICING_VERSION } from '../ai/pricing.js'

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
    askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
    projectSummary: '', approvedVocabulary: []
  },
  documents: [], captureResults: [], usage: {
    inputTokens: 0, outputTokens: 0, audioMinutes: 0,
    transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
    estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION
  }
}

export class SettingsStore {
  private data: StoredData = structuredClone(defaults)
  private path = ''
  private writeQueue: Promise<void> = Promise.resolve()

  async initialize(): Promise<void> {
    this.path = join(app.getPath('userData'), 'presenterai.json')
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredData>
      this.data = {
        ...structuredClone(defaults), ...saved,
        settings: {
          ...defaults.settings, ...saved.settings,
          approvedVocabulary: safeStoredVocabulary(saved.settings?.approvedVocabulary)
        },
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
    if (patch.approvedVocabulary !== undefined) patch = { ...patch, approvedVocabulary: validateVocabulary(patch.approvedVocabulary) }
    this.data.settings = { ...this.data.settings, ...patch }
    this.data.settings.opacity = Math.min(1, Math.max(0.45, this.data.settings.opacity))
    await this.flush(); return this.settings
  }
  async setWindowBounds(bounds: NonNullable<StoredData['windowBounds']>): Promise<void> { this.data.windowBounds = bounds; await this.flush() }
  async setDocuments(documents: DocumentInfo[]): Promise<void> { this.data.documents = documents; await this.flush() }
  async addCaptureResult(result: CaptureCompatibilityResult): Promise<void> { this.data.captureResults.unshift(result); await this.flush() }
  async removeCaptureResult(id: string): Promise<void> { this.data.captureResults = this.data.captureResults.filter((result) => result.id !== id); await this.flush() }
  async addUsage(inputTokens: number, outputTokens: number, audioMinutes = 0): Promise<void> {
    this.data.usage.inputTokens += inputTokens; this.data.usage.outputTokens += outputTokens; this.data.usage.audioMinutes += audioMinutes
    const model = this.data.settings.modelMode === 'strong' ? this.data.settings.strongModel : this.data.settings.normalModel
    const textCost = model.includes('terra') ? (inputTokens * 2.5 + outputTokens * 15) / 1_000_000 : (inputTokens + outputTokens * 6) / 1_000_000
    this.data.usage.estimatedUsd += textCost
    this.data.usage.pricingVersion = USAGE_PRICING_VERSION
    await this.flush()
  }
  async addTranscriptionUsage(usage: TranscriptionUsage, model: string): Promise<void> {
    this.data.usage.transcriptionInputTokens += usage.inputTokens
    this.data.usage.transcriptionAudioTokens += usage.audioTokens
    this.data.usage.transcriptionOutputTokens += usage.outputTokens
    // Capture duration is recorded once by AudioController from the validated
    // WAV. A duration-form provider usage object describes billing for that
    // same recording and must not count the local audio duration a second time.
    this.data.usage.estimatedUsd += estimateTranscriptionUsd(usage, model)
    this.data.usage.pricingVersion = USAGE_PRICING_VERSION
    await this.flush()
  }
  async clearSessionUsage(): Promise<void> { this.data.usage = structuredClone(defaults.usage); await this.flush() }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, this.path)
    }, async () => {
      // A prior caller still receives its write error, but a transient failure
      // must not permanently poison later persistence attempts.
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, this.path)
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}

export function estimateTranscriptionUsd(usage: TranscriptionUsage, model: string): number {
  if (!model.startsWith('gpt-4o-mini-transcribe')) return 0
  return (
    usage.inputTokens * MINI_TRANSCRIBE_INPUT_USD_PER_MILLION +
    usage.outputTokens * MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION
  ) / 1_000_000
}

export function validateVocabulary(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Approved vocabulary is limited to 30 terms.')
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Approved vocabulary terms must be text.')
    const normalized = item.normalize('NFKC').trim()
    if (!normalized || Array.from(normalized).length > 64) throw new Error('Each approved vocabulary term must contain 1–64 characters.')
    const key = normalized.toLocaleLowerCase('en-US')
    if (!seen.has(key)) { seen.add(key); result.push(normalized) }
  }
  return result
}

function safeStoredVocabulary(value: unknown): string[] {
  try { return validateVocabulary(value ?? []) } catch { return [] }
}
