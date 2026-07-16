import OpenAI, { toFile } from 'openai'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  assistantResponseSchema, questionSchema, type AiErrorCode, type AiErrorInfo, type AppSettings,
  type AssistantResponse, type DocumentInfo
} from '../../shared/contracts.js'
import type { RetrievedChunk } from '../retrieval/index.js'
import { ConversationContext } from './conversation.js'
import { validateGroundingResponse } from './grounding.js'
import { attachPreparedAnswer, prepareAnswer, preparedAnswerFromChunks, type PreparedAnswer } from './preparedAnswer.js'
import { buildInput, presenterInstructions, responseJsonSchema } from './prompts.js'
import { responseRequestPolicy } from './requestPolicy.js'
import {
  buildTerminologyHint, normalizeTranscript, parseTranscriptionMetadata, parseTranscriptionResponse,
  type TranscriptionResult, type TranscriptionUsage
} from './transcription.js'

export interface OpenAIResponseLike {
  output_text?: string
  output?: unknown[]
  model?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    output_tokens_details?: { reasoning_tokens?: number }
  }
}
export interface OpenAIClientLike {
  models: { list(): Promise<unknown> }
  audio: { transcriptions: { create(body: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown> } }
  responses: { create(body: Record<string, unknown>, options: { signal: AbortSignal }): Promise<OpenAIResponseLike> }
}
export interface SecretProvider { getKey(): Promise<string> }
export interface AiSettingsProvider {
  readonly settings: AppSettings
  readonly documents: DocumentInfo[]
  addUsage(inputTokens: number, outputTokens: number, audioMinutes?: number): Promise<void>
  addTranscriptionUsage(usage: TranscriptionUsage, model: string, requestedModel?: string, durationMs?: number): Promise<void>
  recordUsage?(input: {
    endpoint: 'responses' | 'transcription'
    requestedModel: string
    returnedModel?: string
    inputTokens: number
    outputTokens: number
    reasoningTokens?: number
    audioTokens?: number
    durationMs?: number
  }): Promise<unknown>
}
export interface RetrievalProvider {
  search(query: string, limit?: number): RetrievedChunk[]
  documentTitles?(): readonly string[]
}
export interface AiRequestMetric {
  operationId: string
  requestedModel: string
  returnedModel?: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  usagePresent: boolean
  requestDispatched: boolean
  outcome: 'success' | AiErrorCode
}
export interface AiServiceOptions {
  clientFactory?: () => Promise<OpenAIClientLike>
  onMetric?: (metric: AiRequestMetric) => void
  onTranscriptionMetric?: (metric: TranscriptionMetric) => void
}
export interface TranscriptionMetric {
  requestedModel: string
  returnedModel?: string
  latencyMs: number
  usage: TranscriptionUsage
  requestDispatched: boolean
  outcome: 'success' | AiErrorCode
}
export interface TranscriptionOptions {
  signal: AbortSignal
  approvedVocabulary?: readonly string[]
  durationMs?: number
  /** Immutable hint already disclosed in the outbound preview. */
  terminologyHint?: string
}
export interface TranscriptionAudioSource {
  /** Exact validated byte snapshot; no renderer-controlled path is uploaded. */
  bytes: Uint8Array
  filename?: string
}
export interface AskOptions {
  signal?: AbortSignal
  onStage?: (stage: 'retrieving' | 'generating') => void
}
export interface GenerateOptions {
  signal?: AbortSignal
}

export class AiServiceError extends Error {
  constructor(public readonly code: AiErrorCode, message: string, public readonly retryable: boolean) { super(message); this.name = 'AiServiceError' }
}

export class AiService {
  private active?: { id: string; controller?: AbortController; signal: AbortSignal }
  private context = new ConversationContext()
  constructor(
    private secrets: SecretProvider,
    private settings: AiSettingsProvider,
    private retrieval: RetrievalProvider,
    private options: AiServiceOptions = {}
  ) {}

