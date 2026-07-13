import OpenAI, { toFile } from 'openai'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  assistantResponseSchema, questionSchema, type AiErrorCode, type AiErrorInfo, type AppSettings,
  type AssistantResponse, type DocumentInfo
} from '../../shared/contracts.js'
import type { RetrievedChunk } from '../retrieval/index.js'
import { ConversationContext } from './conversation.js'
import { buildInput, presenterInstructions, responseJsonSchema } from './prompts.js'
import { responseRequestPolicy } from './requestPolicy.js'

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
  audio: { transcriptions: { create(body: Record<string, unknown>, options: { signal: AbortSignal }): Promise<string> } }
  responses: { create(body: Record<string, unknown>, options: { signal: AbortSignal }): Promise<OpenAIResponseLike> }
}
export interface SecretProvider { getKey(): Promise<string> }
export interface AiSettingsProvider {
  readonly settings: AppSettings
  readonly documents: DocumentInfo[]
  addUsage(inputTokens: number, outputTokens: number, audioMinutes?: number): Promise<void>
}
export interface RetrievalProvider { search(query: string, limit?: number): RetrievedChunk[] }
export interface AiRequestMetric {
  operationId: string
  requestedModel: string
  returnedModel?: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  outcome: 'success' | AiErrorCode
}
export interface AiServiceOptions {
  clientFactory?: () => Promise<OpenAIClientLike>
  onMetric?: (metric: AiRequestMetric) => void
}

export class AiServiceError extends Error {
  constructor(public readonly code: AiErrorCode, message: string, public readonly retryable: boolean) { super(message); this.name = 'AiServiceError' }
}

export class AiService {
  private active?: { id: string; controller: AbortController }
  private transcriptionAbort?: AbortController
  private context = new ConversationContext()
  constructor(
    private secrets: SecretProvider,
    private settings: AiSettingsProvider,
    private retrieval: RetrievalProvider,
    private options: AiServiceOptions = {}
  ) {}

  get isBusy(): boolean { return this.active !== undefined }
  cancel(): void { this.active?.controller.abort(); this.transcriptionAbort?.abort() }
  clearSession(): void { this.context.clear() }
  async testKey(): Promise<{ ok: boolean; message: string }> {
    try { const client = await this.client(); await client.models.list(); return { ok: true, message: 'API key is valid.' } }
    catch (error) { return { ok: false, message: toAiErrorInfo(error).message } }
  }
  async transcribe(path: string): Promise<string> {
    const client = await this.client(); const controller = new AbortController(); this.transcriptionAbort = controller
    try {
      const bytes = await readFile(path)
      return await client.audio.transcriptions.create({
        file: await toFile(bytes, 'reviewer.wav', { type: 'audio/wav' }), model: this.settings.settings.transcriptionModel,
        response_format: 'text', prompt: this.settings.documents.map((doc) => doc.name).join(', ').slice(0, 500)
      }, { signal: controller.signal })
    } catch (error) { throw asAiServiceError(error) }
    finally { if (this.transcriptionAbort === controller) this.transcriptionAbort = undefined }
  }
  async ask(question: string): Promise<AssistantResponse> {
    const validated = questionSchema.safeParse(question)
    if (!validated.success) throw new AiServiceError('unknown', validated.error.issues[0]?.message ?? 'Enter a valid question.', false)
    if (this.active) throw new AiServiceError('busy', 'Another question is already being answered.', false)

    const operation = { id: randomUUID(), controller: new AbortController() }
    this.active = operation
    const startedAt = performance.now()
    const settings = this.settings.settings
    const requestedModel = settings.modelMode === 'strong' ? settings.strongModel : settings.normalModel
    const policy = responseRequestPolicy(settings.modelMode)
    let response: OpenAIResponseLike | undefined
    let outcome: AiRequestMetric['outcome'] = 'unknown'
    try {
      const chunks = this.retrieval.search(validated.data, 5)
      const allowed = new Map(chunks.map((chunk) => [chunk.id, chunk]))
      const client = await this.client()
      response = await client.responses.create({
        model: requestedModel,
        reasoning: { effort: policy.reasoningEffort },
        instructions: presenterInstructions,
        input: buildInput(validated.data, chunks, this.context.asPrompt(), settings.projectSummary),
        max_output_tokens: policy.maxOutputTokens, store: false,
        text: {
          ...(policy.verbosity ? { verbosity: policy.verbosity } : {}),
          format: { type: 'json_schema', name: 'presenter_response', strict: true, schema: responseJsonSchema }
        }
      }, { signal: operation.controller.signal })
      if (operation.controller.signal.aborted || this.active?.id !== operation.id) throw new AiServiceError('cancelled', 'Operation cancelled.', false)
      if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') throw outputLimitResponse()
      if (containsRefusal(response.output) || !response.output_text?.trim()) throw malformedResponse()
      let raw: unknown
      try { raw = JSON.parse(response.output_text) } catch { throw malformedResponse() }
      if (raw && typeof raw === 'object' && 'warning' in raw && (raw as { warning: unknown }).warning === null) delete (raw as { warning?: unknown }).warning
      const validation = assistantResponseSchema.safeParse(raw)
      if (!validation.success) throw malformedResponse()
      const parsed = validation.data
      parsed.evidence = parsed.evidence.filter((item) => allowed.has(item.chunkId)).map((item) => {
        const chunk = allowed.get(item.chunkId)!; return { chunkId: chunk.id, documentName: chunk.documentName, location: chunk.location }
      })
      if (parsed.evidence.length === 0 && !parsed.warning && requiresProjectEvidence(validated.data)) {
        parsed.warning = 'No project evidence was supplied for this project-specific claim.'
      }
      if (operation.controller.signal.aborted || this.active?.id !== operation.id) throw new AiServiceError('cancelled', 'Operation cancelled.', false)
      this.context.add(validated.data, parsed)
      outcome = 'success'
      return parsed
    } catch (error) {
      const mapped = asAiServiceError(error); outcome = mapped.code; throw mapped
    } finally {
      const inputTokens = response?.usage?.input_tokens ?? 0
      const outputTokens = response?.usage?.output_tokens ?? 0
      const reasoningTokens = response?.usage?.output_tokens_details?.reasoning_tokens ?? 0
      if (response?.usage) await this.settings.addUsage(inputTokens, outputTokens).catch(() => undefined)
      this.options.onMetric?.({
        operationId: operation.id, requestedModel, returnedModel: response?.model, latencyMs: performance.now() - startedAt,
        inputTokens, outputTokens, reasoningTokens, outcome
      })
      if (this.active?.id === operation.id) this.active = undefined
    }
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
function containsRefusal(output: unknown[] | undefined): boolean {
  return Boolean(output?.some((item) => item && typeof item === 'object' && ((item as { type?: string }).type === 'refusal' || JSON.stringify(item).includes('"refusal"'))))
}
function requiresProjectEvidence(question: string): boolean {
  const projectReference = /\b(our|my|we|this (?:project|system|prototype|implementation|approach|model))\b/i.test(question)
  const projectClaim = /\b(result|accuracy|runtime|dataset|training data|outperform|experiment|implemented|algorithm|benchmark|baseline|hardware|participant|precision|recall|ablation|cost|failure rate|memory)\b/i.test(question)
  return projectReference && projectClaim
}
