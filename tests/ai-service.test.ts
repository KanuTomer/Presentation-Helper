import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, AssistantResponse, DocumentInfo } from '../src/shared/contracts'
import {
  AiService, AiServiceError, openAIClientOptions, toAiErrorInfo, type AiSettingsProvider, type OpenAIClientLike,
  type OpenAIResponseLike
} from '../src/main/ai/service'

const settings: AppSettings = {
  opacity: 0.9, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
  transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space', projectSummary: ''
}
const response: AssistantResponse = {
  category: 'FACTUAL', say: 'Use evidence that is actually available.', keyPoints: ['State what is known.', 'Name the limitation.'],
  ifChallenged: 'Explain that no project result was supplied.', evidence: []
}

function harness(create: (body: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<OpenAIResponseLike>) {
  const usage = vi.fn(async () => undefined)
  const provider: AiSettingsProvider = { settings: { ...settings }, documents: [] as DocumentInfo[], addUsage: usage }
  const client: OpenAIClientLike = {
    models: { list: async () => [] }, audio: { transcriptions: { create: async () => '' } }, responses: { create }
  }
  const service = new AiService({ getKey: async () => 'sk-test' }, provider, { search: () => [] }, { clientFactory: async () => client })
  return { service, provider, usage }
}
function apiResponse(value: unknown, extra: Partial<OpenAIResponseLike> = {}): OpenAIResponseLike {
  return { output_text: JSON.stringify(value), model: 'gpt-5.6-luna-2026-06-01', usage: { input_tokens: 50, output_tokens: 30 }, ...extra }
}

describe('manual AI service', () => {
  it('sends one bounded, stateless structured Responses request and adds an unsupported-project warning', async () => {
    const create = vi.fn(async () => apiResponse({ ...response, warning: null }))
    const { service, usage } = harness(create)
    const result = await service.ask('  What accuracy did our experiment achieve?  ')
    expect(result.warning).toMatch(/project evidence/i)
    expect(create).toHaveBeenCalledTimes(1)
    const request = create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({ model: 'gpt-5.6-luna', reasoning: { effort: 'none' }, max_output_tokens: 450, store: false })
    expect(request.text).not.toHaveProperty('verbosity')
    expect(request.input).toContain('What accuracy did our experiment achieve?')
    expect(request.text).toMatchObject({ format: { type: 'json_schema', strict: true } })
    expect(usage).toHaveBeenCalledWith(50, 30)
  })

  it('uses Terra with low reasoning in Strong mode', async () => {
    const create = vi.fn(async () => apiResponse(response, { model: 'gpt-5.6-terra-2026-06-01' }))
    const { service, provider } = harness(create); provider.settings.modelMode = 'strong'
    await service.ask('Explain eventual consistency.')
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-terra', reasoning: { effort: 'low' }, max_output_tokens: 1_200,
      text: { verbosity: 'low' }
    })
  })

  it('does not add a project warning to a general technical question', async () => {
    const { service } = harness(async () => apiResponse({ ...response, warning: null }))
    expect((await service.ask('What does classification accuracy mean?')).warning).toBeUndefined()
  })

  it('classifies malformed output and still records returned usage', async () => {
    const { service, usage } = harness(async () => ({ output_text: '{broken', usage: { input_tokens: 12, output_tokens: 4 } }))
    await expect(service.ask('Explain caching.')).rejects.toMatchObject({ code: 'malformed_response', retryable: true })
    expect(usage).toHaveBeenCalledWith(12, 4)
  })

  it('classifies an exhausted output budget distinctly and records reasoning usage', async () => {
    const metrics: Array<{ reasoningTokens: number; outcome: string }> = []
    const usage = vi.fn(async () => undefined)
    const provider: AiSettingsProvider = { settings: { ...settings, modelMode: 'strong' }, documents: [], addUsage: usage }
    const client = {
      models: { list: async () => [] }, audio: { transcriptions: { create: async () => '' } },
      responses: { create: async () => ({
        status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '',
        usage: { input_tokens: 20, output_tokens: 1_200, output_tokens_details: { reasoning_tokens: 1_200 } }
      }) }
    } as OpenAIClientLike
    const service = new AiService({ getKey: async () => 'sk-test' }, provider, { search: () => [] }, {
      clientFactory: async () => client, onMetric: (metric) => metrics.push(metric)
    })
    await expect(service.ask('Explain caching.')).rejects.toMatchObject({ code: 'output_limit', retryable: true })
    expect(usage).toHaveBeenCalledWith(20, 1_200)
    expect(metrics).toMatchObject([{ reasoningTokens: 1_200, outcome: 'output_limit' }])
  })

  it('rejects refusals and empty output as malformed', async () => {
    const refusal = harness(async () => ({ output_text: '', output: [{ type: 'refusal', refusal: 'No.' }] }))
    await expect(refusal.service.ask('Explain caching.')).rejects.toMatchObject({ code: 'malformed_response' })
    const empty = harness(async () => ({ output_text: '   ' }))
    await expect(empty.service.ask('Explain caching.')).rejects.toMatchObject({ code: 'malformed_response' })
  })

  it('rejects overlap and prevents a cancelled late response from entering conversation context', async () => {
    let resolveFirst!: (value: OpenAIResponseLike) => void
    const requests: Record<string, unknown>[] = []
    const create = vi.fn((body: Record<string, unknown>) => {
      requests.push(body)
      if (requests.length === 1) return new Promise<OpenAIResponseLike>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(apiResponse(response))
    })
    const { service } = harness(create)
    const first = service.ask('First private question')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await expect(service.ask('Overlapping question')).rejects.toMatchObject({ code: 'busy' })
    service.cancel(); resolveFirst(apiResponse(response))
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await service.ask('Fresh question')
    expect(String(requests[1]?.input)).not.toContain('First private question')
  })

  it('validates and bounds questions before making a request', async () => {
    const create = vi.fn(async () => apiResponse(response)); const { service } = harness(create)
    await expect(service.ask('   ')).rejects.toMatchObject({ code: 'unknown' })
    await expect(service.ask('x'.repeat(4_001))).rejects.toMatchObject({ code: 'unknown' })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('AI error and retry contract', () => {
  it.each([
    [{ status: 401 }, 'invalid_key', false], [{ status: 429, code: 'rate_limit_exceeded' }, 'rate_limit', true],
    [{ status: 429, code: 'insufficient_quota', type: 'insufficient_quota' }, 'quota', false],
    [{ name: 'APIConnectionTimeoutError' }, 'timeout', true], [{ code: 'ENOTFOUND' }, 'offline', true],
    [{ name: 'AbortError' }, 'cancelled', false]
  ] as const)('maps API failures without leaking provider details', (input, code, retryable) => {
    expect(toAiErrorInfo(input)).toMatchObject({ code, retryable })
  })
  it('preserves typed errors and configures exactly one SDK retry', () => {
    expect(toAiErrorInfo(new AiServiceError('busy', 'Busy.', false))).toEqual({ code: 'busy', message: 'Busy.', retryable: false })
    expect(openAIClientOptions('secret')).toMatchObject({ maxRetries: 1, timeout: 30_000 })
  })
})
