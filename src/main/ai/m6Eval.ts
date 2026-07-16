import { createHash } from 'node:crypto'
import { z } from 'zod'
import { maximumCallCostUsd, tokenCostUsd } from './evalBudget.js'
import { buildInput, presenterInstructions, responseJsonSchema } from './prompts.js'
import {
  MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
  MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION,
  USAGE_PRICING_VERSION
} from './pricing.js'
import type { RetrievedChunk } from '../retrieval/index.js'

export const M6_LIVE_BUDGET_USD = 0.15
export const M6_CORPUS_SIZE = 20
export const M6_FULL_PIPELINE_SIZE = 10
export const M6_MAX_CAPTURE_SECONDS = 90
// Live validation uses deliberately short reviewer questions. The product
// still supports the full 90-second bound, but the paid campaign rejects clips
// over 20 seconds before upload so a small account cannot be drained by one
// accidentally held shortcut.
export const M6_EVALUATION_MAX_CAPTURE_SECONDS = 20
export const M6_RESERVED_TRANSCRIPTION_OUTPUT_TOKENS = 512
export const M6_RESERVED_TRANSCRIPTION_HINT_TOKENS = 500
// Reserve twice the observed ~40 audio tokens/second plus the worst-case
// code-point count of the 500-character terminology hint. These are budget
// guardrails, not a billing prediction; actual charges use returned JSON usage.
export const M6_RESERVED_AUDIO_TOKENS_PER_SECOND = 80
// The transcription endpoint exposes no per-request output-token cap. These
// documented model limits therefore define the only defensible hard ceiling;
// the smaller reserve above remains an estimate for planning, never a promise.
export const M6_TRANSCRIPTION_DOCUMENTED_MAX_INPUT_TOKENS = 16_000
export const M6_TRANSCRIPTION_DOCUMENTED_MAX_OUTPUT_TOKENS = 2_000
export const M6_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
export const M6_ANSWER_MODEL = 'gpt-5.6-luna'
export const M6_REPORT_SCHEMA_VERSION = 3
export const M6_ANSWER_INPUT_USD_PER_MILLION = 1
export const M6_ANSWER_OUTPUT_USD_PER_MILLION = 6
export const M6_EVALUATOR_REVISION = 'm6-live-evaluator-2026-07-14.4'
export const M6_REQUEST_CONFIG_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  evaluatorRevision: M6_EVALUATOR_REVISION,
  helperProtocol: 2,
  transcription: {
    model: M6_TRANSCRIPTION_MODEL, responseFormat: 'json', sdkRetries: 0,
    evaluationMaxCaptureSeconds: M6_EVALUATION_MAX_CAPTURE_SECONDS,
    reservedAudioTokensPerSecond: M6_RESERVED_AUDIO_TOKENS_PER_SECOND,
    reservedHintTokens: M6_RESERVED_TRANSCRIPTION_HINT_TOKENS,
    reservedOutputTokens: M6_RESERVED_TRANSCRIPTION_OUTPUT_TOKENS,
    documentedMaxInputTokens: M6_TRANSCRIPTION_DOCUMENTED_MAX_INPUT_TOKENS,
    documentedMaxOutputTokens: M6_TRANSCRIPTION_DOCUMENTED_MAX_OUTPUT_TOKENS
  },
  answer: {
    model: M6_ANSWER_MODEL, reasoningEffort: 'none', maxOutputTokens: 450,
    store: false, instructions: presenterInstructions, responseJsonSchema
  }
})).digest('hex')

const corpusCaseSchema = z.object({
  id: z.string().regex(/^m6-\d{2}$/),
  expectedQuestion: z.string().trim().min(1).max(4_000),
  meaningAnchors: z.array(z.string().trim().min(1).max(64)).min(2).max(8),
  fullPipeline: z.boolean(),
  evidenceTitle: z.string().trim().min(1).max(200).optional(),
  evidenceText: z.string().trim().min(1).max(1_000).optional()
}).strict().superRefine((value, context) => {
  if (value.fullPipeline && (!value.evidenceTitle || !value.evidenceText)) {
    context.addIssue({ code: 'custom', message: 'Full-pipeline cases require evidenceTitle and evidenceText.' })
  }
  if (!value.fullPipeline && (value.evidenceTitle || value.evidenceText)) {
    context.addIssue({ code: 'custom', message: 'Transcription-only cases must not define answer evidence.' })
  }
})

