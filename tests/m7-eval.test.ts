import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateM7AnswerSemantics, evaluateM7Offline, m7CorpusSchema } from '../src/main/ai/m7Eval'
import type { AssistantResponse } from '../src/shared/contracts'

const corpus = JSON.parse(readFileSync(resolve('tests/fixtures/m7-offline-corpus.json'), 'utf8')) as unknown

describe('M7 offline evaluation gate', () => {
  it('contains the exact versioned 50-case distribution', () => {
    const parsed = m7CorpusSchema.parse(corpus)
    expect(parsed.cases).toHaveLength(50)
    expect(parsed.cases.filter((item) => item.group === 'followup')).toHaveLength(20)
    expect(parsed.cases.filter((item) => item.group === 'unsupported')).toHaveLength(15)
    expect(parsed.cases.filter((item) => item.group === 'supported')).toHaveLength(5)
    expect(parsed.cases.filter((item) => item.group === 'challenge')).toHaveLength(5)
    expect(parsed.cases.filter((item) => item.group === 'contradictory')).toHaveLength(5)
  })

  it('passes every contextual production-FTS retrieval and grounding invariant offline', async () => {
    await expect(evaluateM7Offline(corpus)).resolves.toMatchObject({
      caseCount: 50, contextualFollowUps: 20, productionPreparedSelections: 50,
      semanticChecksValid: 50, groundingValid: 50,
      failedCaseIds: [], passed: true, storesRawPromptsOrResponses: false
    })
  })

  it('rejects unresolved follow-ups, named fabrications, weak challenges, and conflict side-picking', () => {
    const parsed = m7CorpusSchema.parse(corpus)
    const base: AssistantResponse = {
      category: 'FACTUAL', support: 'general-technical', evidenceIssue: 'none', say: 'A generic answer.',
      keyPoints: ['One.', 'Two.', 'Three.'], ifChallenged: 'A generic defence.', evidence: []
    }
    const followup = parsed.cases.find((item) => item.id === 'f01')!
    expect(evaluateM7AnswerSemantics(followup, { ...base, support: 'document-supported' }).requiredAnchorPresent).toBe(false)

    const unsupported = parsed.cases.find((item) => item.id === 'u02')!
    expect(evaluateM7AnswerSemantics(unsupported, {
      ...base, support: 'unsupported-project-claim', evidenceIssue: 'missing',
      say: 'Our project used ImageNet for training.', warning: 'No supplied project evidence confirms this dataset.'
    }).unsupportedSafe).toBe(false)

    const challenge = parsed.cases.find((item) => item.id === 'c01')!
    expect(evaluateM7AnswerSemantics(challenge, {
      ...base, category: 'CHALLENGE', support: 'document-supported', say: 'Trust the design because it is good.'
    }).challengeStructure).toBe(false)

    const conflict = parsed.cases.find((item) => item.id === 'x01')!
    expect(evaluateM7AnswerSemantics(conflict, {
      ...base, support: 'unsupported-project-claim', evidenceIssue: 'conflicting',
      say: 'The documents conflict; therefore Alpha is the answer.', warning: 'The supplied documents conflict.'
    }).conflictNeutral).toBe(false)
  })
})
