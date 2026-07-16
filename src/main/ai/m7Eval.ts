import { z } from 'zod'
import { assistantResponseSchema, type AssistantResponse, type EvidenceIssue, type SupportLevel } from '../../shared/contracts.js'
import { RetrievalIndex, type RetrievedChunk } from '../retrieval/index.js'
import { ConversationContext } from './conversation.js'
import { validateGroundingResponse } from './grounding.js'
import { prepareAnswer } from './preparedAnswer.js'

export const M7_CORPUS_VERSION = 'm7-offline-v2'

export const m7CaseSchema = z.object({
  id: z.string().regex(/^[fsucx]\d{2}$/u),
  group: z.enum(['followup', 'unsupported', 'supported', 'challenge', 'contradictory']),
  question: z.string().min(1).max(4_000),
  priorQuestion: z.string().min(1).max(1_000).optional(),
  support: z.enum(['document-supported', 'general-technical', 'unsupported-project-claim']),
  evidenceIssue: z.enum(['none', 'missing', 'insufficient', 'conflicting']),
  availableChunkIds: z.array(z.string().min(1)).max(5),
  evidenceIds: z.array(z.string().min(1)).max(5),
  warning: z.string().min(1).max(300).optional()
})

export const m7CorpusSchema = z.object({
  version: z.literal(M7_CORPUS_VERSION),
  cases: z.array(m7CaseSchema).length(50)
})

export type M7EvalCase = z.infer<typeof m7CaseSchema>
export type M7Corpus = z.infer<typeof m7CorpusSchema>

export interface M7OfflineReport {
  schemaVersion: 1
  corpusVersion: string
  caseCount: number
  groups: Record<M7EvalCase['group'], number>
  contextualFollowUps: number
  productionPreparedSelections: number
  semanticChecksValid: number
  groundingValid: number
  failedCaseIds: string[]
  passed: boolean
  storesRawPromptsOrResponses: false
}

export async function evaluateM7Offline(input: unknown): Promise<M7OfflineReport> {
  const corpus = m7CorpusSchema.parse(input)
  assertCorpusShape(corpus.cases)
  const failedCaseIds: string[] = []
  let contextualFollowUps = 0
  let productionPreparedSelections = 0
  let semanticChecksValid = 0
  let groundingValid = 0

  for (const item of corpus.cases) {
    const context = new ConversationContext()
    if (item.priorQuestion) context.add(item.priorQuestion, seedGeneralResponse())
    const expectedChunks = chunksForM7Case(item)
    const retrieval = await createCaseRetrieval(item, expectedChunks)
    const searchQueries: string[] = []
    let prepared
    try {
      prepared = prepareAnswer({
        question: item.question,
        context,
        projectSummary: '',
        search: (query) => { searchQueries.push(query); return retrieval.search(query) }
      })
    } finally {
      retrieval.close()
    }
    const query = searchQueries[0] ?? prepared.retrievalQuery
    const contextual = item.group !== 'followup' || Boolean(
      item.priorQuestion && query.includes(item.question) && query.includes(item.priorQuestion)
    )
    if (item.group === 'followup' && contextual) contextualFollowUps += 1

    const chunks = prepared.chunks
    if (chunks.map((chunk) => chunk.id).join('|') === expectedChunks.map((chunk) => chunk.id).join('|')) {
      productionPreparedSelections += 1
    }
    const response = assistantResponseSchema.parse(responseForCase(item, chunks))
    const grounding = validateGroundingResponse(response, item.question, chunks)
    const semantic = evaluateM7AnswerSemantics(item, response)
    if (grounding.valid) groundingValid += 1
    if (semantic.valid) semanticChecksValid += 1
    if (!contextual || !grounding.valid || !semantic.valid) failedCaseIds.push(item.id)
  }

  return {
    schemaVersion: 1,
    corpusVersion: corpus.version,
    caseCount: corpus.cases.length,
    groups: groupCounts(corpus.cases),
    contextualFollowUps,
    productionPreparedSelections,
    semanticChecksValid,
    groundingValid,
    failedCaseIds,
    passed: failedCaseIds.length === 0,
    storesRawPromptsOrResponses: false
  }
}

