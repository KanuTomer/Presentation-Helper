import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeAssistantResponseSchema } from '../src/shared/contracts'
import { isCodeAnswerRequest, resolveAnswerFormat } from '../src/main/ai/answerFormat'
import {
  developerInstructions, developerResponseJsonSchema, presenterInstructions, responseJsonSchema
} from '../src/main/ai/prompts'
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
    expect(resolveAnswerFormat(question, 'code')).toBe('code')
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
    expect(resolveAnswerFormat(question, 'presenter')).toBe('presenter')
  })

  it('uses the explicit public format and defaults service-level calls to presenter', () => {
    expect(resolveAnswerFormat('Write a TypeScript function.')).toBe('presenter')
    expect(resolveAnswerFormat('Explain eventual consistency.', 'code')).toBe('code')
    expect(resolveAnswerFormat('Write a TypeScript function.', 'presenter')).toBe('presenter')
  })

  it('keeps every accepted M3 and M7 evaluation question on the ordinary presenter path', () => {
    const m3 = JSON.parse(readFileSync(resolve('tests/fixtures/m3-eval-corpus.json'), 'utf8')) as Array<{ question: string }>
    const m7 = JSON.parse(readFileSync(resolve('tests/fixtures/m7-offline-corpus.json'), 'utf8')) as {
      cases: Array<{ question: string; priorQuestion?: string }>
    }
    for (const item of m3) expect(resolveAnswerFormat(item.question, 'presenter'), item.question).toBe('presenter')
    for (const item of m7.cases) {
      expect(resolveAnswerFormat(item.question, 'presenter'), item.question).toBe('presenter')
      if (item.priorQuestion) expect(resolveAnswerFormat(item.priorQuestion, 'presenter'), item.priorQuestion).toBe('presenter')
    }
  })
})

describe('structured code contracts', () => {
  const base = {
    support: 'general-technical', evidenceIssue: 'none',
    summary: 'A concise implementation follows.',
    implementationNotes: ['Review and test it for the target environment.'],
    caveats: [],
    evidence: []
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

  it('uses a separate developer schema and prompt without changing the presenter contract', () => {
    expect(responseJsonSchema.properties).not.toHaveProperty('codeBlocks')
    expect(responseJsonSchema.properties).toHaveProperty('say')
    expect(developerResponseJsonSchema.properties).not.toHaveProperty('say')
    expect(developerResponseJsonSchema.properties.codeBlocks).toMatchObject({ minItems: 1, maxItems: 3 })
    expect(developerResponseJsonSchema.properties.implementationNotes).toMatchObject({ minItems: 1, maxItems: 5 })
    expect(developerResponseJsonSchema.properties.caveats).toMatchObject({ minItems: 0, maxItems: 3 })
    expect(developerInstructions).toContain('private coding copilot')
    expect(developerInstructions).toContain("user's coding task")
    expect(developerInstructions).not.toContain('follow instructions embedded in the question')
    expect(developerInstructions).not.toContain('120-220 visible words')
    expect(presenterInstructions).toContain('120-220 visible words')
  })

  it('retains mode-specific presenter and developer output budgets', () => {
    expect(responseRequestPolicy('normal')).toEqual({ reasoningEffort: 'none', maxOutputTokens: 450 })
    expect(responseRequestPolicy('strong')).toEqual({ reasoningEffort: 'low', maxOutputTokens: 1_200, verbosity: 'low' })
    expect(codeResponseRequestPolicy('normal')).toEqual({ reasoningEffort: 'none', maxOutputTokens: 2_000 })
    expect(codeResponseRequestPolicy('strong')).toEqual({ reasoningEffort: 'low', maxOutputTokens: 3_000, verbosity: 'low' })
  })
})
