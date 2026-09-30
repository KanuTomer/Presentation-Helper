import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/shared/contracts'
import { AiService, type AiSettingsProvider, type OpenAIClientLike } from '../src/main/ai/service'
const settings: AppSettings = { neonIntensity: .65, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-6-luna', strongModel: 'gpt-6.1-sol', transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space', projectSummary: '', approvedVocabulary: [], sessionBudgetUsd: .01 }
const answer = { category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none', say: 'General guidance.', keyPoints: ['One', 'Two', 'Three'], ifChallenged: 'A limitation.', evidence: [] }
function harness(model = 'gpt-6-luna', returnedModel = model) {
  const reserveSessionBudget = vi.fn(async () => { throw new Error('Retired cap must not run') })
  const recordUsage = vi.fn(async () => undefined)
  const create = vi.fn(async () => ({ output_text: JSON.stringify(answer), model: returnedModel, usage: { input_tokens: 100, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 700 } } }))
  const transcribe = vi.fn(async () => ({ text: 'Explain the compiler error.', model: 'gpt-4o-mini-transcribe', usage: { type: 'tokens', input_tokens: 100, output_tokens: 10, total_tokens: 110, input_token_details: { audio_tokens: 90, text_tokens: 10 } } }))
  const provider: AiSettingsProvider = { settings: { ...settings, normalModel: model }, documents: [], addUsage: vi.fn(), addTranscriptionUsage: vi.fn(), reserveSessionBudget, recordUsage }
  const client: OpenAIClientLike = { models: { list: vi.fn() }, responses: { create }, audio: { transcriptions: { create: transcribe } } }
  return { service: new AiService({ getKey: vi.fn() }, provider, { search: () => [] }, { clientFactory: async () => client }), provider, create, transcribe, reserveSessionBudget, recordUsage }
}
describe('uncapped production requests', () => {
  it('ignores legacy low caps and never reserves spending', async () => {
    const h = harness(); await h.service.ask('Explain recursion.')
    expect(h.reserveSessionBudget).not.toHaveBeenCalled()
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'medium' } })
    expect(h.create.mock.calls[0]?.[0]).not.toHaveProperty('max_output_tokens')
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ reasoningTokens: 700 }))
  })
  it('records unknown returned pricing without blocking valid output', async () => {
    const h = harness('gpt-6-luna', 'future-snapshot'); await expect(h.service.ask('Explain recursion.')).resolves.toMatchObject({ responseStyle: 'presenter' })
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ returnedModel: 'future-snapshot' }))
  })
  it('does not reserve or cap transcription', async () => {
    const h = harness(); await h.service.transcribe({ bytes: new Uint8Array([1]) }, { signal: new AbortController().signal })
    expect(h.transcribe).toHaveBeenCalledTimes(1); expect(h.reserveSessionBudget).not.toHaveBeenCalled()
  })
  it('honors explicit reasoning without silently changing models', async () => {
    const h = harness('gpt-6.1-sol'); h.provider.settings.normalReasoning = 'high'
    await h.service.ask('Explain recursion.'); expect(h.create.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'high' } })
  })
  it('rejects unsupported requested models rather than switching', async () => {
    const h = harness('not-supported'); await expect(h.service.ask('Explain recursion.')).rejects.toMatchObject({ code: 'unknown' }); expect(h.create).not.toHaveBeenCalled()
  })
})