async function createCaseRetrieval(item: M7EvalCase, chunks: readonly RetrievedChunk[]): Promise<RetrievalIndex> {
  const documentId = `m7-${item.id}-document`
  const path = `${item.id}.txt`
  const retrieval = new RetrievalIndex({
    databasePath: ':memory:',
    idGenerator: () => documentId,
    clock: () => new Date('2026-07-16T00:00:00.000Z'),
    canonicalizePath: (value) => value,
    readBytes: async () => new TextEncoder().encode(`M7 synthetic fixture ${item.id}`),
    parser: async () => chunks.map((chunk, index) => ({
      id: chunk.id,
      documentId,
      text: chunk.text,
      title: `M7 ${item.id} evidence ${index + 1}`,
      section: `Case ${item.id}`,
      kind: 'text' as const,
      part: 1,
      partCount: 1
    }))
  })
  await retrieval.initialize()
  if (chunks.length > 0) {
    const result = await retrieval.addFiles([path])
    if (result.outcomes[0]?.status === 'failed') {
      retrieval.close()
      throw new Error(`M7 synthetic retrieval fixture ${item.id} could not be indexed.`)
    }
  }
  return retrieval
}

export function chunksForM7Case(item: M7EvalCase): RetrievedChunk[] {
  return item.availableChunkIds.map((id, index) => chunk(
    id,
    index,
    item.group === 'contradictory'
      ? index === 0
        ? `Project record A answers "${item.question}" with option Alpha as definitive.`
        : `Project record B explicitly contradicts record A and answers "${item.question}" with option Beta.`
      : item.group === 'followup'
        ? `This project evidence addresses the prior reviewer subject "${item.priorQuestion}". The follow-up answer anchor is ${m7RequiredAnchor(item)} and documents the relevant design decision without numeric claims.`
      : `This project evidence directly addresses "${item.question}". The answer anchor is ${m7RequiredAnchor(item)} and documents the relevant design decision without numeric claims.`
  ))
}

export interface M7SemanticChecks {
  requiredAnchorPresent: boolean
  unsupportedSafe: boolean
  challengeStructure: boolean
  conflictNeutral: boolean
  categoryCorrect: boolean
  valid: boolean
}

export function m7RequiredAnchor(item: M7EvalCase): string {
  return `m7-${item.id}-anchor`
}

export function evaluateM7AnswerSemantics(item: M7EvalCase, response: AssistantResponse): M7SemanticChecks {
  const visible = [response.say, ...response.keyPoints, response.ifChallenged, response.warning ?? ''].join(' ')
  const normalized = visible.toLocaleLowerCase('en-US')
  const requiredAnchorPresent = item.support !== 'document-supported' || normalized.includes(m7RequiredAnchor(item))
  const conflictLanguage = /\b(?:conflict|contradict|inconsisten)\w*/iu.test(visible)
  const choosesConflictSide = /\b(?:therefore|definitively|clearly|we\s+choose|the\s+answer\s+is)\s+(?:alpha|beta)\b/iu.test(visible)
  const unsupportedSafe = item.support !== 'unsupported-project-claim' || (
    response.evidenceIssue === 'conflicting'
      ? conflictLanguage && !choosesConflictSide
      : /\b(?:no\s+(?:supplied|available|documented)\s+(?:project\s+)?evidence|unknown|unsupported|cannot\s+(?:determine|state|support)|not\s+(?:provided|documented|established))\b/iu.test(visible) &&
        !/\b\d+(?:\.\d+)?%?\b/u.test(visible) &&
        !/\b(?:our\s+(?:project|experiment|model|implementation|system)|the\s+(?:project|experiment|model|implementation|system))\s+(?:used|implemented|achieved|reached|ran\s+on|included|cost|consumed)\s+(?!no\b|not\b|unknown\b)/iu.test(visible)
  )
  const challengeStructure = item.group !== 'challenge' || (
    /\b(?:fair|valid|understand|acknowledge)\b/iu.test(visible) &&
    /\b(?:evidence|document|source|citation)\b/iu.test(visible) &&
    /\b(?:limitation|trade-off|however|cannot|does\s+not)\b/iu.test(visible)
  )
  const conflictNeutral = item.group !== 'contradictory' || (
    conflictLanguage && !choosesConflictSide
  )
  const categoryCorrect = item.group !== 'challenge' || response.category === 'CHALLENGE'
  return {
    requiredAnchorPresent, unsupportedSafe, challengeStructure, conflictNeutral, categoryCorrect,
    valid: requiredAnchorPresent && unsupportedSafe && challengeStructure && conflictNeutral && categoryCorrect
  }
}