export type M6CorpusCase = z.infer<typeof corpusCaseSchema>

export interface M6CaseResult {
  id: string
  fullPipeline: boolean
  passed: boolean
  flags: {
    audioValid: boolean
    transcriptionValid: boolean
    meaningCorrect: boolean
    wavDeleted: boolean
    pipelineValid: boolean
    evidenceValid: boolean
  }
  versions: {
    helperProtocol: number
    requestedTranscriptionModel: string
    returnedTranscriptionModel?: string
    requestedAnswerModel?: string
    returnedAnswerModel?: string
    pricing: string
  }
  timingsMs: {
    capture: number
    finalization: number
    transcription: number
    retrieval?: number
    generation?: number
    /** Renderer-confirmed release-to-visible-answer time; never inferred from generation completion. */
    releaseToVisibleAnswer?: number
    total: number
  }
  usage: {
    transcriptionInputTokens: number
    transcriptionAudioTokens: number
    transcriptionOutputTokens: number
    answerInputTokens: number
    answerOutputTokens: number
    answerReasoningTokens: number
    /** Conservative call reserve used only when a provider response omits usable token metadata. */
    unreportedUsageReserveUsd: number
  }
  estimatedCostUsd: number
  errorCode?: string
}

export interface M6RedactedReport {
  schemaVersion: number
  evaluatorRevision: string
  requestConfigFingerprint: string
  corpusFingerprint: string
  corpusSize: number
  fullPipelineSize: number
  startedAt: string
  updatedAt: string
  budget: {
    capUsd: number
    actualUsd: number
    preflightMaximumUsd: number
    documentedMaximumUsd: number
  }
  models: { transcription: string; answer: string }
  pricing: {
    version: string
    transcriptionInputPerMillion: number
    transcriptionOutputPerMillion: number
    answerInputPerMillion: number
    answerOutputPerMillion: number
  }
  results: M6CaseResult[]
  failedIds: string[]
  aggregateGate?: {
    accepted: boolean
    transcriptionValidCount: number
    meaningCorrectCount: number
    fullPipelineValidCount: number
    releaseToAnswerP50Ms: number
    releaseToAnswerP95Ms: number
    flags: {
      transcription: boolean
      meaning: boolean
      pipeline: boolean
      latency: boolean
      budget: boolean
    }
  }
}

const nonnegativeFinite = z.number().finite().nonnegative()
const tokenCount = z.number().int().nonnegative()
const m6CaseResultSchema = z.object({
  id: z.string().regex(/^m6-\d{2}$/),
  fullPipeline: z.boolean(),
  passed: z.boolean(),
  flags: z.object({
    audioValid: z.boolean(), transcriptionValid: z.boolean(), meaningCorrect: z.boolean(),
    wavDeleted: z.boolean(), pipelineValid: z.boolean(), evidenceValid: z.boolean()
  }).strict(),
  versions: z.object({
    helperProtocol: z.literal(2),
    requestedTranscriptionModel: z.literal(M6_TRANSCRIPTION_MODEL),
    returnedTranscriptionModel: z.string().trim().min(1).max(200).optional(),
    requestedAnswerModel: z.literal(M6_ANSWER_MODEL).optional(),
    returnedAnswerModel: z.string().trim().min(1).max(200).optional(),
    pricing: z.literal(USAGE_PRICING_VERSION)
  }).strict(),
  timingsMs: z.object({
    capture: nonnegativeFinite, finalization: nonnegativeFinite, transcription: nonnegativeFinite,
    retrieval: nonnegativeFinite.optional(), generation: nonnegativeFinite.optional(),
    releaseToVisibleAnswer: nonnegativeFinite.optional(), total: nonnegativeFinite
  }).strict(),
  usage: z.object({
    transcriptionInputTokens: tokenCount, transcriptionAudioTokens: tokenCount, transcriptionOutputTokens: tokenCount,
    answerInputTokens: tokenCount, answerOutputTokens: tokenCount, answerReasoningTokens: tokenCount,
    unreportedUsageReserveUsd: nonnegativeFinite
  }).strict(),
  estimatedCostUsd: nonnegativeFinite,
  errorCode: z.string().trim().min(1).max(80).optional()
}).strict()

