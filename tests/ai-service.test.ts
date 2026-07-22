import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, AssistantResponse, DocumentInfo } from '../src/shared/contracts'
import {
  AiService, AiServiceError, openAIClientOptions, toAiErrorInfo, type AiSettingsProvider, type OpenAIClientLike,
  type OpenAIResponseLike
} from '../src/main/ai/service'
import type { RetrievedChunk } from '../src/main/retrieval'

const settings: AppSettings = {
  glassTint: 0.42, sessionBudgetUsd: 0.25, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
  transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space', projectSummary: '', approvedVocabulary: []
}
const response: AssistantResponse = {
  category: 'FACTUAL', support: 'general-technical', evidenceIssue: 'none',
  say: 'Use evidence that is actually available.', keyPoints: ['State what is known.', 'Name the limitation.', 'Avoid unsupported claims.'],
  ifChallenged: 'Explain that no project result was supplied.', evidence: []
}

function harness(
  create: (body: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<OpenAIResponseLike>,
  chunks: RetrievedChunk[] = [],
  search?: (query: string, limit?: number) => RetrievedChunk[]
) {
  const usage = vi.fn(async () => undefined)
  const provider: AiSettingsProvider = {
    settings: { ...settings }, documents: [] as DocumentInfo[], addUsage: usage,
    addTranscriptionUsage: vi.fn(async () => undefined)
  }
  const client: OpenAIClientLike = {
    models: { list: async () => [] }, audio: { transcriptions: { create: async () => '' } }, responses: { create }
  }
  const service = new AiService({ getKey: async () => 'sk-test' }, provider, { search: search ?? (() => chunks) }, { clientFactory: async () => client })
  return { service, provider, usage }
}
function apiResponse(value: unknown, extra: Partial<OpenAIResponseLike> = {}): OpenAIResponseLike {
  return { output_text: JSON.stringify(value), model: 'gpt-5.6-luna-2026-06-01', usage: { input_tokens: 50, output_tokens: 30 }, ...extra }
}

describe('manual AI service', () => {
  it('sends one bounded, stateless structured Responses request and preserves an unsupported-project warning', async () => {
    const create = vi.fn(async () => apiResponse({
      ...response, support: 'unsupported-project-claim', evidenceIssue: 'missing',
      warning: 'No project evidence was supplied for this project-specific claim.'
    }))
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
    const provider: AiSettingsProvider = {
      settings: { ...settings, modelMode: 'strong' }, documents: [], addUsage: usage,
      addTranscriptionUsage: vi.fn(async () => undefined)
    }
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

  it('rejects forged and duplicate citations, and canonicalizes valid citation metadata', async () => {
    const chunk = {
      id: 'doc-1:text:method:part:1', documentId: 'doc-1', text: 'The cache uses a bounded least-recently-used policy.',
      kind: 'text', part: 1, partCount: 1, documentName: 'architecture.txt', location: 'Method', score: -1
    } as RetrievedChunk
    const forged = harness(async () => apiResponse({
      ...response, evidence: [{ chunkId: 'forged', documentName: 'fake.txt', location: 'Nowhere' }]
    }), [chunk])
    await expect(forged.service.ask('What cache policy does our system use?')).rejects.toMatchObject({ code: 'malformed_response' })

    const duplicate = harness(async () => apiResponse({
      ...response,
      evidence: [
        { chunkId: chunk.id, documentName: 'wrong.txt', location: 'Wrong' },
        { chunkId: chunk.id, documentName: 'wrong.txt', location: 'Wrong' }
      ]
    }), [chunk])
    await expect(duplicate.service.ask('What cache policy does our system use?')).rejects.toMatchObject({ code: 'malformed_response' })

    const valid = harness(async () => apiResponse({
      ...response, support: 'document-supported', evidenceIssue: 'none',
      evidence: [{ chunkId: chunk.id, documentName: 'wrong.txt', location: 'Wrong' }]
    }), [chunk])
    await expect(valid.service.ask('What cache policy does our system use?')).resolves.toMatchObject({
      evidence: [{ chunkId: chunk.id, documentName: 'architecture.txt', location: 'Method' }]
    })
  })

  it('includes only whole selected chunks within the exact request-context budget', async () => {
    const chunks = Array.from({ length: 6 }, (_, index) => ({
      id: `doc-${index}:text:section:part:1`, documentId: `doc-${index}`,
      text: `evidence-marker-${index} ${String(index).repeat(2_080)}`,
      kind: 'text', part: 1, partCount: 1, documentName: `document-${index}.txt`, location: 'Section 1', score: -index
    })) as RetrievedChunk[]
    const create = vi.fn(async () => apiResponse(response))
    const { service } = harness(create, chunks)
    await service.ask('Explain the indexed evidence.')
    const input = String(create.mock.calls[0]?.[0].input)
    expect(input).toContain('evidence-marker-0')
    expect(input).toContain('evidence-marker-4')
    expect(input).not.toContain('evidence-marker-5')
    for (const chunk of chunks.slice(0, 5)) expect(input).toContain(chunk.text)
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

  it('supports coordinator-owned retrieval/generation stages and an external cancellation signal', async () => {
    let resolveFirst!: (value: OpenAIResponseLike) => void
    const requests: Record<string, unknown>[] = []
    const create = vi.fn((body: Record<string, unknown>) => {
      requests.push(body)
      if (requests.length === 1) return new Promise<OpenAIResponseLike>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(apiResponse(response))
    })
    const { service } = harness(create)
    const chunks = service.retrieve('Externally cancelled question')
    const controller = new AbortController()
    const first = service.generate('Externally cancelled question', chunks, { signal: controller.signal })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    controller.abort()
    resolveFirst(apiResponse(response))
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })

    const stages: string[] = []
    await service.ask('Fresh staged question', { onStage: (stage) => stages.push(stage) })
    expect(stages).toEqual(['retrieving', 'generating'])
    expect(create).toHaveBeenCalledTimes(2)
    expect(String(requests[1]?.input)).not.toContain('Externally cancelled question')
  })

  it('uses only the prior reviewer question to expand referential retrieval', async () => {
    const queries: string[] = []
    const { service } = harness(
      async () => apiResponse({ ...response, say: 'SECRET RESPONSE SUMMARY' }), [],
      (query) => { queries.push(query); return [] }
    )
    await service.ask('What is eventual consistency?')
    await service.ask('How does that affect convergence?')
    expect(queries[1]).toContain('What is eventual consistency?')
    expect(queries[1]).not.toContain('SECRET RESPONSE SUMMARY')
  })

  it('does not repopulate cleared context when an in-flight response arrives late', async () => {
    let resolveFirst!: (value: OpenAIResponseLike) => void
    let call = 0
    const requests: Record<string, unknown>[] = []
    const { service } = harness((body) => {
      requests.push(body); call += 1
      if (call === 1) return new Promise((resolve) => { resolveFirst = resolve })
      return Promise.resolve(apiResponse(response))
    })
    const first = service.ask('Question that will be cleared')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    service.clearSession()
    resolveFirst(apiResponse(response))
    await first
    await service.ask('Fresh question after clear')
    expect(String(requests[1]?.input)).not.toContain('Question that will be cleared')
  })

  it('uses the exact prepared snapshot after preview even when session clearing advances the revision', async () => {
    const previewedChunk = {
      id: 'previewed:1', documentId: 'previewed', documentName: 'previewed.txt', location: 'Section 1',
      text: 'PREVIEWED EVIDENCE SNAPSHOT', kind: 'text', part: 1, partCount: 1, score: -1
    } as RetrievedChunk
    const replacementChunk = {
      ...previewedChunk, id: 'replacement:1', documentId: 'replacement', documentName: 'replacement.txt',
      text: 'UNPREVIEWED REPLACEMENT EVIDENCE'
    } as RetrievedChunk
    let searchCalls = 0
    const requests: Record<string, unknown>[] = []
    const { service, provider } = harness(
      async (body) => { requests.push(body); return apiResponse(response) },
      [],
      () => (++searchCalls === 1 ? [previewedChunk] : [replacementChunk])
    )
    provider.settings.projectSummary = 'PREVIEWED PROJECT BACKGROUND'
    const preparedChunks = service.retrieve('Explain eventual consistency.')
    service.clearSession()
    provider.settings.projectSummary = 'UNPREVIEWED REPLACEMENT BACKGROUND'

    await service.generate('Explain eventual consistency.', preparedChunks)

    expect(searchCalls).toBe(1)
    expect(String(requests[0]?.input)).toContain('PREVIEWED EVIDENCE SNAPSHOT')
    expect(String(requests[0]?.input)).toContain('PREVIEWED PROJECT BACKGROUND')
    expect(String(requests[0]?.input)).not.toContain('UNPREVIEWED REPLACEMENT')
    await service.ask('Fresh question after the preview race.')
    expect(String(requests[1]?.input)).not.toContain('Explain eventual consistency.')
  })

  it('validates and bounds questions before making a request', async () => {
    const create = vi.fn(async () => apiResponse(response)); const { service } = harness(create)
    await expect(service.ask('   ')).rejects.toMatchObject({ code: 'unknown' })
    await expect(service.ask('x'.repeat(4_001))).rejects.toMatchObject({ code: 'unknown' })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('structured code AI service', () => {
  const codeResponse = {
    ...response,
    codeBlocks: [{
      language: 'tsx', title: null,
      code: 'export function SearchDropdown(): JSX.Element {\n  return <input aria-label="Search" />\n}'
    }]
  }

  it('automatically uses one stateless code-schema request for a programming creation question', async () => {
    const create = vi.fn(async () => apiResponse(codeResponse))
    const { service } = harness(create)
    const result = await service.ask('Can you design the code for a dropdown search box in React?')

    expect(result.codeBlocks).toEqual([{
      language: 'tsx',
      code: 'export function SearchDropdown(): JSX.Element {\n  return <input aria-label="Search" />\n}'
    }])
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-luna', reasoning: { effort: 'none' }, max_output_tokens: 2_000, store: false,
      text: { format: { type: 'json_schema', name: 'presenter_code_response', strict: true } }
    })
    expect(String(create.mock.calls[0]?.[0].instructions)).toContain('put every source-code fragment in CODE BLOCKS')
  })

  it('uses the Strong code budget and low verbosity for an explicit Code override', async () => {
    const create = vi.fn(async () => apiResponse(codeResponse, { model: 'gpt-5.6-terra-2026-06-01' }))
    const { service, provider } = harness(create)
    provider.settings.modelMode = 'strong'
    await service.ask('Explain eventual consistency.', { answerFormat: 'code' })
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-5.6-terra', reasoning: { effort: 'low' }, max_output_tokens: 3_000,
      text: { verbosity: 'low', format: { name: 'presenter_code_response' } }
    })
  })

  it('applies automatic code routing to direct generate calls used by audio transcripts', async () => {
    const create = vi.fn(async () => apiResponse(codeResponse))
    const { service } = harness(create)
    await service.generate('Write a JavaScript function to sort these values.', [])
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      max_output_tokens: 2_000, text: { format: { name: 'presenter_code_response' } }
    })
  })

  it('rejects oversized aggregate code and still records returned usage', async () => {
    const create = vi.fn(async () => apiResponse({
      ...response,
      codeBlocks: [
        { language: 'js', title: null, code: 'a'.repeat(6_000) },
        { language: 'css', title: null, code: 'b'.repeat(6_000) },
        { language: 'html', title: null, code: 'c'.repeat(6_000) }
      ]
    }))
    const { service, usage } = harness(create)
    await expect(service.ask('Generate code for a web component.')).rejects.toMatchObject({ code: 'malformed_response' })
    expect(create).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledWith(50, 30)
  })

  it('does not include generated code in rolling conversation summaries', async () => {
    const secretCode = 'const PRIVATE_GENERATED_CODE = "must-not-enter-context";'
    const requests: Record<string, unknown>[] = []
    const { service } = harness(async (body) => {
      requests.push(body)
      return requests.length === 1
        ? apiResponse({ ...codeResponse, codeBlocks: [{ language: 'js', title: null, code: secretCode }] })
        : apiResponse(response)
    })
    await service.ask('Write a JavaScript function for a dropdown.')
    await service.ask('What is eventual consistency?')
    expect(String(requests[1]?.input)).not.toContain(secretCode)
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
  it('preserves typed errors and disables SDK retries while the session cap is active', () => {
    expect(toAiErrorInfo(new AiServiceError('busy', 'Busy.', false))).toEqual({ code: 'busy', message: 'Busy.', retryable: false })
    expect(openAIClientOptions('secret')).toMatchObject({ maxRetries: 0, timeout: 30_000 })
  })
})
