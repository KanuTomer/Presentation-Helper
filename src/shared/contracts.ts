import { z } from 'zod'

const unicodeBoundedString = (minimum: number, maximum: number) => z.string().min(minimum).refine(
  (value) => Array.from(value).length <= maximum,
  `Text is limited to ${maximum} Unicode characters.`
)

export const questionCategories = [
  'QUESTION', 'CHALLENGE', 'CLARIFICATION', 'COMPARISON', 'LIMITATION', 'FACTUAL'
] as const

export type QuestionCategory = (typeof questionCategories)[number]
export type OperationState = 'idle' | 'listening' | 'transcribing' | 'retrieving' | 'generating' | 'error'
export type ModelMode = 'normal' | 'strong'
export type HelperLifecycle = 'missing' | 'starting' | 'ready' | 'capturing' | 'failed'
export type CaptureTestOutcome = 'overlay-absent' | 'overlay-black' | 'overlay-visible' | 'unsupported' | 'untested'
export const aiErrorCodes = [
  'invalid_key', 'quota', 'rate_limit', 'timeout', 'offline', 'cancelled', 'output_limit',
  'malformed_response', 'busy', 'unknown'
] as const
export type AiErrorCode = (typeof aiErrorCodes)[number]

export interface AudioDevice { id: string; name: string; isDefault: boolean }
export interface AudioCaptureResult { path: string; durationMs: number; bytes: number; sampleRate: number; channels: number; endpointId: string }

export interface Evidence { chunkId: string; documentName: string; location: string }
export interface AssistantResponse {
  category: QuestionCategory
  say: string
  keyPoints: string[]
  ifChallenged: string
  warning?: string
  evidence: Evidence[]
}

export const assistantResponseSchema = z.object({
  category: z.enum(questionCategories),
  say: z.string().min(1).max(1800),
  keyPoints: z.array(z.string().min(1).max(300)).min(2).max(4),
  ifChallenged: z.string().min(1).max(800),
  warning: z.string().max(800).optional(),
  evidence: z.array(z.object({
    chunkId: z.string(), documentName: z.string(), location: z.string()
  })).max(8)
})

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
  opacity: number
  clickThrough: boolean
  modelMode: ModelMode
  normalModel: string
  strongModel: string
  transcriptionModel: string
  askShortcut: string
  hideShortcut: string
  listenShortcut: string
  projectSummary: string
  selectedAudioEndpointId?: string
  inrPerUsd?: number
}

export interface AppStatus {
  operation: OperationState
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
  shortcutWarnings: string[]
}

export interface CaptureTestInput {
  path: string
  captureAppVersion: string
  controlResult: CaptureTestOutcome
  protectedResult: CaptureTestOutcome
  notes: string
}

export interface UsageSummary { inputTokens: number; outputTokens: number; audioMinutes: number; estimatedUsd: number }

export interface PresenterAPI {
  getStatus(): Promise<AppStatus>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  hasApiKey(): Promise<boolean>
  saveApiKey(key: string): Promise<void>
  deleteApiKey(): Promise<void>
  testApiKey(): Promise<{ ok: boolean; message: string }>
  ask(question: string): Promise<AskResult>
  cancel(): Promise<void>
  selectDocuments(): Promise<DocumentImportResult>
  listDocuments(): Promise<DocumentInfo[]>
  removeDocument(id: string): Promise<void>
  searchDocuments(query: string): Promise<DocumentSearchHit[]>
  inspectDocument(documentId: string, offset?: number, limit?: number): Promise<DocumentInspectionPage>
  clearSession(): Promise<void>
  getUsage(): Promise<UsageSummary>
  setClickThrough(enabled: boolean): Promise<void>
  setOpacity(value: number): Promise<void>
  showSettings(): Promise<void>
  startListening(): Promise<void>
  stopListening(): Promise<void>
  refreshAudioDevices(): Promise<AudioDevice[]>
  setCaptureProtection(enabled: boolean): Promise<void>
  saveCaptureResult(result: CaptureTestInput): Promise<CaptureCompatibilityResult>
  removeCaptureResult(id: string): Promise<void>
  onStatus(callback: (status: AppStatus) => void): () => void
  onFocusAsk(callback: () => void): () => void
  onOpenSettings(callback: () => void): () => void
  onResponse(callback: (response: AssistantResponse) => void): () => void
  onError(callback: (message: string) => void): () => void
}
