import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  AppSettings, CaptureCompatibilityResult, DocumentInfo, SettingsRecoveryWarning, UsageSummary
} from '../../shared/contracts.js'
import { LISTENING_CONSENT_VERSION } from '../../shared/contracts.js'
import type { TranscriptionUsage } from '../ai/transcription.js'
import {
  estimateKnownModelTokens,
  USAGE_PRICING_VERSION,
  type BillableEndpoint
} from '../ai/pricing.js'
import { appSettingsSchema, parseSettingsPatch, validateSettingsMutation, validateVocabularyTerms } from './validation.js'

export { USAGE_PRICING_VERSION } from '../ai/pricing.js'
export type { SettingsRecoveryWarning } from '../../shared/contracts.js'

export const SETTINGS_SCHEMA_VERSION = 2
export { LISTENING_CONSENT_VERSION } from '../../shared/contracts.js'
export const MAX_RECENT_USAGE_RECORDS = 100

type RecoveryReason = 'invalid_json' | 'invalid_shape' | 'unsupported_schema'

export interface PrivacyConsentStatus {
  requiredVersion: number
  acceptedVersion?: number
  acceptedAt?: string
  satisfied: boolean
}

interface StoredPrivacyConsent {
  acceptedVersion: number
  acceptedAt: string
}

export interface UsageRecordInput {
  endpoint: BillableEndpoint
  requestedModel: string
  returnedModel?: string
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  audioTokens?: number
  durationMs?: number
}

export interface UsageRecord extends UsageRecordInput {
  id: string
  timestamp: string
  pricingVersion: string
  priced: boolean
  estimatedUsd: number
}

export interface UsageRollup {
  endpoint: BillableEndpoint | 'legacy'
  model: string
  requestCount: number
  unpricedRequestCount: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  audioTokens: number
  durationMs: number
  estimatedUsd: number
}

export interface UsageLedger {
  summary: UsageSummary
  recent: UsageRecord[]
  rollups: UsageRollup[]
}

interface StoredData {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  settings: AppSettings
  windowBounds?: { x: number; y: number; width: number; height: number }
  documents: DocumentInfo[]
  captureResults: CaptureCompatibilityResult[]
  usage: UsageSummary
  usageRecords: UsageRecord[]
  usageRollups: UsageRollup[]
  privacyConsent?: StoredPrivacyConsent
  recoveryWarning?: SettingsRecoveryWarning
}

export interface SettingsStoreOptions {
  path?: () => string
  clock?: () => Date
  idGenerator?: () => string
}

