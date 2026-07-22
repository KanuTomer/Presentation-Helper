import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  AppSettings, CaptureCompatibilityResult, DocumentInfo, SessionBudgetStatus, SettingsRecoveryWarning, UsageSummary
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

export const SETTINGS_SCHEMA_VERSION = 4
export const WINDOW_LAYOUT_REVISION = 1
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

export interface SessionBudgetReservation {
  id: string
  endpoint: BillableEndpoint
  requestedModel: string
  maximumUsd: number
  reservedAt: string
}

export interface SessionBudgetReservationInput {
  endpoint: BillableEndpoint
  requestedModel: string
  maximumUsd: number
}

export class SessionBudgetExceededError extends Error {
  readonly code = 'session_budget_exceeded'
  constructor(readonly requestedUsd: number, readonly remainingUsd: number) {
    super('This request could exceed the remaining PresenterAI session budget. Start a new session or increase the cap.')
    this.name = 'SessionBudgetExceededError'
  }
}

interface StoredSessionBudget {
  sessionId: string
  startedAt: string
  actualUsd: number
  reservations: SessionBudgetReservation[]
}

interface StoredData {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  windowLayoutRevision: number
  settings: AppSettings
  windowBounds?: { x: number; y: number; width: number; height: number }
  documents: DocumentInfo[]
  captureResults: CaptureCompatibilityResult[]
  usage: UsageSummary
  usageRecords: UsageRecord[]
  usageRollups: UsageRollup[]
  sessionBudget: StoredSessionBudget
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

// Versions 2 and 3 stored the native-window opacity and an optional INR
// display preference. Keep these schemas independent from the current
// renderer contract so future settings changes cannot silently invalidate a
// supported migration path.
const legacySettingsSchema = z.object({
  opacity: z.number().finite().min(0.45).max(1),
  clickThrough: z.boolean(),
  modelMode: z.enum(['normal', 'strong']),
  normalModel: z.string().trim().min(1).max(128),
  strongModel: z.string().trim().min(1).max(128),
  transcriptionModel: z.string().trim().min(1).max(128),
  askShortcut: z.string().trim().min(1).max(128),
  hideShortcut: z.string().trim().min(1).max(128),
  listenShortcut: z.string().trim().min(1).max(128),
  projectSummary: z.string(),
  approvedVocabulary: z.array(z.string()).max(30),
  selectedAudioEndpointId: z.string().min(1).max(2_048).optional(),
  inrPerUsd: z.number().finite().min(1).max(1_000).optional()
}).strict()
const sessionBudgetReservationSchema = z.object({
  id: z.string().min(1).max(128),
  endpoint: z.enum(['responses', 'transcription']),
  requestedModel: z.string().trim().min(1).max(128),
  maximumUsd: z.number().finite().positive().max(100),
  reservedAt: isoTimestamp
}).strict()
const sessionBudgetSchema: z.ZodType<StoredSessionBudget> = z.object({
  sessionId: z.string().min(1).max(128),
  startedAt: isoTimestamp,
  actualUsd: z.number().finite().nonnegative().max(100),
  reservations: z.array(sessionBudgetReservationSchema).max(10_000)
}).strict()
const historicalStoredShape = {
  windowBounds: boundsSchema.optional(),
  documents: z.array(documentSchema),
  captureResults: z.array(captureResultSchema),
  usage: usageSummarySchema,
  usageRecords: z.array(usageRecordSchema).max(MAX_RECENT_USAGE_RECORDS),
  usageRollups: z.array(usageRollupSchema),
  privacyConsent: consentSchema.optional(),
  recoveryWarning: recoveryWarningSchema.optional()
}
const storedDataShape = {
  settings: appSettingsSchema,
  ...historicalStoredShape,
  sessionBudget: sessionBudgetSchema
}
const storedDataSchema: z.ZodType<StoredData> = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  windowLayoutRevision: z.number().int().min(0).max(WINDOW_LAYOUT_REVISION),
  ...storedDataShape
}).strict()
const storedDataV2Schema = z.object({
  schemaVersion: z.literal(2),
  // A synthetic installer fixture can downgrade a freshly initialized file.
  // Ignore the future marker and still exercise the real v2 migration path.
  windowLayoutRevision: z.number().int().optional(),
  settings: legacySettingsSchema,
  ...historicalStoredShape
}).strict()
const storedDataV3Schema = z.object({
  schemaVersion: z.literal(3),
  windowLayoutRevision: z.number().int().min(0).max(WINDOW_LAYOUT_REVISION),
  settings: legacySettingsSchema,
  ...historicalStoredShape
}).strict()
const legacyStoredDataSchema = z.object({
  settings: legacySettingsSchema, windowBounds: boundsSchema.optional(), documents: z.array(documentSchema),
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
  glassTint: 0.42, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
  strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: '', approvedVocabulary: [], sessionBudgetUsd: 0.25
}
const defaultUsage = (): UsageSummary => ({
  inputTokens: 0, outputTokens: 0, audioMinutes: 0,
  transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
  estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION
})
const defaultSessionBudget = (clock: () => Date, idGenerator: () => string): StoredSessionBudget => ({
  sessionId: idGenerator(), startedAt: clock().toISOString(), actualUsd: 0, reservations: []
})
const defaultData = (clock: () => Date, idGenerator: () => string): StoredData => ({
  schemaVersion: SETTINGS_SCHEMA_VERSION, windowLayoutRevision: WINDOW_LAYOUT_REVISION,
  settings: structuredClone(defaultSettings), documents: [], captureResults: [],
  usage: defaultUsage(), usageRecords: [], usageRollups: [],
  sessionBudget: defaultSessionBudget(clock, idGenerator)
})

export class SettingsStore {
  private data: StoredData
  private readonly pathProvider: () => string
  private readonly clock: () => Date
  private readonly idGenerator: () => string
  private path = ''
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: SettingsStoreOptions = {}) {
    this.pathProvider = options.path ?? (() => join(app.getPath('userData'), 'presenterai.json'))
    this.clock = options.clock ?? (() => new Date())
    this.idGenerator = options.idGenerator ?? randomUUID
    this.data = defaultData(this.clock, this.idGenerator)
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
    if (rawVersion === 2) {
      const versionTwo = storedDataV2Schema.safeParse(raw)
      if (versionTwo.success) {
        this.data = this.migrateHistorical(versionTwo.data)
        await this.flush()
        return
      }
    }
    if (rawVersion === 3) {
      const versionThree = storedDataV3Schema.safeParse(raw)
      if (versionThree.success) {
        this.data = this.migrateHistorical(versionThree.data)
        await this.flush()
        return
      }
    }
    if (rawVersion === undefined) {
      const legacy = legacyStoredDataSchema.safeParse(raw)
      if (legacy.success) {
        this.data = this.migrateLegacy(legacy.data)
        await this.flush()
        return
      }
    }
    const warningCode: RecoveryReason = rawVersion !== undefined && rawVersion !== 2 && rawVersion !== 3 && rawVersion !== SETTINGS_SCHEMA_VERSION
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
  get sessionBudgetStatus(): SessionBudgetStatus {
    return buildSessionBudgetStatus(this.data.sessionBudget, this.data.settings.sessionBudgetUsd)
  }
  /** Backward-compatible internal alias while callers move to the explicit status name. */
  get sessionBudget(): SessionBudgetStatus { return this.sessionBudgetStatus }
  get recoveryWarning(): SettingsRecoveryWarning | undefined {
    return this.data.recoveryWarning && { ...this.data.recoveryWarning }
  }
  get windowLayoutRevision(): number { return this.data.windowLayoutRevision }
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
    this.data.windowLayoutRevision = WINDOW_LAYOUT_REVISION
    await this.flush()
  }
  async setWindowLayout(bounds: NonNullable<StoredData['windowBounds']>, revision = WINDOW_LAYOUT_REVISION): Promise<void> {
    this.data.windowBounds = boundsSchema.parse(bounds)
    this.data.windowLayoutRevision = z.number().int().min(0).max(WINDOW_LAYOUT_REVISION).parse(revision)
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

  /** Persist a worst-case cost before a provider request can be dispatched. */
  async reserveSessionBudget(
    endpoint: BillableEndpoint,
    requestedModel: string,
    maximumUsd: number
  ): Promise<SessionBudgetReservation> {
    const parsed = sessionBudgetReservationSchema.omit({ id: true, reservedAt: true }).parse({
      endpoint, requestedModel, maximumUsd
    })
    const status = this.sessionBudgetStatus
    if (parsed.maximumUsd > status.remainingUsd + 1e-12) {
      throw new SessionBudgetExceededError(parsed.maximumUsd, status.remainingUsd)
    }
    const reservation: SessionBudgetReservation = {
      ...parsed, id: this.idGenerator(), reservedAt: this.clock().toISOString()
    }
    if (this.data.sessionBudget.reservations.some((candidate) => candidate.id === reservation.id)) {
      throw new Error('The session budget reservation ID already exists.')
    }
    this.data.sessionBudget.reservations.push(reservation)
    await this.flush()
    return structuredClone(reservation)
  }

  /**
   * Replace a conservative hold with exact priced usage. Callers intentionally
   * leave a reservation unsettled when usage is absent or the returned model
   * is not in the exact local price table.
   */
  async settleSessionBudget(
    reservationId: string,
    actualUsd: number,
    keepReservation = false
  ): Promise<SessionBudgetStatus> {
    const actual = z.number().finite().nonnegative().max(100).parse(actualUsd)
    const index = this.data.sessionBudget.reservations.findIndex((candidate) => candidate.id === reservationId)
    if (index < 0) throw new Error('The session budget reservation is no longer active.')
    const reservation = this.data.sessionBudget.reservations[index]!
    if (keepReservation) return this.sessionBudgetStatus
    if (actual > reservation.maximumUsd + 1e-12) {
      throw new Error('Actual request cost exceeded its conservative reservation; the hold was retained.')
    }
    this.data.sessionBudget.reservations.splice(index, 1)
    this.data.sessionBudget.actualUsd = addUsd(this.data.sessionBudget.actualUsd, actual)
    await this.flush()
    return this.sessionBudgetStatus
  }

  /** Release a reservation only when dispatch is known not to have occurred. */
  async releaseSessionBudget(reservationId: string): Promise<SessionBudgetStatus> {
    const index = this.data.sessionBudget.reservations.findIndex((candidate) => candidate.id === reservationId)
    if (index < 0) throw new Error('The session budget reservation is no longer active.')
    this.data.sessionBudget.reservations.splice(index, 1)
    await this.flush()
    return this.sessionBudgetStatus
  }

  /** Confirm that a missing-usage or unpriced request remains fully held. */
  retainSessionBudget(reservationId: string): SessionBudgetStatus {
    if (!this.data.sessionBudget.reservations.some((candidate) => candidate.id === reservationId)) {
      throw new Error('The session budget reservation is no longer active.')
    }
    return this.sessionBudgetStatus
  }

  async startNewSession(): Promise<SessionBudgetStatus> {
    this.data.sessionBudget = defaultSessionBudget(this.clock, this.idGenerator)
    await this.flush()
    return this.sessionBudgetStatus
  }

  async recordUsage(value: UsageRecordInput): Promise<UsageRecord> {
    const input = usageRecordInputSchema.parse(value)
    // Provider provenance is required for exact pricing. A missing returned
    // model or zero-token transcription usage stays visibly unpriced instead
    // of assuming the requested model was served.
    const price = !input.returnedModel || (input.endpoint === 'transcription' && input.inputTokens === 0 && input.outputTokens === 0)
      ? { priced: false, estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION as typeof USAGE_PRICING_VERSION }
      : estimateKnownModelTokens(input.endpoint, input.returnedModel, input.inputTokens, input.outputTokens)
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
  async clearWindowBounds(): Promise<void> {
    delete this.data.windowBounds
    this.data.windowLayoutRevision = WINDOW_LAYOUT_REVISION
    await this.flush()
  }
  async dismissRecoveryWarning(): Promise<void> { delete this.data.recoveryWarning; await this.flush() }
  async clearSettingsData(): Promise<void> {
    this.data.settings = structuredClone(defaultSettings)
    delete this.data.windowBounds
    this.data.windowLayoutRevision = WINDOW_LAYOUT_REVISION
    delete this.data.privacyConsent
    delete this.data.recoveryWarning
    this.data.sessionBudget = defaultSessionBudget(this.clock, this.idGenerator)
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
    return { ...defaultData(this.clock, this.idGenerator), recoveryWarning: recoveryWarning(reason, this.clock()) }
  }

  private migrateLegacy(legacy: z.infer<typeof legacyStoredDataSchema>): StoredData {
    const data: StoredData = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      windowLayoutRevision: legacy.windowBounds ? 0 : WINDOW_LAYOUT_REVISION,
      settings: migrateLegacySettings(legacy.settings),
      ...(legacy.windowBounds ? { windowBounds: legacy.windowBounds } : {}),
      documents: legacy.documents,
      captureResults: legacy.captureResults,
      usage: legacy.usage,
      usageRecords: [],
      usageRollups: [],
      sessionBudget: defaultSessionBudget(this.clock, this.idGenerator)
    }
    if (hasUsage(data.usage)) data.usageRollups.push(legacyUsageRollup(data.usage))
    return data
  }

  private migrateHistorical(
    historical: z.infer<typeof storedDataV2Schema> | z.infer<typeof storedDataV3Schema>
  ): StoredData {
    const {
      schemaVersion, windowLayoutRevision: historicalLayoutRevision, settings, ...preserved
    } = historical
    return {
      ...preserved,
      settings: migrateLegacySettings(settings),
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      windowLayoutRevision: schemaVersion === 2
        ? (historical.windowBounds ? 0 : WINDOW_LAYOUT_REVISION)
        : historicalLayoutRevision,
      sessionBudget: defaultSessionBudget(this.clock, this.idGenerator)
    }
  }

  private migrateOrRecover(raw: unknown, reason: RecoveryReason): StoredData {
    if (!isRecord(raw)) return this.recoveredDefaults(reason)
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      return this.recoveredDefaults(reason)
    }

    const data = defaultData(this.clock, this.idGenerator)
    const recoveredBounds = parseOptional(boundsSchema, raw.windowBounds)
    data.windowLayoutRevision = (raw.schemaVersion === undefined || raw.schemaVersion === 2) && recoveredBounds
      ? 0
      : parseLayoutRevision(raw.windowLayoutRevision)
    data.settings = recoverSettings(raw.settings)
    data.windowBounds = recoveredBounds
    data.documents = parseArrayItems(documentSchema, raw.documents)
    data.captureResults = parseArrayItems(captureResultSchema, raw.captureResults)
    data.usage = usageSummarySchema.safeParse(raw.usage).success
      ? usageSummarySchema.parse(raw.usage)
      : defaultUsage()
    data.usageRecords = parseArrayItems(usageRecordSchema, raw.usageRecords).slice(-MAX_RECENT_USAGE_RECORDS)
    data.usageRollups = parseArrayItems(usageRollupSchema, raw.usageRollups)
    data.sessionBudget = parseOptional(sessionBudgetSchema, raw.sessionBudget) ?? data.sessionBudget
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

function migrateLegacySettings(value: z.infer<typeof legacySettingsSchema>): AppSettings {
  // Native opacity and INR conversion represented concepts that no longer
  // exist. All request, shortcut, audio, and project fields are recovered;
  // the new glass tint and USD cap start from their documented defaults.
  return recoverSettings({
    ...value,
    glassTint: defaultSettings.glassTint,
    sessionBudgetUsd: defaultSettings.sessionBudgetUsd
  })
}

function recoverSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return structuredClone(defaultSettings)
  const recovered: Record<string, unknown> = { ...defaultSettings }
  for (const key of Object.keys(defaultSettings) as Array<keyof AppSettings>) {
    if (!(key in value)) continue
    const parsed = parseSettingsPatchSafely({ [key]: value[key] })
    if (parsed) Object.assign(recovered, parsed)
  }
  // Optional fields are not enumerable on defaults and must be recovered explicitly.
  for (const key of ['selectedAudioEndpointId'] as const) {
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

function buildSessionBudgetStatus(session: StoredSessionBudget, capUsd: number): SessionBudgetStatus {
  const heldUsd = session.reservations.reduce((total, reservation) => addUsd(total, reservation.maximumUsd), 0)
  const remainingUsd = Math.max(0, addUsd(capUsd, -session.actualUsd, -heldUsd))
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    capUsd,
    actualUsd: session.actualUsd,
    heldUsd,
    remainingUsd,
    pricingVersion: USAGE_PRICING_VERSION,
    blocked: remainingUsd <= 1e-12
  }
}

function addUsd(...values: number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(12))
}

function parseLayoutRevision(value: unknown): number {
  const parsed = z.number().int().min(0).max(WINDOW_LAYOUT_REVISION).safeParse(value)
  return parsed.success ? parsed.data : WINDOW_LAYOUT_REVISION
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
