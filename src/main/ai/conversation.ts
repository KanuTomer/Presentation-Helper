import type { AssistantResponse } from '../../shared/contracts.js'

export const MAX_CONVERSATION_TURNS = 5
export const MAX_RETAINED_QUESTION_CODE_POINTS = 1_000
export const MAX_RESPONSE_SUMMARY_CODE_POINTS = 600

export interface ConversationTurn {
  readonly question: string
  readonly summary: string
}

export interface ConversationSnapshot {
  readonly revision: number
  readonly turns: readonly ConversationTurn[]
  readonly previousQuestion?: string
  readonly prompt: string
}

export class ConversationContext {
  private turns: ConversationTurn[] = []
  private currentRevision = 0

  get revision(): number { return this.currentRevision }

  add(question: string, response: AssistantResponse, expectedRevision = this.currentRevision): boolean {
    if (expectedRevision !== this.currentRevision) return false
    const boundedQuestion = boundCodePoints(question, MAX_RETAINED_QUESTION_CODE_POINTS)
    if (!boundedQuestion) return false
    const summary = boundCodePoints(
      [response.say, response.ifChallenged, response.warning].filter(Boolean).join(' '),
      MAX_RESPONSE_SUMMARY_CODE_POINTS
    )
    this.turns.push(Object.freeze({ question: boundedQuestion, summary }))
    this.turns = this.turns.slice(-MAX_CONVERSATION_TURNS)
    return true
  }

  clear(): void {
    this.turns = []
    this.currentRevision += 1
  }

  snapshot(): ConversationSnapshot {
    const turns = Object.freeze(this.turns.map((turn) => Object.freeze({ ...turn })))
    const previousQuestion = turns.at(-1)?.question
    return Object.freeze({
      revision: this.currentRevision,
      turns,
      ...(previousQuestion ? { previousQuestion } : {}),
      prompt: formatTurns(turns)
    })
  }

  asPrompt(): string { return this.snapshot().prompt }
}

export function boundCodePoints(value: string, maximum: number): string {
  const normalized = value.trim()
  const points = Array.from(normalized)
  if (points.length <= maximum) return normalized
  return `${points.slice(0, Math.max(0, maximum - 1)).join('').trimEnd()}…`
}

function formatTurns(turns: readonly ConversationTurn[]): string {
  return turns.map((turn, index) => (
    `${index + 1}. Reviewer: ${turn.question}\nPrior response summary (reference only; not evidence): ${turn.summary}`
  )).join('\n')
}