const finiteNonnegative = z.number().finite().nonnegative()
const tokenCount = z.number().int().nonnegative()
const isoTimestamp = z.string().datetime()
const boundsSchema = z.object({
  x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive()
}).strict()
const documentSchema: z.ZodType<DocumentInfo> = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(512), path: z.string().min(1).max(32_767),
  kind: z.enum(['pptx', 'pdf', 'markdown', 'text']), chunkCount: z.number().int().nonnegative(),
  addedAt: z.string().min(1), updatedAt: z.string().min(1).optional()
}).strict()
const captureResultSchema: z.ZodType<CaptureCompatibilityResult> = z.object({
  id: z.string().min(1).max(256), path: z.string().min(1).max(512), captureAppVersion: z.string().min(1).max(256),
  controlResult: z.enum(['overlay-absent', 'overlay-black', 'overlay-visible', 'unsupported', 'untested']),
  protectedResult: z.enum(['overlay-absent', 'overlay-black', 'overlay-visible', 'unsupported', 'untested']),
  testedAt: z.string().min(1), notes: z.string().max(4_000),
  environment: z.object({
    windowsBuild: z.string().max(256), presenterVersion: z.string().max(256), electronVersion: z.string().max(256),
    gpu: z.string().max(512), monitorCount: z.number().int().nonnegative()
  }).strict()
}).strict()
const usageSummarySchema: z.ZodType<UsageSummary> = z.object({
  inputTokens: tokenCount, outputTokens: tokenCount, audioMinutes: finiteNonnegative,
  transcriptionInputTokens: tokenCount, transcriptionAudioTokens: tokenCount,
  transcriptionOutputTokens: tokenCount, estimatedUsd: finiteNonnegative,
  pricingVersion: z.string().min(1).max(128)
}).strict()
const usageRecordSchema: z.ZodType<UsageRecord> = z.object({
  id: z.string().min(1).max(128), timestamp: isoTimestamp,
  endpoint: z.enum(['responses', 'transcription']), requestedModel: z.string().min(1).max(128),
  returnedModel: z.string().min(1).max(128).optional(), inputTokens: tokenCount, outputTokens: tokenCount,
  reasoningTokens: tokenCount.optional(), audioTokens: tokenCount.optional(), durationMs: finiteNonnegative.optional(),
  pricingVersion: z.string().min(1).max(128), priced: z.boolean(), estimatedUsd: finiteNonnegative
}).strict().superRefine((record, context) => {
  if ((record.reasoningTokens ?? 0) > record.outputTokens) context.addIssue({ code: 'custom', message: 'Reasoning tokens cannot exceed output tokens.' })
  if ((record.audioTokens ?? 0) > record.inputTokens) context.addIssue({ code: 'custom', message: 'Audio tokens cannot exceed input tokens.' })
})
const usageRollupSchema: z.ZodType<UsageRollup> = z.object({
  endpoint: z.enum(['responses', 'transcription', 'legacy']), model: z.string().min(1).max(128),
  requestCount: tokenCount, unpricedRequestCount: tokenCount, inputTokens: tokenCount, outputTokens: tokenCount,
  reasoningTokens: tokenCount, audioTokens: tokenCount, durationMs: finiteNonnegative, estimatedUsd: finiteNonnegative
}).strict()
const consentSchema: z.ZodType<StoredPrivacyConsent> = z.object({
  acceptedVersion: z.number().int().positive(), acceptedAt: isoTimestamp
}).strict()
const recoveryWarningSchema: z.ZodType<SettingsRecoveryWarning> = z.object({
  code: z.enum(['invalid_json', 'invalid_shape', 'unsupported_schema']), recoveredAt: isoTimestamp
}).strict()
const storedDataSchema: z.ZodType<StoredData> = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION), settings: appSettingsSchema,
  windowBounds: boundsSchema.optional(), documents: z.array(documentSchema), captureResults: z.array(captureResultSchema),
  usage: usageSummarySchema, usageRecords: z.array(usageRecordSchema).max(MAX_RECENT_USAGE_RECORDS),
  usageRollups: z.array(usageRollupSchema), privacyConsent: consentSchema.optional(),
  recoveryWarning: recoveryWarningSchema.optional()
}).strict()
const legacyStoredDataSchema = z.object({
  settings: appSettingsSchema, windowBounds: boundsSchema.optional(), documents: z.array(documentSchema),
  captureResults: z.array(captureResultSchema), usage: usageSummarySchema
}).strict()
const usageRecordInputSchema: z.ZodType<UsageRecordInput> = z.object({
  endpoint: z.enum(['responses', 'transcription']), requestedModel: z.string().trim().min(1).max(128),
  returnedModel: z.string().trim().min(1).max(128).optional(), inputTokens: tokenCount, outputTokens: tokenCount,
  reasoningTokens: tokenCount.optional(), audioTokens: tokenCount.optional(), durationMs: finiteNonnegative.optional()
}).strict().superRefine((record, context) => {
  if ((record.reasoningTokens ?? 0) > record.outputTokens) context.addIssue({ code: 'custom', message: 'Reasoning tokens cannot exceed output tokens.' })
  if ((record.audioTokens ?? 0) > record.inputTokens) context.addIssue({ code: 'custom', message: 'Audio tokens cannot exceed input tokens.' })
})