const aggregateGateSchema = z.object({
  accepted: z.boolean(),
  transcriptionValidCount: z.number().int().nonnegative().max(M6_CORPUS_SIZE),
  meaningCorrectCount: z.number().int().nonnegative().max(M6_CORPUS_SIZE),
  fullPipelineValidCount: z.number().int().nonnegative().max(M6_FULL_PIPELINE_SIZE),
  releaseToAnswerP50Ms: nonnegativeFinite,
  releaseToAnswerP95Ms: nonnegativeFinite,
  flags: z.object({
    transcription: z.boolean(), meaning: z.boolean(), pipeline: z.boolean(), latency: z.boolean(), budget: z.boolean()
  }).strict()
}).strict()

const m6RedactedReportSchema = z.object({
  schemaVersion: z.literal(M6_REPORT_SCHEMA_VERSION),
  evaluatorRevision: z.literal(M6_EVALUATOR_REVISION),
  requestConfigFingerprint: z.literal(M6_REQUEST_CONFIG_FINGERPRINT),
  corpusFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  corpusSize: z.literal(M6_CORPUS_SIZE),
  fullPipelineSize: z.literal(M6_FULL_PIPELINE_SIZE),
  startedAt: z.string().min(20).max(40),
  updatedAt: z.string().min(20).max(40),
  budget: z.object({
    capUsd: z.literal(M6_LIVE_BUDGET_USD),
    actualUsd: nonnegativeFinite,
    preflightMaximumUsd: nonnegativeFinite,
    documentedMaximumUsd: nonnegativeFinite
  }).strict(),
  models: z.object({
    transcription: z.literal(M6_TRANSCRIPTION_MODEL), answer: z.literal(M6_ANSWER_MODEL)
  }).strict(),
  pricing: z.object({
    version: z.literal(USAGE_PRICING_VERSION),
    transcriptionInputPerMillion: z.literal(MINI_TRANSCRIBE_INPUT_USD_PER_MILLION),
    transcriptionOutputPerMillion: z.literal(MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION),
    answerInputPerMillion: z.literal(M6_ANSWER_INPUT_USD_PER_MILLION),
    answerOutputPerMillion: z.literal(M6_ANSWER_OUTPUT_USD_PER_MILLION)
  }).strict(),
  results: z.array(m6CaseResultSchema).max(M6_CORPUS_SIZE),
  failedIds: z.array(z.string().regex(/^m6-\d{2}$/)).max(M6_CORPUS_SIZE),
  aggregateGate: aggregateGateSchema.optional()
}).strict()

export function parseM6Corpus(value: unknown): M6CorpusCase[] {
  const parsed = z.array(corpusCaseSchema).safeParse(value)
  if (!parsed.success) throw new Error(`Invalid M6 corpus: ${parsed.error.issues[0]?.message ?? 'unknown error'}`)
  if (parsed.data.length !== M6_CORPUS_SIZE) throw new Error(`M6 corpus must contain exactly ${M6_CORPUS_SIZE} cases.`)
  const ids = new Set(parsed.data.map((item) => item.id))
  if (ids.size !== parsed.data.length) throw new Error('M6 corpus contains duplicate case IDs.')
  if (parsed.data.filter((item) => item.fullPipeline).length !== M6_FULL_PIPELINE_SIZE) {
    throw new Error(`M6 corpus must designate exactly ${M6_FULL_PIPELINE_SIZE} full-pipeline cases.`)
  }
  const ordered = [...parsed.data].sort((left, right) => left.id.localeCompare(right.id))
  if (ordered.some((item, index) => item.id !== `m6-${String(index + 1).padStart(2, '0')}`)) {
    throw new Error('M6 corpus IDs must be the contiguous sequence m6-01 through m6-20.')
  }
  if (ordered.slice(0, M6_FULL_PIPELINE_SIZE).some((item) => !item.fullPipeline)) {
    throw new Error('The first ten M6 cases must be the predesignated full-pipeline cases.')
  }
  return ordered
}

export function m6CorpusFingerprint(corpus: readonly M6CorpusCase[]): string {
  return createHash('sha256').update(JSON.stringify(corpus)).digest('hex')
}

export function transcriptionMaximumCostUsd(durationSeconds = M6_EVALUATION_MAX_CAPTURE_SECONDS): number {
  const duration = Math.max(0, Math.min(M6_EVALUATION_MAX_CAPTURE_SECONDS, durationSeconds))
  const inputTokens = Math.ceil(duration * M6_RESERVED_AUDIO_TOKENS_PER_SECOND) + M6_RESERVED_TRANSCRIPTION_HINT_TOKENS
  return transcriptionTokenCostUsd(inputTokens, M6_RESERVED_TRANSCRIPTION_OUTPUT_TOKENS)
}

