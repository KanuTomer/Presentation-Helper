import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DocumentInfo } from '../src/shared/contracts'
import {
  AiService, type AiSettingsProvider, type OpenAIClientLike, type TranscriptionMetric
} from '../src/main/ai/service'
import {
  buildTerminologyHint, MAX_TERMINOLOGY_HINT_CHARACTERS, normalizeTranscript,
  parseTranscriptionResponse, type TranscriptionUsage
} from '../src/main/ai/transcription'
import { estimateTranscriptionUsd, USAGE_PRICING_VERSION } from '../src/main/settings/store'

const settings: AppSettings = {
  opacity: 0.9,
  clickThrough: false,
  modelMode: 'normal',
  normalModel: 'gpt-5.6-luna',
  strongModel: 'gpt-5.6-terra',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space',
  hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space',
  projectSummary: '',
  approvedVocabulary: [' RAG ', 'BM25']
}

const documents: DocumentInfo[] = [{
  id: 'doc-1', name: 'Presenter Architecture.pdf', path: 'C:\\docs\\Presenter Architecture.pdf',
  kind: 'pdf', chunkCount: 2, addedAt: '2026-07-14T00:00:00.000Z'
}]

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function audioFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'presenterai-transcription-'))
  tempDirectories.push(directory)
  const path = join(directory, 'reviewer.wav')
  await writeFile(path, Buffer.from('RIFF-test-wave'))
  return path
}

function harness(create: OpenAIClientLike['audio']['transcriptions']['create']) {
  const addTranscriptionUsage = vi.fn(async () => undefined)
  const provider: AiSettingsProvider = {
    settings: structuredClone(settings),
    documents: structuredClone(documents),
    addUsage: vi.fn(async () => undefined),
    addTranscriptionUsage
  }
  const client: OpenAIClientLike = {
    models: { list: async () => [] },
    audio: { transcriptions: { create } },
    responses: { create: async () => ({}) }
  }
  const metrics: TranscriptionMetric[] = []
  const service = new AiService({ getKey: async () => 'sk-test' }, provider, {
    search: () => [],
    documentTitles: () => ['Retrieval Architecture', 'rag']
  }, {
    clientFactory: async () => client,
    onTranscriptionMetric: (metric) => metrics.push(metric)
  })
  return { service, provider, addTranscriptionUsage, metrics }
}

