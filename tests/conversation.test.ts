import { describe, expect, it } from 'vitest'
import { ConversationContext, MAX_RESPONSE_SUMMARY_CODE_POINTS, MAX_RETAINED_QUESTION_CODE_POINTS } from '../src/main/ai/conversation'
import type { AssistantResponse } from '../src/shared/contracts'

const response: AssistantResponse = {
  responseStyle: 'presenter',
  category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none',
  say: 'A bounded answer.', keyPoints: ['One.', 'Two.', 'Three.'],
  ifChallenged: 'A bounded challenge response.', evidence: []
}

describe('rolling conversation context', () => {
  it('keeps only the five newest turns and clears locally', () => {
    const context = new ConversationContext()
    for (let index = 0; index < 7; index += 1) context.add(`question-${index}`, response)
    expect(context.asPrompt()).not.toContain('question-0')
    expect(context.asPrompt()).toContain('question-6')
    const revision = context.revision
    context.clear()
    expect(context.asPrompt()).toBe('')
    expect(context.revision).toBe(revision + 1)
  })

  it('bounds retained values by Unicode code points and labels summaries as non-evidence', () => {
    const context = new ConversationContext()
    context.add(`question-${'🙂'.repeat(1_100)}`, {
      ...response, say: '🙂'.repeat(700), ifChallenged: 'extra'
    })
    const snapshot = context.snapshot()
    expect(Array.from(snapshot.turns[0]?.question ?? '')).toHaveLength(MAX_RETAINED_QUESTION_CODE_POINTS)
    expect(Array.from(snapshot.turns[0]?.summary ?? '')).toHaveLength(MAX_RESPONSE_SUMMARY_CODE_POINTS)
    expect(snapshot.prompt).toContain('reference only; not evidence')
  })

  it('does not commit a late answer after clear increments the revision', () => {
    const context = new ConversationContext()
    const revision = context.snapshot().revision
    context.clear()
    expect(context.add('late question', response, revision)).toBe(false)
    expect(context.snapshot().turns).toHaveLength(0)
  })
})