export function transcriptionTokenCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    Math.max(0, inputTokens) * MINI_TRANSCRIBE_INPUT_USD_PER_MILLION +
    Math.max(0, outputTokens) * MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION
  ) / 1_000_000
}

export function answerMaximumCostUsd(
  corpus: readonly M6CorpusCase[],
  current: M6CorpusCase,
  question = current.expectedQuestion
): number {
  const evidenceDocument = buildReferenceDocument(corpus)
  const chunk = evidenceChunk(evidenceDocument)
  return answerMaximumRequestCostUsd(question, [chunk])
}

export function answerMaximumRequestCostUsd(question: string, chunks: readonly RetrievedChunk[]): number {
  const serialized = JSON.stringify({
    model: M6_ANSWER_MODEL,
    reasoning: { effort: 'none' },
    instructions: presenterInstructions,
    input: buildInput(question, [...chunks], '', ''),
    max_output_tokens: 450,
    store: false,
    text: { format: { type: 'json_schema', name: 'presenter_response', strict: true, schema: responseJsonSchema } }
  })
  return maximumCallCostUsd('normal', serialized)
}

export function maximumM6CampaignCostUsd(corpus: readonly M6CorpusCase[]): number {
  return corpus.reduce((total, item) => total + transcriptionMaximumCostUsd() +
    (item.fullPipeline ? answerMaximumCostUsd(corpus, item) : 0), 0)
}

export function documentedMaximumM6CampaignCostUsd(corpus: readonly M6CorpusCase[]): number {
  const transcriptionMaximum = transcriptionTokenCostUsd(
    M6_TRANSCRIPTION_DOCUMENTED_MAX_INPUT_TOKENS,
    M6_TRANSCRIPTION_DOCUMENTED_MAX_OUTPUT_TOKENS
  )
  return corpus.reduce((total, item) => total + transcriptionMaximum +
    (item.fullPipeline ? answerMaximumCostUsd(corpus, item) : 0), 0)
}

export class M6BudgetLedger {
  constructor(
    public spentUsd = 0,
    public readonly capUsd = M6_LIVE_BUDGET_USD
  ) {
    if (!Number.isFinite(spentUsd) || spentUsd < 0) {
      throw new Error('The saved M6 lifetime spend is invalid.')
    }
  }

  assertReserve(projectedRemainingUsd: number): void {
    if (!Number.isFinite(projectedRemainingUsd) || projectedRemainingUsd < 0 ||
      this.spentUsd + projectedRemainingUsd > this.capUsd + Number.EPSILON) {
      throw new Error(`M6 budget stop: projected lifetime spend would exceed $${this.capUsd.toFixed(2)}.`)
    }
  }

  recordActual(actualUsd: number): void {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error('M6 actual spend is invalid.')
    this.spentUsd += actualUsd
    if (this.spentUsd > this.capUsd + Number.EPSILON) {
      throw Object.assign(new Error(`M6 budget stop: actual lifetime spend exceeded $${this.capUsd.toFixed(2)}.`), { code: 'budget_exceeded' })
    }
  }
}

export function actualAnswerCostUsd(inputTokens: number, outputTokens: number): number {
  return tokenCostUsd('normal', inputTokens, outputTokens)
}

export function buildReferenceDocument(corpus: readonly M6CorpusCase[]): string {
  return corpus.filter((item) => item.fullPipeline).map((item) =>
    `${item.evidenceTitle}\n${item.evidenceText}`
  ).join('\n\n')
}

export function meaningLooksCorrect(transcript: string, expectedQuestion: string, anchors: readonly string[]): boolean {
  const actual = normalizedWords(transcript)
  const expected = normalizedWords(expectedQuestion)
  const anchorHits = anchors.filter((anchor) => {
    const words = normalizedWords(anchor)
    return words.size > 0 && [...words].every((word) => actual.has(word))
  }).length
  const intersection = [...expected].filter((word) => actual.has(word)).length
  const recall = expected.size === 0 ? 0 : intersection / expected.size
  return anchorHits >= Math.ceil(anchors.length * 0.6) && recall >= 0.55
}

