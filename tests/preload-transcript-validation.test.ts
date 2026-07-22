import { describe, expect, it } from 'vitest'
import { parseTranscriptDraft } from '../src/preload/transcriptValidation'

const draft = {
  operationId: 'audio-1', text: 'What evidence supports this result?', durationMs: 900,
  endpointId: 'render-default', endpointName: 'Speakers', createdAt: '2026-07-22T10:00:00.000Z'
}

describe('sandbox-safe transcript validation', () => {
  it('accepts the exact bounded draft contract without loading renderer dependencies', () => {
    expect(parseTranscriptDraft(draft)).toEqual(draft)
  })

  it('drops malformed, oversized, and expanded IPC values', () => {
    expect(parseTranscriptDraft({ ...draft, text: 'x'.repeat(4_001) })).toBeUndefined()
    expect(parseTranscriptDraft({ ...draft, durationMs: 1 })).toBeUndefined()
    expect(parseTranscriptDraft({ ...draft, createdAt: 'not-a-date' })).toBeUndefined()
    expect(parseTranscriptDraft({ ...draft, unexpected: 'field' })).toBeUndefined()
  })
})
