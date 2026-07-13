import { describe, expect, it } from 'vitest'
import { assistantResponseSchema } from '../src/shared/contracts'

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
})
