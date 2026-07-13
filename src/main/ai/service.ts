import OpenAI, { toFile } from 'openai'
import { readFile } from 'node:fs/promises'
import { assistantResponseSchema, type AssistantResponse } from '../../shared/contracts.js'
import type { SecretStore } from '../settings/secrets.js'
import type { SettingsStore } from '../settings/store.js'
import type { RetrievalIndex } from '../retrieval/index.js'
import { ConversationContext } from './conversation.js'
import { buildInput, presenterInstructions, responseJsonSchema } from './prompts.js'

export class AiService {
  private abort?: AbortController
  private context = new ConversationContext()
  constructor(private secrets: SecretStore, private settings: SettingsStore, private retrieval: RetrievalIndex) {}

  cancel(): void { this.abort?.abort(); this.abort = undefined }
  clearSession(): void { this.context.clear() }
  async testKey(): Promise<{ ok: boolean; message: string }> {
    try { const client = await this.client(); await client.models.list(); return { ok: true, message: 'API key is valid.' } }
    catch (error) { return { ok: false, message: friendlyError(error) } }
  }
  async transcribe(path: string): Promise<string> {
    const client = await this.client(); this.abort = new AbortController()
    const bytes = await readFile(path)
    const response = await client.audio.transcriptions.create({
      file: await toFile(bytes, 'reviewer.wav', { type: 'audio/wav' }), model: this.settings.settings.transcriptionModel,
      response_format: 'text', prompt: this.settings.documents.map((doc) => doc.name).join(', ').slice(0, 500)
    }, { signal: this.abort.signal })
    return response
  }
  async ask(question: string): Promise<AssistantResponse> {
    if (!question.trim()) throw new Error('Enter a question first.')
    this.abort = new AbortController()
    const chunks = this.retrieval.search(question, 5)
    const allowed = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    const settings = this.settings.settings
    const client = await this.client()
    try {
      const response = await client.responses.create({
        model: settings.modelMode === 'strong' ? settings.strongModel : settings.normalModel,
        reasoning: { effort: settings.modelMode === 'strong' ? 'low' : 'none' },
        instructions: presenterInstructions,
        input: buildInput(question, chunks, this.context.asPrompt(), settings.projectSummary),
        max_output_tokens: 450, store: false,
        text: { format: { type: 'json_schema', name: 'presenter_response', strict: true, schema: responseJsonSchema } }
      }, { signal: this.abort.signal })
      const raw = JSON.parse(response.output_text) as unknown
      if (raw && typeof raw === 'object' && 'warning' in raw && (raw as { warning: unknown }).warning === null) delete (raw as { warning?: unknown }).warning
      const parsed = assistantResponseSchema.parse(raw)
      parsed.evidence = parsed.evidence.filter((item) => allowed.has(item.chunkId)).map((item) => {
        const chunk = allowed.get(item.chunkId)!; return { chunkId: chunk.id, documentName: chunk.documentName, location: chunk.location }
      })
      if (parsed.evidence.length === 0 && !parsed.warning && /\b(our|my|we|result|accuracy|runtime|dataset|outperform|experiment|implemented)\b/i.test(question)) {
        parsed.warning = 'The uploaded documents do not provide enough evidence for a project-specific claim.'
      }
      this.context.add(question, parsed)
      await this.settings.addUsage(response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0)
      return parsed
    } catch (error) { if ((error as Error).name === 'AbortError') throw new Error('Operation cancelled.'); throw new Error(friendlyError(error)) }
    finally { this.abort = undefined }
  }
  private async client(): Promise<OpenAI> { return new OpenAI({ apiKey: await this.secrets.getKey(), maxRetries: 1, timeout: 30_000 }) }
}

function friendlyError(error: unknown): string {
  const value = error as { status?: number; code?: string; message?: string; name?: string }
  if (value.name === 'AbortError') return 'Operation cancelled.'
  if (value.status === 401) return 'The OpenAI API key is invalid.'
  if (value.status === 429) return 'OpenAI rate limit or API quota reached.'
  if (value.code === 'ETIMEDOUT' || value.name === 'APIConnectionTimeoutError') return 'The OpenAI request timed out.'
  return value.message || 'OpenAI request failed.'
}
