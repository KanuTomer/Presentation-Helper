import { describe, expect, it } from 'vitest'
import { ConversationContext } from '../src/main/ai/conversation'
import { validateGroundingResponse } from '../src/main/ai/grounding'
import { buildContextualRetrievalQuery, prepareAnswer } from '../src/main/ai/preparedAnswer'
import type { AssistantResponse } from '../src/shared/contracts'
import type { RetrievedChunk } from '../src/main/retrieval'

const chunkA = chunk('a')
const chunkB = chunk('b')
const base: AssistantResponse = {
  category: 'FACTUAL', support: 'document-supported', evidenceIssue: 'none',
  say: 'The project fact is supported by the supplied local evidence.',
  keyPoints: ['Use supplied evidence.', 'Keep claims bounded.', 'Expose limitations.'],
  ifChallenged: 'The citation is restricted to the selected request context.',
  evidence: [{ chunkId: chunkA.id, documentName: chunkA.documentName, location: chunkA.location }]
}

describe('M7 prepared answers', () => {
  it('expands referential retrieval with only the immediately preceding reviewer question', () => {
    const context = new ConversationContext()
    context.add('Which cache policy does our implementation use?', {
      ...base, say: 'SECRET RESPONSE SUMMARY MUST NOT ENTER RETRIEVAL'
    })
    const query = buildContextualRetrievalQuery('How does that affect our runtime?', context.snapshot())
    expect(query).toContain('Which cache policy does our implementation use?')
    expect(query).not.toContain('SECRET RESPONSE SUMMARY')
  })

  it('does not expand a standalone question and bounds project background', () => {
    const context = new ConversationContext()
    context.add('An unrelated previous question?', base)
    const searchQueries: string[] = []
    const prepared = prepareAnswer({
      question: 'Explain eventual consistency.', context, projectSummary: '🙂'.repeat(4_500),
      search: (query) => { searchQueries.push(query); return [chunkA] }
    })
    expect(searchQueries).toEqual(['Explain eventual consistency.'])
    expect(Array.from(prepared.projectSummary)).toHaveLength(4_000)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.chunks)).toBe(true)
  })

  it('reserves retrieval-query space for the antecedent at the 4,000-code-point boundary', () => {
    const context = new ConversationContext()
    const prior = 'Which bounded cache policy does our implementation use?'
    context.add(prior, base)
    const query = buildContextualRetrievalQuery(`How does that behave? ${'x'.repeat(4_000)}`, context.snapshot())
    expect(Array.from(query).length).toBeLessThanOrEqual(4_000)
    expect(query).toContain(`Prior reviewer question: ${prior}`)
  })
})

describe('M7 grounding invariants', () => {
  it('accepts document-supported, general, unsupported, and explicit-conflict states', () => {
    expect(validateGroundingResponse(base, 'Which method does our implementation use?', [chunkA]).valid).toBe(true)
    expect(validateGroundingResponse({
      ...base, support: 'general-technical', evidenceIssue: 'none', evidence: []
    }, 'What is eventual consistency?', []).valid).toBe(true)
    expect(validateGroundingResponse({
      ...base, support: 'unsupported-project-claim', evidenceIssue: 'missing', evidence: [],
      warning: 'No project evidence supports the requested result.'
    }, 'What accuracy did our project achieve?', []).valid).toBe(true)
    expect(validateGroundingResponse({
      ...base, support: 'unsupported-project-claim', evidenceIssue: 'conflicting',
      warning: 'The supplied documents contain conflicting project claims.',
      evidence: [
        { chunkId: chunkA.id, documentName: chunkA.documentName, location: chunkA.location },
        { chunkId: chunkB.id, documentName: chunkB.documentName, location: chunkB.location }
      ]
    }, 'What accuracy did our project achieve?', [chunkA, chunkB]).valid).toBe(true)
  })

  it.each([
    [{ ...base, evidence: [] }, 'document-supported answer has no citation'],
    [{ ...base, support: 'general-technical', evidence: [] }, 'project-specific factual question was labeled general'],
    [{ ...base, support: 'unsupported-project-claim', evidenceIssue: 'missing', evidence: [] }, 'unsupported project answer lacks'],
    [{ ...base, support: 'unsupported-project-claim', evidenceIssue: 'conflicting', warning: 'Evidence is weak.' }, 'conflicting evidence is not represented'],
    [{ ...base, evidence: [{ chunkId: 'forged', documentName: 'fake', location: 'fake' }] }, 'citation was not supplied']
  ] as const)('rejects inconsistent or forged support state', (response, reason) => {
    const result = validateGroundingResponse(response as AssistantResponse, 'Which method does our implementation use?', [chunkA])
    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining(reason) })
  })
})

function chunk(id: string): RetrievedChunk {
  return {
    id, documentId: `doc-${id}`, documentName: `${id}.txt`, location: 'Section',
    text: `Evidence ${id}`, kind: 'text', part: 1, partCount: 1, score: 1
  }
}