const defaultSettings: AppSettings = {
  opacity: 0.92, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
  strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: '', approvedVocabulary: []
}
const defaultUsage = (): UsageSummary => ({
  inputTokens: 0, outputTokens: 0, audioMinutes: 0,
  transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
  estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION
})
const defaultData = (): StoredData => ({
  schemaVersion: SETTINGS_SCHEMA_VERSION, settings: structuredClone(defaultSettings), documents: [], captureResults: [],
  usage: defaultUsage(), usageRecords: [], usageRollups: []
})

export class SettingsStore {
  private data: StoredData = defaultData()
  private readonly pathProvider: () => string
  private readonly clock: () => Date
  private readonly idGenerator: () => string
  private path = ''
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: SettingsStoreOptions = {}) {
    this.pathProvider = options.path ?? (() => join(app.getPath('userData'), 'presenterai.json'))
    this.clock = options.clock ?? (() => new Date())
    this.idGenerator = options.idGenerator ?? randomUUID
  }

  async initialize(): Promise<void> {
    this.path = this.pathProvider()
    let text: string
    try { text = await readFile(this.path, 'utf8') }
    catch (error) {
      if (!isMissingFile(error)) this.data = this.recoveredDefaults('invalid_shape')
      await this.flush()
      return
    }

    let raw: unknown
    try { raw = JSON.parse(text) }
    catch {
      this.data = this.recoveredDefaults('invalid_json')
      await this.flush()
      return
    }

    const parsed = storedDataSchema.safeParse(raw)
    if (parsed.success) {
      this.data = parsed.data
      return
    }

    const rawVersion = isRecord(raw) ? raw.schemaVersion : undefined
    if (rawVersion === undefined) {
      const legacy = legacyStoredDataSchema.safeParse(raw)
      if (legacy.success) {
        this.data = this.migrateLegacy(legacy.data)
        await this.flush()
        return
      }
    }
    const warningCode: RecoveryReason = rawVersion !== undefined && rawVersion !== SETTINGS_SCHEMA_VERSION
      ? 'unsupported_schema'
      : 'invalid_shape'
    this.data = this.migrateOrRecover(raw, warningCode)
    await this.flush()
  }

  get settings(): AppSettings { return structuredClone(this.data.settings) }
  get documents(): DocumentInfo[] { return structuredClone(this.data.documents) }
  get captureResults(): CaptureCompatibilityResult[] { return structuredClone(this.data.captureResults) }
  get usage(): UsageSummary { return structuredClone(this.data.usage) }
  get usageRecords(): UsageRecord[] { return structuredClone(this.data.usageRecords) }
  get usageRollups(): UsageRollup[] { return structuredClone(this.data.usageRollups) }
  get usageLedger(): UsageLedger {
    return { summary: this.usage, recent: this.usageRecords, rollups: this.usageRollups }
  }
  get recoveryWarning(): SettingsRecoveryWarning | undefined {
    return this.data.recoveryWarning && { ...this.data.recoveryWarning }
  }
  get privacyConsent(): PrivacyConsentStatus {
    const accepted = this.data.privacyConsent
    return {
      requiredVersion: LISTENING_CONSENT_VERSION,
      ...(accepted ? { acceptedVersion: accepted.acceptedVersion, acceptedAt: accepted.acceptedAt } : {}),
      satisfied: accepted?.acceptedVersion === LISTENING_CONSENT_VERSION
    }
  }
  get windowBounds(): StoredData['windowBounds'] { return this.data.windowBounds && { ...this.data.windowBounds } }

  async updateSettings(value: Partial<AppSettings>): Promise<AppSettings> {
    const patch = parseSettingsPatch(value)
    validateSettingsMutation(this.data.settings, patch, false)
    this.data.settings = appSettingsSchema.parse({ ...this.data.settings, ...patch })
    await this.flush()
    return this.settings
  }

  async setWindowBounds(bounds: NonNullable<StoredData['windowBounds']>): Promise<void> {
    this.data.windowBounds = boundsSchema.parse(bounds)
    await this.flush()
  }
  async setDocuments(documents: DocumentInfo[]): Promise<void> {
    this.data.documents = z.array(documentSchema).parse(documents)
    await this.flush()
  }
  async addCaptureResult(result: CaptureCompatibilityResult): Promise<void> {
    this.data.captureResults.unshift(captureResultSchema.parse(result))
    await this.flush()
  }
  async removeCaptureResult(id: string): Promise<void> {
    this.data.captureResults = this.data.captureResults.filter((result) => result.id !== id)
    await this.flush()
  }

  async recordUsage(value: UsageRecordInput): Promise<UsageRecord> {
    const input = usageRecordInputSchema.parse(value)
    const effectiveModel = input.returnedModel ?? input.requestedModel
    // A zero-token transcription usage object (for example a duration-only
    // provider shape) cannot be priced from the token table.
    const price = input.endpoint === 'transcription' && input.inputTokens === 0 && input.outputTokens === 0
      ? { priced: false, estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION as typeof USAGE_PRICING_VERSION }
      : estimateKnownModelTokens(input.endpoint, effectiveModel, input.inputTokens, input.outputTokens)
    const record: UsageRecord = {
      ...input, id: this.idGenerator(), timestamp: this.clock().toISOString(),
      pricingVersion: price.pricingVersion, priced: price.priced, estimatedUsd: price.estimatedUsd
    }
    this.appendUsageRecord(record)
    await this.flush()
    return structuredClone(record)
  }

  /** Compatibility adapter until all call sites supply request provenance. */
  async addUsage(inputTokens: number, outputTokens: number, audioMinutes = 0): Promise<void> {
    tokenCount.parse(inputTokens); tokenCount.parse(outputTokens); finiteNonnegative.parse(audioMinutes)
    if (inputTokens > 0 || outputTokens > 0) {
      const model = this.data.settings.modelMode === 'strong' ? this.data.settings.strongModel : this.data.settings.normalModel
      const price = estimateKnownModelTokens('responses', model, inputTokens, outputTokens)
      this.appendUsageRecord({
        endpoint: 'responses', requestedModel: model, inputTokens, outputTokens,
        id: this.idGenerator(), timestamp: this.clock().toISOString(), pricingVersion: price.pricingVersion,
        priced: price.priced, estimatedUsd: price.estimatedUsd
      })
    }
    // The existing capture controller reports validated duration separately.
    // It is aggregate-only so a later token-usage record cannot double count it.
    this.data.usage.audioMinutes += audioMinutes
    this.data.usage.pricingVersion = USAGE_PRICING_VERSION
    await this.flush()
  }

  async addTranscriptionUsage(
    usage: TranscriptionUsage,
    returnedModel: string,
    requestedModel = returnedModel,
    durationMs?: number
  ): Promise<void> {
    if (usage.type === 'none') return
    await this.recordUsage({
      endpoint: 'transcription', requestedModel, returnedModel,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      audioTokens: usage.audioTokens, ...(durationMs === undefined ? {} : { durationMs })
    })
  }

  async acceptListeningConsent(version = LISTENING_CONSENT_VERSION): Promise<PrivacyConsentStatus> {
    if (version !== LISTENING_CONSENT_VERSION) throw new Error('The listening disclosure version is not current.')
    this.data.privacyConsent = { acceptedVersion: version, acceptedAt: this.clock().toISOString() }
    await this.flush()
    return this.privacyConsent
  }
  async clearListeningConsent(): Promise<void> { delete this.data.privacyConsent; await this.flush() }
  async clearUsage(): Promise<void> {
    this.data.usage = defaultUsage(); this.data.usageRecords = []; this.data.usageRollups = []
    await this.flush()
  }
  async clearSessionUsage(): Promise<void> { await this.clearUsage() }
  async clearCaptureResults(): Promise<void> { this.data.captureResults = []; await this.flush() }
  async resetSettings(): Promise<AppSettings> {
    this.data.settings = structuredClone(defaultSettings)
    await this.flush()
    return this.settings
  }
  async clearWindowBounds(): Promise<void> { delete this.data.windowBounds; await this.flush() }
  async dismissRecoveryWarning(): Promise<void> { delete this.data.recoveryWarning; await this.flush() }
  async clearSettingsData(): Promise<void> {
    this.data.settings = structuredClone(defaultSettings)
    delete this.data.windowBounds
    delete this.data.privacyConsent
    delete this.data.recoveryWarning
    await this.flush()
  }

  private appendUsageRecord(record: UsageRecord): void {
    if (record.endpoint === 'responses') {
      this.data.usage.inputTokens += record.inputTokens
      this.data.usage.outputTokens += record.outputTokens
    } else {
      this.data.usage.transcriptionInputTokens += record.inputTokens
      this.data.usage.transcriptionAudioTokens += record.audioTokens ?? 0
      this.data.usage.transcriptionOutputTokens += record.outputTokens
    }
    if (record.durationMs !== undefined) this.data.usage.audioMinutes += record.durationMs / 60_000
    this.data.usage.estimatedUsd += record.estimatedUsd
    this.data.usage.pricingVersion = USAGE_PRICING_VERSION
    this.data.usageRecords.push(record)
    while (this.data.usageRecords.length > MAX_RECENT_USAGE_RECORDS) {
      const oldest = this.data.usageRecords.shift()
      if (oldest) mergeRollup(this.data.usageRollups, oldest)
    }
  }

  private recoveredDefaults(reason: RecoveryReason): StoredData {
    return { ...defaultData(), recoveryWarning: recoveryWarning(reason, this.clock()) }
  }

  private migrateLegacy(legacy: z.infer<typeof legacyStoredDataSchema>): StoredData {
    const data: StoredData = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      settings: legacy.settings,
      ...(legacy.windowBounds ? { windowBounds: legacy.windowBounds } : {}),
      documents: legacy.documents,
      captureResults: legacy.captureResults,
      usage: legacy.usage,
      usageRecords: [],
      usageRollups: []
    }
    if (hasUsage(data.usage)) data.usageRollups.push(legacyUsageRollup(data.usage))
    return data
  }

  private migrateOrRecover(raw: unknown, reason: RecoveryReason): StoredData {
    if (!isRecord(raw)) return this.recoveredDefaults(reason)
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) return this.recoveredDefaults(reason)

    const data = defaultData()
    data.settings = recoverSettings(raw.settings)
    data.windowBounds = parseOptional(boundsSchema, raw.windowBounds)
    data.documents = parseArrayItems(documentSchema, raw.documents)
    data.captureResults = parseArrayItems(captureResultSchema, raw.captureResults)
    data.usage = usageSummarySchema.safeParse(raw.usage).success
      ? usageSummarySchema.parse(raw.usage)
      : defaultUsage()
    data.usageRecords = parseArrayItems(usageRecordSchema, raw.usageRecords).slice(-MAX_RECENT_USAGE_RECORDS)
    data.usageRollups = parseArrayItems(usageRollupSchema, raw.usageRollups)
    data.privacyConsent = parseOptional(consentSchema, raw.privacyConsent)
    data.recoveryWarning = recoveryWarning(reason, this.clock())

    // Legacy aggregate usage has no reliable per-request model provenance.
    // Preserve it explicitly without pretending it can be repriced.
    if (raw.schemaVersion === undefined && hasUsage(data.usage)) {
      data.usageRollups.push(legacyUsageRollup(data.usage))
    }
    return data
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(storedDataSchema.parse(this.data), null, 2)
    const write = this.writeQueue.then(
      () => writeAtomically(this.path, snapshot),
      // A prior caller still receives its write error, but a transient failure
      // must not permanently poison later persistence attempts.
      () => writeAtomically(this.path, snapshot)
    )
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}

