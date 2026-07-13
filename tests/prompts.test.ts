import { describe, expect, it } from 'vitest'
import { presenterInstructions } from '../src/main/ai/prompts'

describe('M3 presenter prompt contract', () => {
  it.each([
    ['COMPARISON', 'difference between'],
    ['CHALLENGE', 'skepticism, an objection'],
    ['CLARIFICATION', 'term or distinction'],
    ['LIMITATION', 'limitation, constraint, weakness, or failure reason'],
    ['FACTUAL', 'concrete fact, measurement, implementation detail, or result']
  ])('defines %s classification intent', (category, cue) => {
    expect(presenterInstructions).toContain(`${category} when`)
    expect(presenterInstructions).toContain(cue)
  })

  it('keeps evidence sufficiency separate from category and preserves the strict length gate', () => {
    expect(presenterInstructions).toContain("Missing evidence affects WARNING; it must not change the question's category.")
    expect(presenterInstructions).toContain('120-220 visible words')
    expect(presenterInstructions).toContain('exactly 3 items')
    expect(presenterInstructions).toContain('Check the combined visible word count')
  })
})
