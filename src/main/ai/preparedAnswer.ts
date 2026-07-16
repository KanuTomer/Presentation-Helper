import { questionSchema } from '../../shared/contracts.js'
import { selectEvidenceChunks, type RetrievedChunk } from '../retrieval/index.js'
import { boundCodePoints, type ConversationContext, type ConversationSnapshot } from './conversation.js'

export const MAX_PROJECT_SUMMARY_CODE_POINTS = 4_000
export const MAX_RETRIEVAL_QUERY_CODE_POINTS = 4_000

export interface PreparedAnswer {
  readonly question: string
  readonly retrievalQuery: string
  readonly contextRevision: number
  readonly rollingTurnCount: number
  readonly conversationPrompt: string
  readonly projectSummary: string
  readonly chunks: readonly RetrievedChunk[]
}

interface PrepareAnswerInput {
  question: string
  context: ConversationContext
  projectSummary: string
  search?: (query: string, limit: number) => RetrievedChunk[]
  chunks?: readonly RetrievedChunk[]
  signal?: AbortSignal
}

const preparedAnswerSymbol: unique symbol = Symbol('PresenterAI.PreparedAnswer')
type PreparedChunkList = RetrievedChunk[] & { readonly [preparedAnswerSymbol]?: PreparedAnswer }

export function prepareAnswer(input: PrepareAnswerInput): PreparedAnswer {
  const parsed = questionSchema.safeParse(input.question)
  if (!parsed.success) throw parsed.error
  throwIfAborted(input.signal)
  const snapshot = input.context.snapshot()
  const retrievalQuery = buildContextualRetrievalQuery(parsed.data, snapshot)
  const selected = selectEvidenceChunks(input.chunks
    ? [...input.chunks]
    : (input.search?.(retrievalQuery, 5) ?? []))
  throwIfAborted(input.signal)
  return Object.freeze({
    question: parsed.data,
    retrievalQuery,
    contextRevision: snapshot.revision,
    rollingTurnCount: snapshot.turns.length,
    conversationPrompt: snapshot.prompt,
    projectSummary: boundCodePoints(input.projectSummary, MAX_PROJECT_SUMMARY_CODE_POINTS),
    chunks: Object.freeze(selected.map((chunk) => Object.freeze({ ...chunk })))
  })
}

export function buildContextualRetrievalQuery(question: string, snapshot: ConversationSnapshot): string {
  const current = boundCodePoints(question, MAX_RETRIEVAL_QUERY_CODE_POINTS)
  if (!snapshot.previousQuestion || !isReferentialFollowUp(current)) return current
  const separator = '\nPrior reviewer question: '
  const prior = boundCodePoints(
    snapshot.previousQuestion,
    MAX_RETRIEVAL_QUERY_CODE_POINTS - Array.from(separator).length - 1
  )
  const reserved = Array.from(`${separator}${prior}`).length
  const boundedCurrent = boundCodePoints(current, Math.max(1, MAX_RETRIEVAL_QUERY_CODE_POINTS - reserved))
  return `${boundedCurrent}${separator}${prior}`
}

export function isReferentialFollowUp(question: string): boolean {
  return /\b(?:it|that|those|they|them|the same(?:\s+(?:approach|method|thing|result|system))?|that\s+(?:approach|method|result|system)|the\s+(?:former|latter|previous)\s+(?:approach|method|result|system))\b/iu.test(question)
}

export function attachPreparedAnswer(prepared: PreparedAnswer): RetrievedChunk[] {
  const chunks: PreparedChunkList = [...prepared.chunks]
  Object.defineProperty(chunks, preparedAnswerSymbol, {
    configurable: false, enumerable: false, writable: false, value: prepared
  })
  return chunks
}

export function preparedAnswerFromChunks(chunks: readonly RetrievedChunk[]): PreparedAnswer | undefined {
  return (chunks as PreparedChunkList)[preparedAnswerSymbol]
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation cancelled.', 'AbortError')
}