export function estimateTranscriptionUsd(usage: TranscriptionUsage, model: string): number {
  return estimateKnownModelTokens('transcription', model, usage.inputTokens, usage.outputTokens).estimatedUsd
}

export const validateVocabulary = validateVocabularyTerms

function recoverSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return structuredClone(defaultSettings)
  const recovered: Record<string, unknown> = { ...defaultSettings }
  for (const key of Object.keys(defaultSettings) as Array<keyof AppSettings>) {
    if (!(key in value)) continue
    const parsed = parseSettingsPatchSafely({ [key]: value[key] })
    if (parsed) Object.assign(recovered, parsed)
  }
  // Optional fields are not enumerable on defaults and must be recovered explicitly.
  for (const key of ['selectedAudioEndpointId', 'inrPerUsd'] as const) {
    if (!(key in value)) continue
    const parsed = parseSettingsPatchSafely({ [key]: value[key] })
    if (parsed) Object.assign(recovered, parsed)
  }
  const parsed = appSettingsSchema.safeParse(recovered)
  if (!parsed.success) return structuredClone(defaultSettings)
  try { validateSettingsMutation(defaultSettings, parsed.data, false); return parsed.data }
  catch {
    return { ...parsed.data, askShortcut: defaultSettings.askShortcut, hideShortcut: defaultSettings.hideShortcut, listenShortcut: defaultSettings.listenShortcut }
  }
}