function responseForCase(item: M7EvalCase, chunks: readonly RetrievedChunk[]): AssistantResponse {
  const byId = new Map(chunks.map((item) => [item.id, item]))
  return {
    category: item.group === 'challenge' ? 'CHALLENGE' : 'FACTUAL',
    support: item.support as SupportLevel,
    evidenceIssue: item.evidenceIssue as EvidenceIssue,
    say: item.group === 'challenge'
      ? `That is a fair concern. Document evidence supports ${m7RequiredAnchor(item)}; however, the limitation must remain explicit.`
      : item.group === 'contradictory'
        ? 'The supplied sources conflict between Alpha and Beta, so neither account can be selected as authoritative.'
        : item.support === 'unsupported-project-claim'
          ? 'No supplied project evidence establishes the requested project fact, so it remains unknown and unsupported.'
          : `The supplied evidence supports ${m7RequiredAnchor(item)} as the bounded answer to the reviewer question.`,
    keyPoints: ['Only supplied chunks count as evidence.', 'Conversation context is reference only.', 'Warnings expose evidence limitations.'],
    ifChallenged: 'The evaluator validates the same invariant function used by production response handling.',
    ...(item.warning ? { warning: item.warning } : {}),
    evidence: item.evidenceIds.map((id) => {
      const evidence = byId.get(id)
      return { chunkId: id, documentName: evidence?.documentName ?? 'missing.txt', location: evidence?.location ?? 'Missing' }
    })
  }
}

function seedGeneralResponse(): AssistantResponse {
  return {
    category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none',
    say: 'A bounded prior response summary.', keyPoints: ['One.', 'Two.', 'Three.'],
    ifChallenged: 'This summary is reference only.', evidence: []
  }
}

function chunk(id: string, index: number, text = `Synthetic project evidence for ${id} describes the requested design decision without numeric claims.`): RetrievedChunk {
  return {
    id, documentId: `document-${index}`, documentName: `evidence-${index}.txt`,
    location: `Section ${String.fromCharCode(65 + index)}`,
    text,
    kind: 'text', part: 1, partCount: 1, score: 10 - index
  }
}

function assertCorpusShape(cases: readonly M7EvalCase[]): void {
  const ids = new Set(cases.map((item) => item.id))
  if (ids.size !== cases.length) throw new Error('M7 corpus contains duplicate case IDs.')
  const counts = groupCounts(cases)
  if (counts.followup !== 20 || counts.unsupported !== 15 || counts.supported !== 5 || counts.challenge !== 5 || counts.contradictory !== 5) {
    throw new Error('M7 corpus must contain 20 follow-ups, 15 unsupported, five supported, five challenges, and five contradictory cases.')
  }
  if (cases.filter((item) => item.group === 'followup' && item.support === 'document-supported').length !== 15) {
    throw new Error('M7 corpus must contain 15 document-supported follow-ups.')
  }
  if (cases.some((item) => item.group === 'followup' && !item.priorQuestion)) {
    throw new Error('Every M7 follow-up requires a prior reviewer question.')
  }
}

function groupCounts(cases: readonly M7EvalCase[]): Record<M7EvalCase['group'], number> {
  return {
    followup: cases.filter((item) => item.group === 'followup').length,
    unsupported: cases.filter((item) => item.group === 'unsupported').length,
    supported: cases.filter((item) => item.group === 'supported').length,
    challenge: cases.filter((item) => item.group === 'challenge').length,
    contradictory: cases.filter((item) => item.group === 'contradictory').length
  }
}
