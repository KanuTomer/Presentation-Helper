import { z } from 'zod'

const unicodeBoundedString = (minimum: number, maximum: number) => z.string().min(minimum).refine(
  (value) => Array.from(value).length <= maximum,
  `Text is limited to ${maximum} Unicode characters.`
)

export const questionCategories = [
  'QUESTION', 'CHALLENGE', 'CLARIFICATION', 'COMPARISON', 'LIMITATION', 'FACTUAL'
] as const

export type QuestionCategory = (typeof questionCategories)[number]
export const supportLevels = [
  'document-supported', 'general-technical', 'unsupported-project-claim'
] as const
export type SupportLevel = (typeof supportLevels)[number]
export const evidenceIssues = ['none', 'missing', 'insufficient', 'conflicting'] as const
export type EvidenceIssue = (typeof evidenceIssues)[number]
export const operationStates = [
  'idle', 'starting_capture', 'listening', 'finalizing', 'transcribing', 'retrieving', 'generating', 'cancelling', 'error'
] as const
export type OperationState = (typeof operationStates)[number]
export type OperationKind = 'typed' | 'audio'
export type ModelMode = 'normal' | 'strong'
export type AnswerFormat = 'auto' | 'code'
export type HelperLifecycle = 'missing' | 'starting' | 'ready' | 'capturing' | 'failed'
export type CaptureTestOutcome = 'overlay-absent' | 'overlay-black' | 'overlay-visible' | 'unsupported' | 'untested'
export const aiErrorCodes = [
  'invalid_key', 'quota', 'rate_limit', 'timeout', 'offline', 'cancelled', 'output_limit',
  'malformed_response', 'busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio',
  'invalid_transcript', 'capture_timeout', 'listening_consent_required',
  'privacy_preview_unavailable', 'session_budget_exceeded', 'unpriced_model',
  'transcript_display_unavailable', 'unknown'
] as const
export type AiErrorCode = (typeof aiErrorCodes)[number]

export interface AudioDevice { id: string; name: string; isDefault: boolean }
export type AudioCaptureTerminalReason = 'released' | 'maximum_duration' | 'maximum_size' | 'stopped'
export interface AudioCaptureResult {
  path: string
  durationMs: number
  bytes: number
  sampleRate: number
  channels: number
  endpointId: string
  endpointName: string
  terminalReason: AudioCaptureTerminalReason
}

export interface OperationTimings {
  captureStartMs?: number
  listeningMs?: number
  finalizationMs?: number
  transcriptionMs?: number
  stopToTranscriptMs?: number
  retrievalMs?: number
  generationMs?: number
  stopToAnswerMs?: number
  /** Legacy validation artifacts only. New operations emit stopToAnswerMs. */
  releaseToAnswerMs?: number
  totalMs?: number
}

export interface Evidence { chunkId: string; documentName: string; location: string }
export interface CodeBlock {
  language: string
  title?: string
  code: string
}

export interface TranscriptionDraft {
  operationId: string
  text: string
  durationMs: number
  endpointId: string
  endpointName: string
  createdAt: string
}

export const transcriptionDraftSchema: z.ZodType<TranscriptionDraft> = z.object({
  operationId: z.string().min(1).max(128),
  text: unicodeBoundedString(1, 4_000),
  durationMs: z.number().int().min(250).max(90_000),
  endpointId: z.string().min(1).max(2_048),
  endpointName: unicodeBoundedString(1, 512),
  createdAt: z.string().datetime()
}).strict()
export interface AssistantResponse {
  category: QuestionCategory
  support: SupportLevel
  evidenceIssue: EvidenceIssue
  say: string
  keyPoints: string[]
  ifChallenged: string
  warning?: string
  evidence: Evidence[]
  codeBlocks?: CodeBlock[]
}

export type CodeAssistantResponse = AssistantResponse & { codeBlocks: CodeBlock[] }