export function newM6Report(corpus: readonly M6CorpusCase[], now = new Date()): M6RedactedReport {
  const maximum = maximumM6CampaignCostUsd(corpus)
  const documentedMaximum = documentedMaximumM6CampaignCostUsd(corpus)
  if (maximum > M6_LIVE_BUDGET_USD + Number.EPSILON) {
    throw new Error(`The M6 corpus projects $${maximum.toFixed(6)}, above the $${M6_LIVE_BUDGET_USD.toFixed(2)} cap.`)
  }
  return {
    schemaVersion: M6_REPORT_SCHEMA_VERSION,
    evaluatorRevision: M6_EVALUATOR_REVISION,
    requestConfigFingerprint: M6_REQUEST_CONFIG_FINGERPRINT,
    corpusFingerprint: m6CorpusFingerprint(corpus),
    corpusSize: corpus.length,
    fullPipelineSize: corpus.filter((item) => item.fullPipeline).length,
    startedAt: now.toISOString(), updatedAt: now.toISOString(),
    budget: {
      capUsd: M6_LIVE_BUDGET_USD,
      actualUsd: 0,
      preflightMaximumUsd: maximum,
      documentedMaximumUsd: documentedMaximum
    },
    models: { transcription: M6_TRANSCRIPTION_MODEL, answer: M6_ANSWER_MODEL },
    pricing: {
      version: USAGE_PRICING_VERSION,
      transcriptionInputPerMillion: MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
      transcriptionOutputPerMillion: MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION,
      answerInputPerMillion: M6_ANSWER_INPUT_USD_PER_MILLION,
      answerOutputPerMillion: M6_ANSWER_OUTPUT_USD_PER_MILLION
    },
    results: [], failedIds: []
  }
}

export function validateM6ResumeReport(value: unknown, corpus: readonly M6CorpusCase[]): M6RedactedReport {
  assertRedactedM6Report(value)
  const parsedReport = m6RedactedReportSchema.safeParse(value)
  if (!parsedReport.success) throw new Error('The saved M6 report has an invalid or non-redacted shape.')
  const report = parsedReport.data as M6RedactedReport
  const expectedMaximum = maximumM6CampaignCostUsd(corpus)
  const expectedDocumentedMaximum = documentedMaximumM6CampaignCostUsd(corpus)
  if (report.schemaVersion !== M6_REPORT_SCHEMA_VERSION ||
      report.evaluatorRevision !== M6_EVALUATOR_REVISION ||
      report.requestConfigFingerprint !== M6_REQUEST_CONFIG_FINGERPRINT ||
      report.corpusFingerprint !== m6CorpusFingerprint(corpus) ||
      report.corpusSize !== M6_CORPUS_SIZE || report.fullPipelineSize !== M6_FULL_PIPELINE_SIZE ||
      report.budget?.capUsd !== M6_LIVE_BUDGET_USD || !Number.isFinite(report.budget?.actualUsd) || report.budget.actualUsd < 0 ||
      Math.abs(report.budget?.preflightMaximumUsd - expectedMaximum) > 1e-9 ||
      Math.abs(report.budget?.documentedMaximumUsd - expectedDocumentedMaximum) > 1e-9 ||
      report.pricing?.version !== USAGE_PRICING_VERSION ||
      report.pricing?.transcriptionInputPerMillion !== MINI_TRANSCRIBE_INPUT_USD_PER_MILLION ||
      report.pricing?.transcriptionOutputPerMillion !== MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION ||
      report.pricing?.answerInputPerMillion !== M6_ANSWER_INPUT_USD_PER_MILLION ||
      report.pricing?.answerOutputPerMillion !== M6_ANSWER_OUTPUT_USD_PER_MILLION ||
      report.models?.transcription !== M6_TRANSCRIPTION_MODEL || report.models?.answer !== M6_ANSWER_MODEL ||
      !Array.isArray(report.results) || !Array.isArray(report.failedIds)) {
    throw new Error('The saved M6 report does not match the current corpus, models, pricing, or budget.')
  }
  const validIds = new Set(corpus.map((item) => item.id))
  const expectedById = new Map(corpus.map((item) => [item.id, item]))
  const seen = new Set<string>()
  let recordedCost = 0
  for (const [index, rawResult] of report.results.entries()) {
    const parsedResult = m6CaseResultSchema.safeParse(rawResult)
    if (!parsedResult.success) throw new Error(`The saved M6 report contains an invalid result at index ${index}.`)
    const result = parsedResult.data
    if (!validIds.has(result.id)) throw new Error(`The saved M6 report contains unknown case ${result.id}.`)
    if (seen.has(result.id)) throw new Error(`The saved M6 report contains duplicate case ${result.id}.`)
    if (result.id !== corpus[index]?.id) throw new Error('The saved M6 report is not a contiguous corpus prefix.')
    if (result.fullPipeline !== expectedById.get(result.id)?.fullPipeline) {
      throw new Error(`The saved M6 report changed the pipeline designation for ${result.id}.`)
    }
    if (!Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0) {
      throw new Error(`The saved M6 report contains invalid cost for case ${result.id}.`)
    }
    validateM6CaseAccounting(result)
    recordedCost += result.estimatedCostUsd
    seen.add(result.id)
  }
  if (report.failedIds.some((id) => !seen.has(id)) || new Set(report.failedIds).size !== report.failedIds.length) {
    throw new Error('The saved M6 report contains invalid failed case IDs.')
  }
  const expectedFailedIds = report.results.filter((item) => !item.passed).map((item) => item.id)
  if (JSON.stringify(report.failedIds) !== JSON.stringify(expectedFailedIds)) {
    throw new Error('The saved M6 report failed IDs do not match its case flags.')
  }
  assertRedactedM6Report(report)
  if (Math.abs(recordedCost - report.budget.actualUsd) > 1e-9) {
    throw new Error('The saved M6 report lifetime spend does not match its case usage records.')
  }
  new M6BudgetLedger(report.budget.actualUsd)
  if (report.aggregateGate) {
    const expectedGate = evaluateM6AggregateGate(report)
    if (JSON.stringify(report.aggregateGate) !== JSON.stringify(expectedGate)) {
      throw new Error('The saved M6 aggregate gate does not match its case results.')
    }
  }
  return structuredClone(report)
}