describe('bounded transcription', () => {
  it('requests JSON, composes a bounded terminology hint, validates text, and records token usage', async () => {
    const create = vi.fn(async () => ({
      text: '  What\n does   retrieval-augmented generation mean?  ',
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      usage: {
        type: 'tokens', input_tokens: 120, output_tokens: 15, total_tokens: 135,
        input_token_details: { audio_tokens: 100, text_tokens: 20 }
      }
    }))
    const { service, addTranscriptionUsage, metrics } = harness(create)
    const result = await service.transcribe(await audioFixture(), {
      signal: new AbortController().signal,
      approvedVocabulary: ['retrieval-augmented generation', 'RAG']
    })

    expect(result).toMatchObject({
      text: 'What does retrieval-augmented generation mean?',
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      usage: { type: 'tokens', inputTokens: 120, outputTokens: 15, audioTokens: 100, textTokens: 20 }
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    const request = create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({ model: 'gpt-4o-mini-transcribe', response_format: 'json' })
    expect(String(request.prompt)).toContain('RAG')
    expect(String(request.prompt)).toContain('BM25')
    expect(String(request.prompt)).toContain('Presenter Architecture')
    expect(String(request.prompt)).toContain('Retrieval Architecture')
    expect(String(request.prompt).match(/RAG/gi)).toHaveLength(1)
    expect(addTranscriptionUsage).toHaveBeenCalledWith(result.usage, result.model)
    expect(metrics).toMatchObject([{ outcome: 'success', returnedModel: result.model, usage: result.usage }])
  })

  it('accounts for valid usage before rejecting empty, control-only, or oversized transcript text', async () => {
    const usage = {
      type: 'tokens', input_tokens: 10, output_tokens: 1, total_tokens: 11,
      input_token_details: { audio_tokens: 10 }
    }
    for (const text of ['', '\u0000\u0001', 'x'.repeat(4_001)]) {
      const { service, addTranscriptionUsage } = harness(async () => ({ text, usage }))
      await expect(service.transcribe(await audioFixture(), { signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'invalid_transcript', retryable: true })
      expect(addTranscriptionUsage).toHaveBeenCalledOnce()
    }

    const missing = harness(async () => ({ usage }))
    await expect(missing.service.transcribe(await audioFixture(), { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'invalid_transcript' })
    expect(missing.addTranscriptionUsage).toHaveBeenCalledOnce()
  })

  it('does not mislabel the requested transcription model as provider-returned provenance', async () => {
    const { service, addTranscriptionUsage, metrics } = harness(async () => ({
      text: 'What is the bounded audio policy?',
      usage: { type: 'tokens', input_tokens: 20, output_tokens: 5, total_tokens: 25 }
    }))
    const result = await service.transcribe(await audioFixture(), { signal: new AbortController().signal })
    expect(result.model).toBeUndefined()
    expect(addTranscriptionUsage).toHaveBeenCalledWith(result.usage, 'gpt-4o-mini-transcribe')
    expect(metrics[0]?.returnedModel).toBeUndefined()
  })

  it('rejects malformed usage and reports cancellation without making a request', async () => {
    const malformed = harness(async () => ({
      text: 'What is caching?', usage: { type: 'tokens', input_tokens: -1, output_tokens: 1, total_tokens: 0 }
    }))
    await expect(malformed.service.transcribe(await audioFixture(), { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'invalid_transcript' })
    expect(malformed.addTranscriptionUsage).not.toHaveBeenCalled()

    const create = vi.fn(async () => ({ text: 'unreachable' }))
    const cancelled = harness(create)
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.service.transcribe(await audioFixture(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled', retryable: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('passes the coordinator signal to an in-flight upload and returns a clean cancellation', async () => {
    let uploadSignal: AbortSignal | undefined
    const create = vi.fn((_body: Record<string, unknown>, options: { signal: AbortSignal }) => {
      uploadSignal = options.signal
      return new Promise<unknown>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const { service, addTranscriptionUsage, metrics } = harness(create)
    const controller = new AbortController()
    const pending = service.transcribe(await audioFixture(), { signal: controller.signal })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false })
    expect(uploadSignal).toBe(controller.signal)
    expect(addTranscriptionUsage).not.toHaveBeenCalled()
    expect(metrics).toMatchObject([{ outcome: 'cancelled' }])
  })

  it('records returned usage when cancellation races a completed provider response', async () => {
    let resolveUpload!: (value: unknown) => void
    const create = vi.fn(() => new Promise<unknown>((resolve) => { resolveUpload = resolve }))
    const { service, addTranscriptionUsage, metrics } = harness(create)
    const controller = new AbortController()
    const pending = service.transcribe(await audioFixture(), { signal: controller.signal })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    controller.abort()
    resolveUpload({
      text: 'This cancelled transcript must not continue.',
      usage: { type: 'tokens', input_tokens: 25, output_tokens: 4, total_tokens: 29, input_token_details: { audio_tokens: 20 } }
    })

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(addTranscriptionUsage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tokens', inputTokens: 25, outputTokens: 4 }), 'gpt-4o-mini-transcribe')
    expect(metrics).toMatchObject([{ outcome: 'cancelled', requestDispatched: true, usage: { type: 'tokens', inputTokens: 25, outputTokens: 4 } }])
  })
})

describe('transcription normalization and pricing', () => {
  it('normalizes both token and duration usage variants', () => {
    expect(parseTranscriptionResponse({
      text: 'Question',
      usage: {
        type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 15,
        input_token_details: { audio_tokens: 10, text_tokens: 2 }
      }
    })?.usage).toEqual({ type: 'tokens', inputTokens: 12, outputTokens: 3, totalTokens: 15, audioTokens: 10, textTokens: 2 })
    expect(parseTranscriptionResponse({ text: 'Question', usage: { type: 'duration', seconds: 12.5 } })?.usage)
      .toEqual({ type: 'duration', inputTokens: 0, outputTokens: 0, totalTokens: 0, audioTokens: 0, textTokens: 0, durationSeconds: 12.5 })
    expect(normalizeTranscript('  hello\r\nworld  ')).toBe('hello world')
  })

  it('rejects internally inconsistent transcription token metadata', () => {
    const invalid = [
      { type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 14 },
      { type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 15, input_token_details: { audio_tokens: 13 } },
      { type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 15, input_token_details: { audio_tokens: 10, text_tokens: 3 } }
    ]
    for (const usage of invalid) expect(parseTranscriptionResponse({ text: 'Question', usage })).toBeUndefined()
  })

  it('caps, deduplicates, and bounds approved vocabulary before document terminology', () => {
    const approved = ['RAG', 'rag', ...Array.from({ length: 35 }, (_, index) => `Term-${index}`)]
    const hint = buildTerminologyHint({
      approvedVocabulary: approved,
      documentNames: ['RAG.pdf', 'Architecture.pptx'],
      documentTitles: ['Architecture', 'x'.repeat(65), 'Retrieval']
    })
    expect(hint.match(/\bRAG\b/gi)).toHaveLength(1)
    expect(hint).toContain('Term-28')
    expect(hint).not.toContain('Term-29')
    expect(hint).toContain('Architecture')
    expect(Array.from(hint).length).toBeLessThanOrEqual(MAX_TERMINOLOGY_HINT_CHARACTERS)
  })

  it('uses versioned token pricing and never applies the former per-minute estimate', () => {
    const usage: TranscriptionUsage = {
      type: 'tokens', inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200,
      audioTokens: 900, textTokens: 100
    }
    expect(estimateTranscriptionUsd(usage, 'gpt-4o-mini-transcribe')).toBeCloseTo(0.00225, 8)
    expect(estimateTranscriptionUsd(usage, 'unpriced-model')).toBe(0)
    expect(USAGE_PRICING_VERSION).toBe('openai-2026-07-14')
  })
})
