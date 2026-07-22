import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeAssistantResponseSchema } from '../src/shared/contracts'
import { isCodeAnswerRequest, resolveAnswerFormat } from '../src/main/ai/answerFormat'
import { codeResponseJsonSchema, responseJsonSchema } from '../src/main/ai/prompts'
import { codeResponseRequestPolicy, responseRequestPolicy } from '../src/main/ai/requestPolicy'

describe('answer-format routing', () => {
  it.each([
    'Can you design the code for a dropdown search box in React?',
    'Write a TypeScript function that deduplicates these IDs.',
    'Generate JSX for an accessible dialog component.',
    'Provide a Python snippet to parse this JSON.',
    'Fix this SQL query and show the corrected query.',
    'Refactor the Node.js script into a reusable class.'
  ])('routes programming creation requests to structured code: %s', (question) => {
    expect(isCodeAnswerRequest(question)).toBe(true)
    expect(resolveAnswerFormat(question)).toBe('code')
  })

  it.each([
    'What is code signing and why is it useful?',
    'Write a code of conduct for the project.',
    'Explain source-code licensing obligations.',
    'What is a database query plan?',
    'How does React reconciliation work?',
    'Which algorithm did our project implement?'
  ])('keeps non-creation and lookalike questions on the presenter path: %s', (question) => {
    expect(isCodeAnswerRequest(question)).toBe(false)
    expect(resolveAnswerFormat(question)).toBe('presenter')
  })

  it('allows an explicit per-request Code override', () => {
    expect(resolveAnswerFormat('Explain eventual consistency.', 'code')).toBe('code')
  })

  it('keeps every accepted M3 and M7 evaluation question on the ordinary presenter path', () => {
    const m3 = JSON.parse(readFileSync(resolve('tests/fixtures/m3-eval-corpus.json'), 'utf8')) as Array<{ question: string }>
    const m7 = JSON.parse(readFileSync(resolve('tests/fixtures/m7-offline-corpus.json'), 'utf8')) as {
      cases: Array<{ question: string; priorQuestion?: string }>
    }
    for (const item of m3) expect(resolveAnswerFormat(item.question), item.question).toBe('presenter')
    for (const item of m7.cases) {
      expect(resolveAnswerFormat(item.question), item.question).toBe('presenter')
      if (item.priorQuestion) expect(resolveAnswerFormat(item.priorQuestion), item.priorQuestion).toBe('presenter')
    }
  })
})

describe('structured code contracts', () => {
  const base = {
    category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none',
    say: 'A concise implementation follows.', keyPoints: ['One', 'Two', 'Three'],
    ifChallenged: 'Review and test it for the target environment.', evidence: []
  }

  it('requires one to three code blocks and enforces Unicode per-block and aggregate limits', () => {
    expect(codeAssistantResponseSchema.safeParse(base).success).toBe(false)
    expect(codeAssistantResponseSchema.safeParse({
      ...base, codeBlocks: [{ language: 'tsx', title: 'SearchDropdown.tsx', code: '😀'.repeat(8_000) }]
    }).success).toBe(true)
    expect(codeAssistantResponseSchema.safeParse({
      ...base, codeBlocks: [{ language: 'tsx', code: '😀'.repeat(8_001) }]
    }).success).toBe(false)
    expect(codeAssistantResponseSchema.safeParse({
      ...base,
      codeBlocks: [
        { language: 'js', code: 'a'.repeat(6_000) },
        { language: 'css', code: 'b'.repeat(6_000) },
        { language: 'html', code: 'c'.repeat(6_000) }
      ]
    }).success).toBe(false)
  })

  it('adds code only to the separate provider schema and uses mode-specific code budgets', () => {
    expect(responseJsonSchema.properties).not.toHaveProperty('codeBlocks')
    expect(codeResponseJsonSchema.properties.codeBlocks).toMatchObject({ minItems: 1, maxItems: 3 })
    expect(responseRequestPolicy('normal')).toEqual({ reasoningEffort: 'none', maxOutputTokens: 450 })
    expect(responseRequestPolicy('strong')).toEqual({ reasoningEffort: 'low', maxOutputTokens: 1_200, verbosity: 'low' })
    expect(codeResponseRequestPolicy('normal')).toEqual({ reasoningEffort: 'none', maxOutputTokens: 2_000 })
    expect(codeResponseRequestPolicy('strong')).toEqual({ reasoningEffort: 'low', maxOutputTokens: 3_000, verbosity: 'low' })
  })
})