export function appendM6Result(report: M6RedactedReport, result: M6CaseResult, now = new Date()): M6RedactedReport {
  if (report.results.some((item) => item.id === result.id)) throw new Error(`M6 case ${result.id} has already been attempted; automatic reruns are forbidden.`)
  const expectedId = `m6-${String(report.results.length + 1).padStart(2, '0')}`
  if (result.id !== expectedId || result.fullPipeline !== (report.results.length < M6_FULL_PIPELINE_SIZE)) {
    throw new Error(`M6 results must be appended once in corpus order; expected ${expectedId}.`)
  }
  const parsedResult = m6CaseResultSchema.safeParse(result)
  if (!parsedResult.success) throw new Error(`M6 case ${result.id} has an invalid result shape.`)
  validateM6CaseAccounting(parsedResult.data)
  const next = structuredClone(report)
  next.results.push(structuredClone(result))
  next.budget.actualUsd = next.results.reduce((total, item) => total + item.estimatedCostUsd, 0)
  next.failedIds = next.results.filter((item) => !item.passed).map((item) => item.id)
  delete next.aggregateGate
  next.updatedAt = now.toISOString()
  new M6BudgetLedger(next.budget.actualUsd)
  assertRedactedM6Report(next)
  return next
}

export function evaluateM6AggregateGate(report: M6RedactedReport): NonNullable<M6RedactedReport['aggregateGate']> {
  const transcriptionValidCount = report.results.filter((item) => item.flags.transcriptionValid).length
  const meaningCorrectCount = report.results.filter((item) => item.flags.meaningCorrect).length
  const fullPipeline = report.results.filter((item) => item.fullPipeline && item.flags.pipelineValid && item.flags.evidenceValid)
  const releaseToAnswer = fullPipeline.flatMap((item) => item.timingsMs.releaseToVisibleAnswer === undefined
    ? []
    : [item.timingsMs.releaseToVisibleAnswer]
  ).sort((left, right) => left - right)
  const releaseToAnswerP50Ms = nearestRankPercentile(releaseToAnswer, 0.5)
  const releaseToAnswerP95Ms = nearestRankPercentile(releaseToAnswer, 0.95)
  const flags = {
    transcription: report.results.length === M6_CORPUS_SIZE && transcriptionValidCount === M6_CORPUS_SIZE,
    meaning: meaningCorrectCount >= 18,
    pipeline: fullPipeline.length === M6_FULL_PIPELINE_SIZE,
    latency: releaseToAnswer.length === M6_FULL_PIPELINE_SIZE && releaseToAnswerP50Ms <= 5_000 && releaseToAnswerP95Ms <= 8_000,
    budget: report.budget.actualUsd <= report.budget.capUsd + Number.EPSILON
  }
  return {
    accepted: report.failedIds.length === 0 && Object.values(flags).every(Boolean),
    transcriptionValidCount, meaningCorrectCount, fullPipelineValidCount: fullPipeline.length,
    releaseToAnswerP50Ms, releaseToAnswerP95Ms, flags
  }
}