  get isBusy(): boolean { return this.active !== undefined }
  cancel(): void { this.active?.controller?.abort() }
  clearSession(): void { this.context.clear() }
  transcriptionTerminologyHint(extraVocabulary: readonly string[] = []): string {
    return buildTerminologyHint({
      approvedVocabulary: [...(this.settings.settings.approvedVocabulary ?? []), ...extraVocabulary],
      documentNames: this.settings.documents.map((document) => document.name),
      documentTitles: this.documentTitles()
    })
  }
  async testKey(): Promise<{ ok: boolean; message: string }> {
    try { const client = await this.client(); await client.models.list(); return { ok: true, message: 'API key is valid.' } }
    catch (error) { return { ok: false, message: toAiErrorInfo(error).message } }
  }
  async transcribe(source: string | TranscriptionAudioSource, options: TranscriptionOptions): Promise<TranscriptionResult> {
    const startedAt = performance.now()
    const requestedModel = this.settings.settings.transcriptionModel
    let returnedModel: string | undefined
    let usage: TranscriptionUsage = emptyTranscriptionUsage()
    let outcome: TranscriptionMetric['outcome'] = 'unknown'
    let requestDispatched = false
    try {
      throwIfAborted(options.signal)
      // The string form remains available for isolated service tests and tools.
      // Production capture passes a validated in-memory snapshot so the bytes
      // cannot change between WAV validation and multipart construction.
      const bytes = typeof source === 'string'
        ? await readFile(source, { signal: options.signal })
        : Buffer.from(source.bytes)
      throwIfAborted(options.signal)
      const client = await this.client()
      const hint = options.terminologyHint ?? this.transcriptionTerminologyHint(options.approvedVocabulary)
      requestDispatched = true
      const raw = await client.audio.transcriptions.create({
        file: await toFile(bytes, typeof source === 'string' ? 'reviewer.wav' : source.filename ?? 'reviewer.wav', { type: 'audio/wav' }),
        model: requestedModel,
        response_format: 'json',
        ...(hint ? { prompt: hint } : {})
      }, { signal: options.signal })
      const metadata = parseTranscriptionMetadata(raw)
      if (metadata) {
        returnedModel = metadata.model
        usage = metadata.usage
      }
      await this.recordTranscriptionUsage(requestedModel, returnedModel, usage, options.durationMs)
      // Cancellation suppresses transcript/retrieval use, but a provider
      // response that already arrived may be billable and its returned usage
      // must be recorded first.
      throwIfAborted(options.signal)
      if (!metadata) throw invalidTranscriptResponse()
      const parsed = parseTranscriptionResponse(raw)
      if (!parsed) throw invalidTranscriptResponse()
      const text = normalizeTranscript(parsed.text)
      if (!text) throw invalidTranscriptResponse()
      outcome = 'success'
      return { text, ...(returnedModel ? { model: returnedModel } : {}), latencyMs: performance.now() - startedAt, usage }
    } catch (error) {
      const mapped = asAiServiceError(error)
      outcome = mapped.code
      throw mapped
    } finally {
      this.options.onTranscriptionMetric?.({
        requestedModel, ...(returnedModel ? { returnedModel } : {}),
        latencyMs: performance.now() - startedAt, usage, outcome, requestDispatched
      })
    }
  }
  retrieve(question: string, options: { signal?: AbortSignal } = {}): RetrievedChunk[] {
    const validated = questionSchema.safeParse(question)
    if (!validated.success) throw new AiServiceError('unknown', validated.error.issues[0]?.message ?? 'Enter a valid question.', false)
    if (options.signal) throwIfAborted(options.signal)
    const prepared = this.prepare(validated.data, options.signal)
    if (options.signal) throwIfAborted(options.signal)
    return attachPreparedAnswer(prepared)
  }
  async ask(question: string, options: AskOptions = {}): Promise<AssistantResponse> {
    if (this.active) throw new AiServiceError('busy', 'Another question is already being answered.', false)
    options.onStage?.('retrieving')
    const chunks = this.retrieve(question, { signal: options.signal })
    options.onStage?.('generating')
    return this.generate(question, chunks, { signal: options.signal })
  }
  async generate(
    question: string,
    chunks: RetrievedChunk[],
    options: GenerateOptions = {}
  ): Promise<AssistantResponse> {
    const validated = questionSchema.safeParse(question)
    if (!validated.success) throw new AiServiceError('unknown', validated.error.issues[0]?.message ?? 'Enter a valid question.', false)
    if (this.active) throw new AiServiceError('busy', 'Another question is already being answered.', false)
    if (options.signal) throwIfAborted(options.signal)

    const controller = options.signal ? undefined : new AbortController()
    const operation = { id: randomUUID(), ...(controller ? { controller } : {}), signal: options.signal ?? controller!.signal }
    this.active = operation
    const startedAt = performance.now()
    const settings = this.settings.settings
    const requestedModel = settings.modelMode === 'strong' ? settings.strongModel : settings.normalModel
    const policy = responseRequestPolicy(settings.modelMode)
    let response: OpenAIResponseLike | undefined
    let outcome: AiRequestMetric['outcome'] = 'unknown'
    let requestDispatched = false
    try {
      const prepared = this.resolvePrepared(validated.data, chunks, operation.signal)
      const selectedChunks = [...prepared.chunks]
      const allowed = new Map(selectedChunks.map((chunk) => [chunk.id, chunk]))
      const client = await this.client()
      requestDispatched = true
      response = await client.responses.create({
        model: requestedModel,
        reasoning: { effort: policy.reasoningEffort },
        instructions: presenterInstructions,
        input: buildInput(prepared.question, selectedChunks, prepared.conversationPrompt, prepared.projectSummary),
        max_output_tokens: policy.maxOutputTokens, store: false,
        text: {
          ...(policy.verbosity ? { verbosity: policy.verbosity } : {}),
          format: { type: 'json_schema', name: 'presenter_response', strict: true, schema: responseJsonSchema }
        }
      }, { signal: operation.signal })
      ensureCurrentOperation(operation, this.active)
      if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') throw outputLimitResponse()
      if (containsRefusal(response.output) || !response.output_text?.trim()) throw malformedResponse()
      let raw: unknown
      try { raw = JSON.parse(response.output_text) } catch { throw malformedResponse() }
      if (raw && typeof raw === 'object' && 'warning' in raw && (raw as { warning: unknown }).warning === null) delete (raw as { warning?: unknown }).warning
      const validation = assistantResponseSchema.safeParse(raw)
      if (!validation.success) throw malformedResponse()
      const parsed = validation.data
      const citedIds = parsed.evidence.map((item) => item.chunkId)
      if (new Set(citedIds).size !== citedIds.length || citedIds.some((chunkId) => !allowed.has(chunkId))) {
        throw malformedResponse()
      }
      parsed.evidence = parsed.evidence.map((item) => {
        const chunk = allowed.get(item.chunkId)!; return { chunkId: chunk.id, documentName: chunk.documentName, location: chunk.location }
      })
      if (!validateGroundingResponse(parsed, prepared.question, selectedChunks).valid) throw malformedResponse()
      ensureCurrentOperation(operation, this.active)
      this.context.add(prepared.question, parsed, prepared.contextRevision)
      outcome = 'success'
      return parsed
    } catch (error) {
      const mapped = asAiServiceError(error); outcome = mapped.code; throw mapped
    } finally {
      const inputTokens = response?.usage?.input_tokens ?? 0
      const outputTokens = response?.usage?.output_tokens ?? 0
      const reasoningTokens = response?.usage?.output_tokens_details?.reasoning_tokens ?? 0
      if (response?.usage) {
        if (this.settings.recordUsage) {
          await this.settings.recordUsage({
            endpoint: 'responses', requestedModel, ...(response.model ? { returnedModel: response.model } : {}),
            inputTokens, outputTokens, reasoningTokens
          }).catch(() => undefined)
        } else {
          await this.settings.addUsage(inputTokens, outputTokens).catch(() => undefined)
        }
      }
      this.options.onMetric?.({
        operationId: operation.id, requestedModel, returnedModel: response?.model, latencyMs: performance.now() - startedAt,
        inputTokens, outputTokens, reasoningTokens, outcome,
        usagePresent: Boolean(response?.usage), requestDispatched
      })
      if (this.active?.id === operation.id) this.active = undefined
    }
  }
  private documentTitles(): readonly string[] {
    try { return this.retrieval.documentTitles?.() ?? [] }
    catch { return [] }
  }
  private async recordTranscriptionUsage(
    requestedModel: string,
    returnedModel: string | undefined,
    usage: TranscriptionUsage,
    durationMs: number | undefined
  ): Promise<void> {
    if (usage.type === 'none') return
    if (this.settings.recordUsage) {
      await this.settings.recordUsage({
        endpoint: 'transcription', requestedModel, ...(returnedModel ? { returnedModel } : {}),
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, audioTokens: usage.audioTokens,
        ...(durationMs === undefined ? {} : { durationMs })
      }).catch(() => undefined)
      return
    }
    await this.settings.addTranscriptionUsage(usage, returnedModel ?? requestedModel).catch(() => undefined)
  }
  private prepare(question: string, signal?: AbortSignal): PreparedAnswer {
    return prepareAnswer({
      question,
      context: this.context,
      projectSummary: this.settings.settings.projectSummary,
      search: (query, limit) => this.retrieval.search(query, limit),
      ...(signal ? { signal } : {})
    })
  }
  private resolvePrepared(question: string, chunks: RetrievedChunk[], signal: AbortSignal): PreparedAnswer {
    const attached = preparedAnswerFromChunks(chunks)
    // The renderer preview and the model request must describe the exact same
    // immutable snapshot. Clearing the session after retrieval increments the
    // revision so the late answer cannot repopulate context, but it must not
    // silently replace already-previewed chunks or background.
    if (attached?.question === question) return attached
    if (attached) return this.prepare(question, signal)
    return prepareAnswer({
      question,
      context: this.context,
      projectSummary: this.settings.settings.projectSummary,
      chunks,
      signal
    })
  }
  private async client(): Promise<OpenAIClientLike> {
    if (this.options.clientFactory) return this.options.clientFactory()
    return new OpenAI(openAIClientOptions(await this.secrets.getKey())) as unknown as OpenAIClientLike
  }
}

export function openAIClientOptions(apiKey: string): ConstructorParameters<typeof OpenAI>[0] {
  return { apiKey, maxRetries: 1, timeout: 30_000 }
}
export function toAiErrorInfo(error: unknown): AiErrorInfo {
  const mapped = asAiServiceError(error)
  return { code: mapped.code, message: mapped.message, retryable: mapped.retryable }
}
export function asAiServiceError(error: unknown): AiServiceError {
  if (error instanceof AiServiceError) return error
  const value = error as { status?: number; code?: string; type?: string; message?: string; name?: string }
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') return new AiServiceError('cancelled', 'Operation cancelled.', false)
  if (value.status === 401) return new AiServiceError('invalid_key', 'The OpenAI API key is invalid.', false)
  if (['insufficient_quota', 'billing_hard_limit_reached', 'usage_limit_reached'].includes(value.code ?? '') || value.type === 'insufficient_quota') {
    return new AiServiceError('quota', 'The OpenAI project has no available API quota. Check billing and usage limits.', false)
  }
  if (value.status === 429 || value.code === 'rate_limit_exceeded') {
    return new AiServiceError('rate_limit', 'OpenAI is temporarily rate limiting requests. Wait for the limit to reset.', true)
  }
  if (value.code === 'ETIMEDOUT' || value.name === 'APIConnectionTimeoutError') return new AiServiceError('timeout', 'The OpenAI request timed out.', true)
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'].includes(value.code ?? '') || value.name === 'APIConnectionError') {
    return new AiServiceError('offline', 'PresenterAI could not reach OpenAI. Check the network connection.', true)
  }
  return new AiServiceError('unknown', 'OpenAI request failed.', false)
}
function malformedResponse(): AiServiceError { return new AiServiceError('malformed_response', 'OpenAI returned an invalid structured response. Please retry.', true) }
function outputLimitResponse(): AiServiceError {
  return new AiServiceError('output_limit', 'OpenAI used the response budget before completing the answer. Retry, shorten the question, or use Normal mode.', true)
}
function invalidTranscriptResponse(): AiServiceError {
  return new AiServiceError('invalid_transcript', 'OpenAI returned an empty or invalid transcript. Try recording the question again.', true)
}
function emptyTranscriptionUsage(): TranscriptionUsage {
  return { type: 'none', inputTokens: 0, outputTokens: 0, totalTokens: 0, audioTokens: 0, textTokens: 0 }
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AiServiceError('cancelled', 'Operation cancelled.', false)
}
function ensureCurrentOperation(
  operation: { id: string; signal: AbortSignal },
  active: { id: string } | undefined
): void {
  if (operation.signal.aborted || active?.id !== operation.id) {
    throw new AiServiceError('cancelled', 'Operation cancelled.', false)
  }
}
function containsRefusal(output: unknown[] | undefined): boolean {
  return Boolean(output?.some((item) => item && typeof item === 'object' && ((item as { type?: string }).type === 'refusal' || JSON.stringify(item).includes('"refusal"'))))
}
