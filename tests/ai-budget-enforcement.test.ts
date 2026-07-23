import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, AssistantResponse } from '../src/shared/contracts'
import { AiService, type AiSettingsProvider, type OpenAIClientLike } from '../src/main/ai/service'

const settings: AppSettings = {
  neonIntensity: 0.65, sessionBudgetUsd: 0.25, clickThrough: false, modelMode: 'normal',
  normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: '', approvedVocabulary: []
}

const validResponse: AssistantResponse = {
  responseStyle: 'presenter',
  category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none',
  say: 'A bounded answer based on general technical knowledge.',
  keyPoints: ['One clear point.', 'A second clear point.', 'A third clear point.'],
  ifChallenged: 'Explain the limitation directly.', evidence: []
}

function harness(overrides: { response?: () => Promise<unknown>; transcript?: () => Promise<unknown>; settings?: Partial<AppSettings>; reserveError?: unknown } = {}) {
  const reserveSessionBudget = vi.fn(async () => {
    if (overrides.reserveError) throw overrides.reserveError
    return { id: 'reservation-1' }
  })
  const settleSessionBudget = vi.fn(async () => undefined)
  const releaseSessionBudget = vi.fn(async () => undefined)
  const retainSessionBudget = vi.fn(() => undefined)
  const recordUsage = vi.fn(async () => undefined)
  const provider: AiSettingsProvider = {
    settings: { ...settings, ...overrides.settings }, documents: [], addUsage: vi.fn(async () => undefined),
    addTranscriptionUsage: vi.fn(async () => undefined), recordUsage, reserveSessionBudget, settleSessionBudget,
    releaseSessionBudget, retainSessionBudget
  }
  const responses = vi.fn(overrides.response ?? (async () => ({
    output_text: JSON.stringify(validResponse), model: 'gpt-5.6-luna',
    usage: { input_tokens: 50, output_tokens: 30 }
  })))
  const transcriptions = vi.fn(overrides.transcript ?? (async () => ({
    text: 'What does the architecture use?', model: 'gpt-4o-mini-transcribe',
    usage: { type: 'tokens', input_tokens: 100, output_tokens: 10, total_tokens: 110, input_token_details: { audio_tokens: 90, text_tokens: 10 } }
  })))
  const client: OpenAIClientLike = {
    models: { list: async () => [] },
    responses: { create: responses as OpenAIClientLike['responses']['create'] },
    audio: { transcriptions: { create: transcriptions as OpenAIClientLike['audio']['transcriptions']['create'] } }
  }
  return {
    service: new AiService({ getKey: async () => 'not-a-real-key' }, provider, { search: () => [] }, { clientFactory: async () => client }),
    reserveSessionBudget, settleSessionBudget, releaseSessionBudget, retainSessionBudget, recordUsage, responses, transcriptions
  }
}

describe('AI session-budget enforcement', () => {
  it('reserves the complete Responses request before dispatch and settles exact returned usage', async () => {
    const h = harness()
    await h.service.ask('Explain bounded retrieval.')
    expect(h.reserveSessionBudget).toHaveBeenCalledWith('responses', 'gpt-5.6-luna', expect.any(Number))
    expect(h.reserveSessionBudget.mock.calls[0]?.[2]).toBeGreaterThan(0.0027)
    expect(h.settleSessionBudget).toHaveBeenCalledWith('reservation-1', 0.00023, false)
    expect(h.retainSessionBudget).not.toHaveBeenCalled()
  })

  it('retains the full hold when returned usage is missing', async () => {
    const h = harness({ response: async () => ({ output_text: JSON.stringify(validResponse), model: 'gpt-5.6-luna' }) })
    await h.service.ask('Explain bounded retrieval.')
    expect(h.retainSessionBudget).toHaveBeenCalledWith('reservation-1')
    expect(h.settleSessionBudget).not.toHaveBeenCalled()
  })

  it('records missing returned-model provenance as unpriced and retains both holds', async () => {
    const response = harness({ response: async () => ({
      output_text: JSON.stringify(validResponse), usage: { input_tokens: 50, output_tokens: 30 }
    }) })
    await response.service.ask('Explain bounded retrieval.')
    expect(response.recordUsage).toHaveBeenCalledWith(expect.not.objectContaining({ returnedModel: expect.anything() }))
    expect(response.retainSessionBudget).toHaveBeenCalledWith('reservation-1')

    const transcription = harness({ transcript: async () => ({
      text: 'What does the architecture use?',
      usage: { type: 'tokens', input_tokens: 100, output_tokens: 10, total_tokens: 110, input_token_details: { audio_tokens: 90 } }
    }) })
    await transcription.service.transcribe({ bytes: new Uint8Array([82, 73, 70, 70]) }, { signal: new AbortController().signal })
    expect(transcription.recordUsage).toHaveBeenCalledWith(expect.not.objectContaining({ returnedModel: expect.anything() }))
    expect(transcription.retainSessionBudget).toHaveBeenCalledWith('reservation-1')
  })

  it('blocks unknown requested models and cap failures before provider dispatch', async () => {
    const unknown = harness({ settings: { normalModel: 'unreviewed-model' } })
    await expect(unknown.service.ask('Explain caching.')).rejects.toMatchObject({ code: 'unpriced_model' })
    expect(unknown.responses).not.toHaveBeenCalled()

    const capped = harness({ reserveError: { code: 'session_budget_exceeded', message: 'Cap reached.' } })
    await expect(capped.service.ask('Explain caching.')).rejects.toMatchObject({ code: 'session_budget_exceeded' })
    expect(capped.responses).not.toHaveBeenCalled()
  })

  it('reserves the bounded transcription maximum and settles exact token usage', async () => {
    const h = harness()
    await h.service.transcribe({ bytes: new Uint8Array([82, 73, 70, 70]), filename: 'reviewer.wav' }, {
      signal: new AbortController().signal, durationMs: 1_000
    })
    expect(h.reserveSessionBudget).toHaveBeenCalledWith('transcription', 'gpt-4o-mini-transcribe', 0.03)
    expect(h.settleSessionBudget).toHaveBeenCalledWith('reservation-1', 0.000175, false)
  })

  it('retains a transcription reservation after a dispatched network failure', async () => {
    const h = harness({ transcript: async () => { throw { code: 'ECONNRESET' } } })
    await expect(h.service.transcribe({ bytes: new Uint8Array([82, 73, 70, 70]) }, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'offline' })
    expect(h.retainSessionBudget).toHaveBeenCalledWith('reservation-1')
    expect(h.releaseSessionBudget).not.toHaveBeenCalled()
  })

  it('releases a transcription reservation when local multipart preparation fails before dispatch', async () => {
    const h = harness()
    const source = {
      bytes: new Uint8Array([82, 73, 70, 70]),
      get filename(): string { throw new Error('local filename preparation failed') }
    }
    await expect(h.service.transcribe(source, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'unknown' })
    expect(h.transcriptions).not.toHaveBeenCalled()
    expect(h.releaseSessionBudget).toHaveBeenCalledWith('reservation-1')
    expect(h.retainSessionBudget).not.toHaveBeenCalled()
  })
})
