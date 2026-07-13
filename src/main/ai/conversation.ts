import type { AssistantResponse } from '../../shared/contracts.js'

interface Turn { question: string; summary: string }
export class ConversationContext {
  private turns: Turn[] = []
  add(question: string, response: AssistantResponse): void {
    this.turns.push({ question, summary: `${response.say} ${response.warning ?? ''}`.slice(0, 600) })
    this.turns = this.turns.slice(-5)
  }
  clear(): void { this.turns = [] }
  asPrompt(): string { return this.turns.map((turn, index) => `${index + 1}. Reviewer: ${turn.question}\nResponse summary: ${turn.summary}`).join('\n') }
}