export const codeBlockSchema = z.object({
  language: unicodeBoundedString(1, 32).regex(/^[\p{L}\p{N}][\p{L}\p{N}+.#_-]*$/u, 'Use a short programming-language identifier.'),
  title: unicodeBoundedString(1, 120).optional(),
  code: unicodeBoundedString(1, 8_000).refine((value) => value.trim().length > 0, 'Code cannot be blank.')
})

export const codeBlocksSchema = z.array(codeBlockSchema).min(1).max(3).superRefine((blocks, context) => {
  const aggregateLength = blocks.reduce((total, block) => total + Array.from(block.code).length, 0)
  if (aggregateLength > 16_000) {
    context.addIssue({ code: 'custom', message: 'Combined code is limited to 16,000 Unicode characters.' })
  }
})

export const assistantResponseSchema = z.object({
  category: z.enum(questionCategories),
  support: z.enum(supportLevels),
  evidenceIssue: z.enum(evidenceIssues),
  say: z.string().min(1).max(1800),
  keyPoints: z.array(z.string().min(1).max(300)).length(3),
  ifChallenged: z.string().min(1).max(800),
  warning: z.string().max(800).optional(),
  evidence: z.array(z.object({
    chunkId: z.string(), documentName: z.string(), location: z.string()
  })).max(8),
  codeBlocks: z.array(codeBlockSchema).max(3).optional()
})

export const codeAssistantResponseSchema = assistantResponseSchema.extend({ codeBlocks: codeBlocksSchema })

export const questionSchema = z.string().trim().min(1, 'Enter a question first.').max(4_000, 'Questions are limited to 4,000 characters.')
export const aiErrorInfoSchema = z.object({ code: z.enum(aiErrorCodes), message: z.string().min(1).max(800), retryable: z.boolean() })
export type AiErrorInfo = z.infer<typeof aiErrorInfoSchema>
export type AskResult = { ok: true; response: AssistantResponse } | { ok: false; error: AiErrorInfo }
export const askResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), response: assistantResponseSchema }),
  z.object({ ok: z.literal(false), error: aiErrorInfoSchema })
])

export interface DocumentInfo {
  id: string
  name: string
  path: string
  kind: 'pptx' | 'pdf' | 'markdown' | 'text'
  chunkCount: number
  addedAt: string
  updatedAt?: string
}

export const documentErrorCodes = [
  'unsupported_type', 'unreadable', 'malformed', 'encrypted', 'password_protected', 'empty'
] as const
export type DocumentErrorCode = (typeof documentErrorCodes)[number]
export type DocumentImportStatus = 'added' | 'updated' | 'unchanged' | 'failed'
export type DocumentChunkKind = 'slide' | 'speakerNotes' | 'pdfPage' | 'markdown' | 'text'

export interface DocumentErrorInfo {
  code: DocumentErrorCode
  message: string
}

export interface DocumentImportOutcome {
  path: string
  name: string
  status: DocumentImportStatus
  documentId?: string
  error?: DocumentErrorInfo
}

export interface DocumentImportResult {
  documents: DocumentInfo[]
  outcomes: DocumentImportOutcome[]
}

export interface DocumentSearchHit {
  chunkId: string
  documentId: string
  documentName: string
  title?: string
  location: string
  kind: DocumentChunkKind
  preview: string
}

export interface DocumentInspectionChunk {
  id: string
  title?: string
  location: string
  kind: DocumentChunkKind
  text: string
  part: number
  partCount: number
}