function parseSettingsPatchSafely(value: unknown): Partial<AppSettings> | undefined {
  try { return parseSettingsPatch(value) } catch { return undefined }
}

function parseOptional<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parseArrayItems<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function mergeRollup(rollups: UsageRollup[], record: UsageRecord): void {
  const model = record.returnedModel ?? record.requestedModel
  let rollup = rollups.find((candidate) => candidate.endpoint === record.endpoint && candidate.model === model)
  if (!rollup) {
    rollup = {
      endpoint: record.endpoint, model, requestCount: 0, unpricedRequestCount: 0,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, audioTokens: 0, durationMs: 0, estimatedUsd: 0
    }
    rollups.push(rollup)
  }
  rollup.requestCount += 1
  if (!record.priced) rollup.unpricedRequestCount += 1
  rollup.inputTokens += record.inputTokens
  rollup.outputTokens += record.outputTokens
  rollup.reasoningTokens += record.reasoningTokens ?? 0
  rollup.audioTokens += record.audioTokens ?? 0
  rollup.durationMs += record.durationMs ?? 0
  rollup.estimatedUsd += record.estimatedUsd
}

function hasUsage(usage: UsageSummary): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.audioMinutes > 0 ||
    usage.transcriptionInputTokens > 0 || usage.transcriptionOutputTokens > 0 || usage.estimatedUsd > 0
}

function legacyUsageRollup(usage: UsageSummary): UsageRollup {
  return {
    endpoint: 'legacy', model: 'legacy-unattributed', requestCount: 0,
    unpricedRequestCount: 0, inputTokens: usage.inputTokens + usage.transcriptionInputTokens,
    outputTokens: usage.outputTokens + usage.transcriptionOutputTokens,
    reasoningTokens: 0, audioTokens: usage.transcriptionAudioTokens,
    durationMs: usage.audioMinutes * 60_000, estimatedUsd: usage.estimatedUsd
  }
}

function recoveryWarning(reason: RecoveryReason, at: Date): SettingsRecoveryWarning {
  return { code: reason, recoveredAt: at.toISOString() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function writeAtomically(path: string, snapshot: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, snapshot, 'utf8')
  await rename(temp, path)
}