export function assertRedactedM6Report(report: unknown): void {
  const forbiddenKeys = [
    /^(?:(?:openai)?api)?key$/,
    /^(?:raw)?audio(?:path|file|bytes|content)?$/,
    /^(?:raw)?transcripts?(?:text|content)?$/,
    /^(?:raw)?prompts?(?:text|content)?$/,
    /^(?:(?:generated|raw)answers?(?:text|content)?|answers?(?:text|content))$/,
    /^(?:rawresponses?(?:text|body|content)?|responses?(?:text|body|content))$/,
    /^(?:raw)?evidencetext$/,
    /^(?:raw)?reasoningcontent$/
  ]
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string' && /(?:sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY)/i.test(value)) {
      throw new Error(`M6 report redaction failed at ${path}.`)
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return }
    if (!isPlainObject(value)) return
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US')
      if (forbiddenKeys.some((pattern) => pattern.test(normalizedKey))) throw new Error(`M6 report contains forbidden field ${path}.${key}.`)
      visit(child, `${path}.${key}`)
    }
  }
  visit(report, '$')
}

function evidenceChunk(text: string): RetrievedChunk {
  return {
    id: 'm6-reference:section:1:part:1', documentId: 'm6-reference', documentName: 'm6-reference.txt',
    text, title: 'M6 synthetic reference', section: 'M6 synthetic reference', kind: 'text',
    part: 1, partCount: 1, location: 'M6 synthetic reference', score: 0
  }
}

function validateM6CaseAccounting(result: M6CaseResult): void {
  const expectedCost = transcriptionTokenCostUsd(
    result.usage.transcriptionInputTokens,
    result.usage.transcriptionOutputTokens
  ) + actualAnswerCostUsd(result.usage.answerInputTokens, result.usage.answerOutputTokens) +
    result.usage.unreportedUsageReserveUsd
  if (Math.abs(expectedCost - result.estimatedCostUsd) > 1e-9) {
    throw new Error(`M6 case ${result.id} cost does not match its recorded token usage.`)
  }
  if (result.usage.transcriptionAudioTokens > result.usage.transcriptionInputTokens ||
      result.usage.answerReasoningTokens > result.usage.answerOutputTokens) {
    throw new Error(`M6 case ${result.id} contains inconsistent token details.`)
  }
  if (result.fullPipeline !== Boolean(result.versions.requestedAnswerModel)) {
    throw new Error(`M6 case ${result.id} has inconsistent pipeline model metadata.`)
  }
  if (!result.fullPipeline && (result.usage.answerInputTokens !== 0 || result.usage.answerOutputTokens !== 0 || result.usage.answerReasoningTokens !== 0 ||
      result.versions.returnedAnswerModel !== undefined || result.timingsMs.retrieval !== undefined || result.timingsMs.generation !== undefined ||
      result.timingsMs.releaseToVisibleAnswer !== undefined)) {
    throw new Error(`M6 case ${result.id} contains answer data for a transcription-only case.`)
  }
  const corePassed = result.flags.audioValid && result.flags.transcriptionValid && result.flags.wavDeleted &&
    result.flags.pipelineValid && result.flags.evidenceValid
  if (result.passed && (!corePassed || result.errorCode !== undefined)) {
    throw new Error(`M6 case ${result.id} has inconsistent pass flags.`)
  }
  if (result.passed && result.usage.unreportedUsageReserveUsd !== 0) {
    throw new Error(`M6 case ${result.id} cannot pass without complete provider usage metadata.`)
  }
  if (!result.passed && !result.errorCode) throw new Error(`M6 case ${result.id} is missing a failure code.`)
}

function normalizedWords(value: string): Set<string> {
  return new Set((value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 || /^\d$/u.test(word)))
}

function nearestRankPercentile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))] ?? 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
