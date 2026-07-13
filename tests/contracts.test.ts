import { describe, expect, it } from 'vitest'
import { aiErrorCodes, askResultSchema, assistantResponseSchema, questionSchema } from '../src/shared/contracts'

describe('assistant response contract', () => {
  it('accepts the presenter format', () => {
    expect(assistantResponseSchema.parse({
      category: 'CHALLENGE', say: 'The design favors predictable local behavior.',
      keyPoints: ['Documents remain local.', 'Only selected excerpts are transmitted.'],
      ifChallenged: 'The trade-off is weaker semantic recall.', warning: 'No benchmark was supplied.', evidence: []
    }).category).toBe('CHALLENGE')
  })
  it('rejects long key-point lists and unknown categories', () => {
    expect(() => assistantResponseSchema.parse({ category: 'OPINION', say: 'x', keyPoints: ['1', '2', '3', '4', '5'], ifChallenged: 'x', evidence: [] })).toThrow()
  })
  it('validates typed IPC outcomes and bounded questions', () => {
    for (const code of aiErrorCodes) expect(askResultSchema.parse({ ok: false, error: { code, message: 'Safe message.', retryable: false } }).ok).toBe(false)
    expect(questionSchema.parse('  hello  ')).toBe('hello')
    expect(() => questionSchema.parse('x'.repeat(4_001))).toThrow()
  })
})
