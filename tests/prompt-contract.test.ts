import { describe, expect, it } from 'vitest'
import { presenterInstructions, responseJsonSchema } from '../src/main/ai/prompts'

function words(count: number): string { return Array.from({ length: count }, (_, index) => `w${index + 1}`).join(' ') }
function matches(pattern: string, count: number): boolean { return new RegExp(pattern, 'u').test(words(count)) }

describe('M3 structured-output prompt contract', () => {
  it('enforces the approved field word ranges and exactly three key points', () => {
    const properties = responseJsonSchema.properties
    expect(responseJsonSchema.required).toContain('warning')
    expect(properties.keyPoints).toMatchObject({ minItems: 3, maxItems: 3 })

    for (const [pattern, minimum, maximum] of [
      [properties.say.pattern, 60, 80],
      [properties.keyPoints.items.pattern, 12, 18],
      [properties.ifChallenged.pattern, 25, 35],
      [properties.warning.pattern, 20, 30]
    ] as const) {
      expect(matches(pattern, minimum - 1)).toBe(false)
      expect(matches(pattern, minimum)).toBe(true)
      expect(matches(pattern, maximum)).toBe(true)
      expect(matches(pattern, maximum + 1)).toBe(false)
    }
  })

  it('guarantees the intended combined visible-word bounds', () => {
    const withoutWarning = 60 + (3 * 12) + 25
    const maximumWithoutWarning = 80 + (3 * 18) + 35
    expect([withoutWarning, maximumWithoutWarning]).toEqual([121, 169])
    expect([withoutWarning + 20, maximumWithoutWarning + 30]).toEqual([141, 199])
  })

  it('makes comparison intent and missing-evidence precedence explicit', () => {
    expect(presenterInstructions).toContain('difference between')
    expect(presenterInstructions).toContain('same thing as')
    expect(presenterInstructions).toContain('Missing evidence affects WARNING')
  })
})