export interface DocumentInspectionPage {
  document: DocumentInfo
  chunks: DocumentInspectionChunk[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export const documentSearchQuerySchema = z.string().trim().min(1, 'Enter a search query.').max(500, 'Search queries are limited to 500 characters.')
export const documentIdSchema = z.string().trim().min(1).max(256)
export const documentInspectionRequestSchema = z.object({
  documentId: documentIdSchema,
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50)
})
export const documentImportResultSchema: z.ZodType<DocumentImportResult> = z.object({
  documents: z.array(z.object({
    id: z.string().min(1).max(256), name: z.string().min(1).max(512), path: z.string().min(1).max(32_767),
    kind: z.enum(['pptx', 'pdf', 'markdown', 'text']), chunkCount: z.number().int().min(0),
    addedAt: z.string().min(1), updatedAt: z.string().min(1).optional()
  })),
  outcomes: z.array(z.object({
    path: z.string().min(1).max(32_767), name: z.string().min(1).max(512), status: z.enum(['added', 'updated', 'unchanged', 'failed']),
    documentId: z.string().min(1).max(256).optional(),
    error: z.object({ code: z.enum(documentErrorCodes), message: z.string().min(1).max(800) }).optional()
  }))
})
export const documentSearchHitsSchema: z.ZodType<DocumentSearchHit[]> = z.array(z.object({
  chunkId: z.string().min(1).max(512), documentId: z.string().min(1).max(256), documentName: z.string().min(1).max(512),
  title: unicodeBoundedString(1, 500).optional(), location: unicodeBoundedString(1, 500),
  kind: z.enum(['slide', 'speakerNotes', 'pdfPage', 'markdown', 'text']), preview: unicodeBoundedString(0, 600)
})).max(5)
export const documentInspectionPageSchema: z.ZodType<DocumentInspectionPage> = z.object({
  document: z.object({
    id: z.string().min(1).max(256), name: z.string().min(1).max(512), path: z.string().min(1).max(32_767),
    kind: z.enum(['pptx', 'pdf', 'markdown', 'text']), chunkCount: z.number().int().min(0),
    addedAt: z.string().min(1), updatedAt: z.string().min(1).optional()
  }),
  chunks: z.array(z.object({
    id: z.string().min(1).max(512), title: unicodeBoundedString(1, 500).optional(), location: unicodeBoundedString(1, 500),
    kind: z.enum(['slide', 'speakerNotes', 'pdfPage', 'markdown', 'text']),
    text: z.string().refine((value) => Array.from(value).length <= 2_200, 'Indexed chunks are limited to 2,200 characters.'),
    part: z.number().int().min(1), partCount: z.number().int().min(1)
  })).max(50),
  offset: z.number().int().min(0), limit: z.number().int().min(1).max(50),
  total: z.number().int().min(0), hasMore: z.boolean()
})

export interface CaptureCompatibilityResult {
  id: string
  path: string
  captureAppVersion: string
  controlResult: CaptureTestOutcome
  protectedResult: CaptureTestOutcome
  testedAt: string
  notes: string
  environment: {
    windowsBuild: string
    presenterVersion: string
    electronVersion: string
    gpu: string
    monitorCount: number
  }
}

export interface CaptureProtectionStatus {
  requested: boolean
  electronReported: boolean
  windowsAffinity?: 'NONE' | 'MONITOR' | 'EXCLUDEFROMCAPTURE' | 'UNKNOWN'
  verifiedResults: CaptureCompatibilityResult[]
}

export interface AppSettings {
  glassTint: number
  clickThrough: boolean
  modelMode: ModelMode
  normalModel: string
  strongModel: string
  transcriptionModel: string
  askShortcut: string
  hideShortcut: string
  listenShortcut: string
  projectSummary: string
  approvedVocabulary: string[]
  selectedAudioEndpointId?: string
  sessionBudgetUsd: number
}

export interface SessionBudgetStatus {
  sessionId: string
  startedAt: string
  capUsd: number
  actualUsd: number
  heldUsd: number
  remainingUsd: number
  pricingVersion: string
  blocked: boolean
}

export interface ApiKeyStatus {
  configured: boolean
  masked: boolean
  protection: 'windows-dpapi' | 'unavailable'
  updatedAt?: string
}

export interface PrivacyConsentStatus {
  requiredVersion: number
  acceptedVersion?: number
  acceptedAt?: string
  satisfied: boolean
}
// Version 4 records that stopping capture produces an editable, memory-only
// transcript draft. Retrieval and response generation require a separate,
// explicit submission from the composer.
export const LISTENING_CONSENT_VERSION = 4

export interface OutboundTransmissionPreview {
  operationId: string
  stage: 'transcription' | 'response'
  audio?: { durationMs: number; bytes: number; endpointName: string }
  terminologyHint?: string
  chunks: Array<{
    chunkId: string
    documentName: string
    title?: string
    location: string
    text: string
  }>
  rollingTurnCount: number
  includesProjectSummary: boolean
}

export interface SettingsRecoveryWarning {
  code: 'invalid_json' | 'invalid_shape' | 'unsupported_schema'
  recoveredAt: string
}

export interface AppStatus {
  operation: OperationState
  operationId?: string
  operationKind?: OperationKind
  operationStartedAt?: string
  stageStartedAt?: string
  operationTimings: OperationTimings
  indicatorLatencyMs?: number
  answerRenderConfirmed?: boolean
  transcriptRenderConfirmed?: boolean
  transcriptRenderLatencyMs?: number
  capture: CaptureProtectionStatus
  listening: boolean
  audioSource: string
  temporaryAudioExists: boolean
  helperAvailable: boolean
  helperState: HelperLifecycle
  helperError?: string
  audioDevices: AudioDevice[]
  selectedAudioEndpointId?: string
  lastCapture?: Omit<AudioCaptureResult, 'path'>
  activeAudioEndpoint?: AudioDevice
  operationError?: AiErrorInfo
  shortcutWarnings: string[]
  privacyConsent: PrivacyConsentStatus
  outboundPreview?: OutboundTransmissionPreview
  settingsRecoveryWarning?: SettingsRecoveryWarning
  sessionBudget: SessionBudgetStatus
}

export interface CaptureTestInput {
  path: string
  captureAppVersion: string
  controlResult: CaptureTestOutcome
  protectedResult: CaptureTestOutcome
  notes: string
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  audioMinutes: number
  transcriptionInputTokens: number
  transcriptionAudioTokens: number
  transcriptionOutputTokens: number
  estimatedUsd: number
  pricingVersion: string
}

export type UsageEndpoint = 'responses' | 'transcription'
export interface UsageRecord {
  id: string
  timestamp: string
  endpoint: UsageEndpoint
  requestedModel: string
  returnedModel?: string
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  audioTokens?: number
  durationMs?: number
  pricingVersion: string
  priced: boolean
  estimatedUsd: number
}

export interface UsageRollup {
  endpoint: UsageEndpoint | 'legacy'
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

export type LocalDataScope = 'session' | 'documents' | 'usage' | 'compatibility' | 'settings' | 'consent' | 'api-key' | 'temporary-audio'
export interface LocalDataScopeResult { scope: LocalDataScope; ok: boolean; message?: string }
export interface DeleteAllLocalDataResult { ok: boolean; message?: string; results: LocalDataScopeResult[] }

export type OperationActionResult = { ok: true } | { ok: false; error: AiErrorInfo }

export interface PresenterAPI {
  getStatus(): Promise<AppStatus>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getApiKeyStatus(): Promise<ApiKeyStatus>
  saveApiKey(key: string): Promise<void>
  deleteApiKey(): Promise<void>
  testApiKey(): Promise<{ ok: boolean; message: string }>
  ask(question: string, format?: AnswerFormat): Promise<AskResult>
  cancel(): Promise<OperationActionResult>
  selectDocuments(): Promise<DocumentImportResult>
  listDocuments(): Promise<DocumentInfo[]>
  removeDocument(id: string): Promise<void>
  searchDocuments(query: string): Promise<DocumentSearchHit[]>
  inspectDocument(documentId: string, offset?: number, limit?: number): Promise<DocumentInspectionPage>
  clearSession(): Promise<void>
  startNewSession(): Promise<SessionBudgetStatus>
  getUsage(): Promise<UsageLedger>
  clearUsage(): Promise<void>
  clearCaptureResults(): Promise<void>
  clearAllDocuments(): Promise<void>
  acceptListeningConsent(version: number): Promise<PrivacyConsentStatus>
  acknowledgeTransmissionPreview(operationId: string, stage: OutboundTransmissionPreview['stage']): Promise<void>
  deleteAllLocalData(confirmation: string): Promise<DeleteAllLocalDataResult>
  dismissSettingsRecoveryWarning(): Promise<void>
  setClickThrough(enabled: boolean): Promise<void>
  setGlassTint(value: number): Promise<void>
  showSettings(): Promise<void>
  toggleListening(): Promise<OperationActionResult>
  copyCode(code: string): Promise<void>
  ackListeningIndicator(operationId: string): Promise<void>
  ackAnswerVisible(operationId: string): Promise<void>
  ackTranscriptVisible(operationId: string): Promise<void>
  refreshAudioDevices(): Promise<AudioDevice[]>
  setCaptureProtection(enabled: boolean): Promise<void>
  saveCaptureResult(result: CaptureTestInput): Promise<CaptureCompatibilityResult>
  removeCaptureResult(id: string): Promise<void>
  onStatus(callback: (status: AppStatus) => void): () => void
  onFocusAsk(callback: () => void): () => void
  onOpenSettings(callback: () => void): () => void
  onOpenPrivacy(callback: () => void): () => void
  onTranscriptDraft(callback: (draft: TranscriptionDraft) => void): () => void
  onError(callback: (error: AiErrorInfo) => void): () => void
}
