import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assistantResponseSchema, type AssistantResponse } from '../src/shared/contracts.js'
import { maximumCallCostUsd, staysWithinBudget, tokenCostUsd } from '../src/main/ai/evalBudget.js'
import { validateGroundingResponse } from '../src/main/ai/grounding.js'
import {
  chunksForM7Case, evaluateM7AnswerSemantics, m7CorpusSchema, type M7EvalCase
} from '../src/main/ai/m7Eval.js'
import { buildInput, presenterInstructions, responseJsonSchema } from '../src/main/ai/prompts.js'
import { responseRequestPolicy } from '../src/main/ai/requestPolicy.js'

if (isCi()) throw new Error('The M7 live evaluator refuses to run in CI.')
const args = process.argv.slice(2)
const budgetOption = args.find((arg) => arg.startsWith('--budget-usd='))
if (!budgetOption || args.length !== 1) throw new Error('Run locally with exactly one explicit --budget-usd=N option.')
const budgetUsd = Number(budgetOption.slice('--budget-usd='.length))
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('--budget-usd must be a positive finite amount.')
const key = process.env.OPENAI_API_KEY?.trim()
if (!key) throw new Error('Set OPENAI_API_KEY only in this local evaluation process. It is never persisted or printed.')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpusText = await readFile(resolve(root, 'tests/fixtures/m7-offline-corpus.json'), 'utf8')
const corpus = m7CorpusSchema.parse(JSON.parse(corpusText) as unknown)
const policy = responseRequestPolicy('normal')
const model = 'gpt-5.6-luna'
const requestFingerprint = createHash('sha256').update(JSON.stringify({
  model, policy, store: false, schema: responseJsonSchema, instructions: presenterInstructions
})).digest('hex')
const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 30_000 })
const results: CaseMetric[] = []
let spentUsd = 0

for (const item of corpus.cases) {
  const chunks = chunksForM7Case(item)
  const context = item.priorQuestion
    ? `1. Reviewer: ${item.priorQuestion}\nPrior response summary (reference only; not evidence): A bounded synthetic summary.`
    : ''
  const input = buildInput(item.question, chunks, context, '')
  const serialized = JSON.stringify({ instructions: presenterInstructions, input, schema: responseJsonSchema, model, policy, store: false })
  const nextMaximumUsd = maximumCallCostUsd('normal', serialized)
  if (!staysWithinBudget(spentUsd, nextMaximumUsd, budgetUsd)) {
    throw new Error(`The next request could exceed the explicit $${budgetUsd.toFixed(6)} live-evaluation cap.`)
  }

  const startedAt = performance.now()
  let raw: unknown
  let returnedModel: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  try {
    const response = await client.responses.create({
      model,
      reasoning: { effort: policy.reasoningEffort },
      instructions: presenterInstructions,
      input,
      max_output_tokens: policy.maxOutputTokens,
      store: false,
      text: { format: { type: 'json_schema', name: 'presenter_response', strict: true, schema: responseJsonSchema } }
    })
    returnedModel = response.model
    inputTokens = response.usage?.input_tokens ?? 0
    outputTokens = response.usage?.output_tokens ?? 0
    reasoningTokens = response.usage?.output_tokens_details?.reasoning_tokens ?? 0
    spentUsd += tokenCostUsd('normal', inputTokens, outputTokens)
    if (response.status !== 'completed' || !response.output_text?.trim()) throw new Error('invalid_response')
    raw = JSON.parse(response.output_text) as unknown
  } catch (error) {
    results.push(metric(item, {
      valid: false, outcome: safeOutcome(error), returnedModel, inputTokens, outputTokens, reasoningTokens,
      latencyMs: Math.round(performance.now() - startedAt)
    }))
    break
  }

  const parsed = normalizeAndValidate(raw)
  const grounding = parsed ? validateGroundingResponse(parsed, item.question, chunks) : { valid: false as const }
  const visible = parsed ? [parsed.say, ...parsed.keyPoints, parsed.ifChallenged, parsed.warning ?? ''].join(' ') : ''
  const unsupportedNumericClaim = item.support === 'unsupported-project-claim' && /\b\d+(?:\.\d+)?%?\b/u.test(visible)
  const semantic = parsed ? evaluateM7AnswerSemantics(item, parsed) : undefined
  const expectedEvidence = new Set(item.evidenceIds)
  const availableEvidence = new Set(item.availableChunkIds)
  const citationsAllowlisted = Boolean(parsed && new Set(parsed.evidence.map((value) => value.chunkId)).size === parsed.evidence.length && parsed.evidence.every((value) => availableEvidence.has(value.chunkId)))
  const expectedSupport = Boolean(parsed && parsed.support === item.support && parsed.evidenceIssue === item.evidenceIssue)
  const expectedCitations = Boolean(parsed && parsed.evidence.length === expectedEvidence.size && parsed.evidence.every((value) => expectedEvidence.has(value.chunkId)))
  const followUpResolved = item.group !== 'followup' || Boolean(grounding.valid && semantic?.valid && expectedSupport && expectedCitations)
  const conflictExplicit = item.group !== 'contradictory' || Boolean(
    parsed?.warning && /\b(?:conflict|contradict|inconsisten)\w*/iu.test(parsed.warning) && semantic?.conflictNeutral
  )
  const valid = Boolean(parsed && grounding.valid && semantic?.valid && expectedSupport && expectedCitations && followUpResolved && conflictExplicit && !unsupportedNumericClaim)
  results.push(metric(item, {
    valid, outcome: valid ? 'success' : 'quality_failure', returnedModel, inputTokens, outputTokens, reasoningTokens,
    latencyMs: Math.round(performance.now() - startedAt), followUpResolved, warningPresent: Boolean(parsed?.warning),
    unsupportedNumericClaim, unsupportedSafe: semantic?.unsupportedSafe ?? false,
    requiredAnchorPresent: semantic?.requiredAnchorPresent ?? false,
    challengeStructure: semantic?.challengeStructure ?? false,
    categoryCorrect: semantic?.categoryCorrect ?? false,
    conflictExplicit, citationsAllowlisted
  }))
  if (!valid) break
}

