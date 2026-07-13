import { z } from 'zod'

export const questionCategories = [
  'QUESTION', 'CHALLENGE', 'CLARIFICATION', 'COMPARISON', 'LIMITATION', 'FACTUAL'
] as const

export type QuestionCategory = (typeof questionCategories)[number]
export type OperationState = 'idle' | 'listening' | 'transcribing' | 'retrieving' | 'generating' | 'error'
export type ModelMode = 'normal' | 'strong'

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

export interface DocumentInfo {
  id: string
  name: string
  path: string
  kind: 'pptx' | 'pdf' | 'markdown' | 'text'
  chunkCount: number
  addedAt: string
}

export interface CaptureCompatibilityResult {
  id: string
  path: string
  appVersion: string
  result: 'overlay-absent' | 'overlay-black' | 'overlay-visible' | 'untested'
  testedAt: string
  notes: string
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
  inrPerUsd?: number
}

export interface AppStatus {
  operation: OperationState
  capture: CaptureProtectionStatus
  listening: boolean
  audioSource: string
  temporaryAudioExists: boolean
  helperAvailable: boolean
  shortcutWarnings: string[]
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
  ask(question: string): Promise<AssistantResponse>
  cancel(): Promise<void>
  selectDocuments(): Promise<DocumentInfo[]>
  listDocuments(): Promise<DocumentInfo[]>
  removeDocument(id: string): Promise<void>
  clearSession(): Promise<void>
  getUsage(): Promise<UsageSummary>
  setClickThrough(enabled: boolean): Promise<void>
  setOpacity(value: number): Promise<void>
  showSettings(): Promise<void>
  startListening(): Promise<void>
  stopListening(): Promise<void>
  onStatus(callback: (status: AppStatus) => void): () => void
  onFocusAsk(callback: () => void): () => void
  onOpenSettings(callback: () => void): () => void
  onResponse(callback: (response: AssistantResponse) => void): () => void
  onError(callback: (message: string) => void): () => void
}
