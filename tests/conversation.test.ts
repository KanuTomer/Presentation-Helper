import { describe, expect, it } from 'vitest'
import { ConversationContext } from '../src/main/ai/conversation'

describe('rolling conversation context', () => {
  it('keeps only the five newest turns and clears locally', () => {
    const context = new ConversationContext()
    for (let index = 0; index < 7; index += 1) context.add(`question-${index}`, { category: 'QUESTION', say: `answer-${index}`, keyPoints: ['a', 'b'], ifChallenged: 'c', evidence: [] })
    expect(context.asPrompt()).not.toContain('question-0')
    expect(context.asPrompt()).toContain('question-6')
    context.clear(); expect(context.asPrompt()).toBe('')
  })
})