const followups = results.filter((item) => item.group === 'followup')
const unsupported = results.filter((item) => item.expectedSupport === 'unsupported-project-claim' && item.group !== 'contradictory')
const contradictions = results.filter((item) => item.group === 'contradictory')
const gates = {
  completedAllCases: results.length === 50,
  followUpResolution: followups.filter((item) => item.followUpResolved).length >= 18,
  unsupportedWarnings: unsupported.filter((item) => item.warningPresent).length >= 19,
  noInventedProjectResults: unsupported.every((item) => item.unsupportedSafe && !item.unsupportedNumericClaim),
  citationsAllowlisted: results.length === 50 && results.every((item) => item.citationsAllowlisted),
  contradictionsExplicit: contradictions.filter((item) => item.conflictExplicit).length === 5,
  challengesStructured: results.filter((item) => item.group === 'challenge' && item.challengeStructure).length === 5,
  categoriesCorrect: results.length === 50 && results.every((item) => item.categoryCorrect)
}
const failedCaseIds = results.filter((item) => !item.valid).map((item) => item.id)
const report = {
  schemaVersion: 1,
  evaluationRevision: 'm7-live-v1',
  generatedAt: new Date().toISOString(),
  corpusVersion: corpus.version,
  corpusFingerprint: createHash('sha256').update(corpusText).digest('hex'),
  requestFingerprint,
  requestedModel: model,
  budget: { capUsd: budgetUsd, actualUsd: Number(spentUsd.toFixed(6)), sdkRetries: 0 },
  storesRawPromptsOrResponses: false,
  gates,
  failedCaseIds,
  passed: failedCaseIds.length === 0 && Object.values(gates).every(Boolean),
  results
}
const reportPath = resolve(root, 'artifacts/m7/m7-live-report.json')
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ reportPath, budget: report.budget, gates, failedCaseIds, passed: report.passed }, null, 2))
if (!report.passed) process.exitCode = 1

interface CaseMetric {
  id: string
  group: M7EvalCase['group']
  expectedSupport: M7EvalCase['support']
  valid: boolean
  outcome: string
  returnedModel?: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  followUpResolved: boolean
  warningPresent: boolean
  unsupportedNumericClaim: boolean
  unsupportedSafe: boolean
  requiredAnchorPresent: boolean
  challengeStructure: boolean
  categoryCorrect: boolean
  conflictExplicit: boolean
  citationsAllowlisted: boolean
}

function metric(item: M7EvalCase, value: Partial<CaseMetric> & Pick<CaseMetric, 'valid' | 'outcome' | 'latencyMs' | 'inputTokens' | 'outputTokens' | 'reasoningTokens'>): CaseMetric {
  return {
    id: item.id, group: item.group, expectedSupport: item.support,
    followUpResolved: false, warningPresent: false, unsupportedNumericClaim: false, unsupportedSafe: false,
    requiredAnchorPresent: false, challengeStructure: false, categoryCorrect: false, conflictExplicit: false,
    citationsAllowlisted: false,
    ...value
  }
}

function normalizeAndValidate(raw: unknown): AssistantResponse | undefined {
  if (raw && typeof raw === 'object' && 'warning' in raw && (raw as { warning?: unknown }).warning === null) {
    delete (raw as { warning?: unknown }).warning
  }
  const parsed = assistantResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

function safeOutcome(error: unknown): string {
  const value = error as { status?: number; code?: string; name?: string }
  if (value.status === 401) return 'invalid_key'
  if (value.status === 429 && value.code === 'insufficient_quota') return 'quota'
  if (value.status === 429) return 'rate_limit'
  if (value.name === 'APIConnectionTimeoutError') return 'timeout'
  if (value.name === 'APIConnectionError') return 'offline'
  return 'invalid_response'
}

function isCi(): boolean {
  const value = process.env.CI?.trim().toLocaleLowerCase()
  return Boolean(value && value !== '0' && value !== 'false')
}
