import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSettings, AssistantResponse, DocumentInfo, QuestionCategory } from '../src/shared/contracts.js'
import { AiService, type AiRequestMetric, type AiSettingsProvider, type OpenAIClientLike, type OpenAIResponseLike } from '../src/main/ai/service.js'
import { buildInput, presenterInstructions, responseJsonSchema } from '../src/main/ai/prompts.js'
import {
  conservativeInputTokens, maximumCallCostUsd, M3_EVAL_BUDGET_USD, M3_EVAL_OUTPUT_TOKEN_CAPS,
  M3_EVAL_PRICES, M3_TERRA_REPAIR_BUDGET_USD, staysWithinBudget, tokenCostUsd, type EvalModelMode
} from '../src/main/ai/evalBudget.js'
import {
  addMissingPromptLineage, appendRepairHistory, caseKey, pacingDelayMs, readResumeReport, safeProviderMetadata,
  restoreUnattemptedReruns, selectFailedRerun, validateExplicitRepairSelection, type SafeProviderMetadata
} from '../src/main/ai/evalRuntime.js'
import { responseRequestPolicy } from '../src/main/ai/requestPolicy.js'

const EVALUATION_REVISION = 'm3-terra-output-budget-v1'
const PROMPT_REVISION = 'm3-final-v3'
const BASELINE_PROMPT_REVISION = 'm3-baseline-v1'
const REQUEST_REVISION = 'm3-mode-specific-output-v1'
const APPROVED_FINAL_REPAIR_KEYS = ['strong:g01', 'strong:g03', 'strong:c01', 'strong:c03', 'strong:x01'] as const

interface EvalCase {
  id: string
  group: 'general' | 'unsupported' | 'challenge' | 'clarification'
  question: string
  expectedCategories: QuestionCategory[]
  mustWarn: boolean
  strongSmoke?: boolean
}
interface CaseResult {
  id: string
  mode: EvalModelMode
  requestedModel: string
  returnedModel?: string
  valid: boolean
  outcome: string
  category?: QuestionCategory
  categoryAccepted: boolean
  warningPresent: boolean
  wordCount: number
  unsupportedNumericClaim: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  providerMetadata?: SafeProviderMetadata
  promptRevision?: string
  promptFingerprint?: string
  requestRevision?: string
  requestFingerprint?: string
}

const args = process.argv.slice(2)
const rerunFailed = args.includes('--rerun-failed')
const preflightOnly = args.includes('--preflight')
const countOption = args.find((arg) => arg.startsWith('--expected-count='))
const expectedCount = countOption ? Number(countOption.slice('--expected-count='.length)) : undefined
const knownOptions = new Set(['--rerun-failed', '--preflight', countOption].filter((item): item is string => Boolean(item)))
const unknownOption = args.find((arg) => !knownOptions.has(arg))
if (unknownOption) throw new Error(`Unknown evaluator option: ${unknownOption}`)
if (rerunFailed && expectedCount === undefined) throw new Error('--rerun-failed requires --expected-count=N.')
if (!rerunFailed && expectedCount !== undefined) throw new Error('--expected-count requires --rerun-failed.')
if (preflightOnly && !rerunFailed) throw new Error('--preflight requires --rerun-failed.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = resolve(root, 'artifacts/m3/m3-live-report.json')
const corpusText = await readFile(resolve(root, 'tests/fixtures/m3-eval-corpus.json'), 'utf8')
const corpus = JSON.parse(corpusText) as EvalCase[]
if (corpus.length !== 40) throw new Error(`Expected 40 M3 cases, found ${corpus.length}.`)
const strongCases = corpus.filter((item) => item.strongSmoke)
if (strongCases.length !== 8) throw new Error(`Expected 8 Terra smoke cases, found ${strongCases.length}.`)
const corpusFingerprint = createHash('sha256').update(corpusText).digest('hex')
const promptFingerprint = createHash('sha256').update(presenterInstructions).update(JSON.stringify(responseJsonSchema)).digest('hex')

const baseSettings: AppSettings = {
  neonIntensity: 0.65, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
  transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space', projectSummary: '', approvedVocabulary: [], sessionBudgetUsd: 0.25
}
const requestConfiguration = {
  normal: { model: baseSettings.normalModel, ...responseRequestPolicy('normal') },
  strong: { model: baseSettings.strongModel, ...responseRequestPolicy('strong') },
  store: false,
  schema: responseJsonSchema
}
const requestFingerprint = createHash('sha256').update(JSON.stringify(requestConfiguration)).digest('hex')
const validCaseKeys = new Set([
  ...corpus.map((item) => caseKey('normal', item.id)),
  ...strongCases.map((item) => caseKey('strong', item.id))
])
const existingReport = await readJsonIfPresent(reportPath)
const resume = readResumeReport(existingReport, {
  corpusFingerprint, corpusSize: corpus.length, strongSmokeSize: strongCases.length,
  normalModel: baseSettings.normalModel, strongModel: baseSettings.strongModel, validCaseKeys
})
let results = resume.results as unknown as CaseResult[]
let actualSpentUsd = resume.actualSpentUsd
const repairStartingSpendUsd = actualSpentUsd
const lifetimeUsage = readLifetimeUsage(existingReport)
let rerunCaseKeys: string[] = []
let rerunPriorResults: CaseResult[] = []
let preservedCaseKeys = results.map((item) => caseKey(item.mode, item.id))
if (rerunFailed) {
  if (!existingReport) throw new Error('--rerun-failed requires an existing redacted report.')
  const selection = selectFailedRerun(results as unknown as Array<Record<string, unknown>>, (existingReport as { failedCaseIds?: unknown }).failedCaseIds, validCaseKeys)
  validateExplicitRepairSelection(selection.rerunCaseKeys, expectedCount!, APPROVED_FINAL_REPAIR_KEYS)
  rerunCaseKeys = selection.rerunCaseKeys
  const rerunSet = new Set(rerunCaseKeys)
  rerunPriorResults = results.filter((item) => rerunSet.has(caseKey(item.mode, item.id)))
  results = selection.preservedResults as unknown as CaseResult[]
  preservedCaseKeys = results.map((item) => caseKey(item.mode, item.id))
}
results = addMissingPromptLineage(
  results as unknown as Array<Record<string, unknown>>, BASELINE_PROMPT_REVISION, 'legacy-unavailable'
) as unknown as CaseResult[]
results = results.map((item) => ({ ...item, reasoningTokens: Number(item.reasoningTokens) || 0 }))
rerunPriorResults = rerunPriorResults.map((item) => ({ ...item, reasoningTokens: Number(item.reasoningTokens) || 0 }))
let environmentFailure: { code: string; mode: EvalModelMode; caseId: string; providerMetadata?: SafeProviderMetadata } | undefined
let budgetFailure: { mode: EvalModelMode; caseId: string; spentUsd: number; nextMaximumUsd: number } | undefined
let terraSkippedReason: 'luna_gate_failed' | 'environment_failure' | 'budget_failure' | undefined
let latestProviderMetadata: SafeProviderMetadata | undefined
let madeRequestThisRun = false
const previousGeneratedAt = typeof (existingReport as { generatedAt?: unknown } | undefined)?.generatedAt === 'string'
  ? Date.parse((existingReport as { generatedAt: string }).generatedAt) : undefined

function serializedRequestText(mode: EvalModelMode, item: EvalCase): string {
  const policy = responseRequestPolicy(mode)
  return JSON.stringify({
    instructions: presenterInstructions, input: buildInput(item.question, [], '', ''),
    schema: responseJsonSchema, model: mode === 'normal' ? baseSettings.normalModel : baseSettings.strongModel,
    reasoningEffort: policy.reasoningEffort, verbosity: policy.verbosity, maxOutputTokens: policy.maxOutputTokens,
    store: false
  })
}
function modeMaximum(mode: EvalModelMode, cases: EvalCase[]): number {
  return cases.reduce((sum, item) => sum + maximumCallCostUsd(mode, serializedRequestText(mode, item)), 0)
}
const plannedMaximumUsd = modeMaximum('normal', corpus) + modeMaximum('strong', strongCases)
const completed = new Set(results.map((item) => caseKey(item.mode, item.id)))
const remainingMaximumUsd =
  modeMaximum('normal', corpus.filter((item) => !completed.has(caseKey('normal', item.id)))) +
  modeMaximum('strong', strongCases.filter((item) => !completed.has(caseKey('strong', item.id))))
if (!staysWithinBudget(actualSpentUsd, remainingMaximumUsd)) {
  throw new Error(`The conservative lifetime maximum $${(actualSpentUsd + remainingMaximumUsd).toFixed(6)} exceeds the immutable $${M3_EVAL_BUDGET_USD.toFixed(2)} cap.`)
}
const rerunSet = new Set(rerunCaseKeys)
const repairProjectedMaximumUsd = modeMaximum('strong', strongCases.filter((item) => rerunSet.has(caseKey('strong', item.id))))
if (rerunFailed && repairProjectedMaximumUsd > M3_TERRA_REPAIR_BUDGET_USD + Number.EPSILON) {
  throw new Error(`The Terra repair maximum $${repairProjectedMaximumUsd.toFixed(6)} exceeds its $${M3_TERRA_REPAIR_BUDGET_USD.toFixed(3)} sub-budget.`)
}
if (preflightOnly) {
  console.log(JSON.stringify({
    preflight: 'pass', rerunCaseKeys, preservedCaseCount: results.length,
    priorLifetimeSpendUsd: Number(actualSpentUsd.toFixed(6)),
    repairCapUsd: M3_TERRA_REPAIR_BUDGET_USD,
    repairProjectedMaximumUsd: Number(repairProjectedMaximumUsd.toFixed(6)),
    projectedLifetimeMaximumUsd: Number((actualSpentUsd + repairProjectedMaximumUsd).toFixed(6)),
    requestRevision: REQUEST_REVISION, requestFingerprint
  }, null, 2))
  process.exit(0)
}

const key = process.env.OPENAI_API_KEY?.trim()
if (!key) throw new Error('Set OPENAI_API_KEY for this local opt-in evaluation. The key is never persisted or printed.')
const sdk = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 30_000 })
const client: OpenAIClientLike = {
  models: sdk.models as unknown as OpenAIClientLike['models'],
  audio: sdk.audio as unknown as OpenAIClientLike['audio'],
  responses: {
    create: async (body, options) => {
      try {
        const wrapped = await sdk.responses.create(body as never, options as never).withResponse()
        latestProviderMetadata = safeProviderMetadata({ request_id: wrapped.request_id }, wrapped.response)
        return wrapped.data as unknown as OpenAIResponseLike
      } catch (error) {
        latestProviderMetadata = safeProviderMetadata(error)
        throw error
      }
    }
  }
}

async function evaluate(mode: EvalModelMode, cases: EvalCase[]): Promise<boolean> {
  for (const item of cases) {
    if (completed.has(caseKey(mode, item.id))) continue
    const requestText = serializedRequestText(mode, item)
    const nextMaximumUsd = maximumCallCostUsd(mode, requestText)
    if (!staysWithinBudget(actualSpentUsd, nextMaximumUsd)) {
      budgetFailure = { mode, caseId: item.id, spentUsd: actualSpentUsd, nextMaximumUsd }; return false
    }
    if (rerunSet.has(caseKey(mode, item.id)) && !staysWithinBudget(actualSpentUsd - repairStartingSpendUsd, nextMaximumUsd, M3_TERRA_REPAIR_BUDGET_USD)) {
      budgetFailure = { mode, caseId: item.id, spentUsd: actualSpentUsd, nextMaximumUsd }; return false
    }
    await paceBeforeRequest(conservativeInputTokens(requestText), mode)
    latestProviderMetadata = undefined
    let metric: AiRequestMetric | undefined
    const provider: AiSettingsProvider = {
      settings: { ...baseSettings, modelMode: mode }, documents: [] as DocumentInfo[], addUsage: async () => undefined
    }
    const service = new AiService({ getKey: async () => key }, provider, { search: () => [] }, {
      clientFactory: async () => client, onMetric: (value) => { metric = value }
    })
    let answer: AssistantResponse | undefined; let outcome = 'unknown'
    try { answer = await service.ask(item.question); outcome = 'success' }
    catch (error) { outcome = (error as { code?: string }).code ?? 'unknown' }
    madeRequestThisRun = true
    const visible = answer ? [answer.say, ...answer.keyPoints, answer.ifChallenged, answer.warning ?? ''].join(' ') : ''
    const wordCount = visible.trim() ? visible.trim().split(/\s+/u).length : 0
    const result: CaseResult = {
      id: item.id, mode, requestedModel: metric?.requestedModel ?? (mode === 'normal' ? baseSettings.normalModel : baseSettings.strongModel),
      returnedModel: metric?.returnedModel, valid: Boolean(answer), outcome, category: answer?.category,
      categoryAccepted: Boolean(answer && item.expectedCategories.includes(answer.category)), warningPresent: Boolean(answer?.warning?.trim()), wordCount,
      unsupportedNumericClaim: item.mustWarn && /\b\d+(?:\.\d+)?%?\b/u.test(visible), latencyMs: Math.round(metric?.latencyMs ?? 0),
      inputTokens: metric?.inputTokens ?? 0, outputTokens: metric?.outputTokens ?? 0,
      reasoningTokens: metric?.reasoningTokens ?? 0,
      providerMetadata: Object.keys(latestProviderMetadata ?? {}).length ? latestProviderMetadata : undefined,
      promptRevision: PROMPT_REVISION, promptFingerprint, requestRevision: REQUEST_REVISION, requestFingerprint
    }
    results.push(result); completed.add(caseKey(mode, item.id))
    actualSpentUsd += tokenCostUsd(mode, result.inputTokens, result.outputTokens)
    lifetimeUsage.inputTokens += result.inputTokens; lifetimeUsage.outputTokens += result.outputTokens
    lifetimeUsage.reasoningTokens += result.reasoningTokens
    process.stdout.write(`${mode} ${item.id}: ${outcome}\n`)
    if (['invalid_key', 'quota', 'rate_limit', 'timeout', 'offline'].includes(outcome)) {
      environmentFailure = { code: outcome, mode, caseId: item.id, providerMetadata: result.providerMetadata }
      return false
    }
    // A quality/schema failure is terminal for this execution. It must be reviewed
    // before any further paid case is attempted.
    if (outcome !== 'success' || !result.valid || result.unsupportedNumericClaim) return false
  }
  return true
}

async function paceBeforeRequest(nextInputTokens: number, mode: EvalModelMode): Promise<void> {
  let delay = 0
  if (madeRequestThisRun) delay = pacingDelayMs(latestProviderMetadata, nextInputTokens, mode)
  else if (results.length && previousGeneratedAt && Number.isFinite(previousGeneratedAt)) {
    delay = Math.max(0, 60_000 - (Date.now() - previousGeneratedAt))
  }
  if (delay > 0) {
    process.stdout.write(`pacing: waiting ${Math.ceil(delay / 1_000)}s before the next request\n`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
  }
}

const lunaCompleted = await evaluate('normal', corpus)
const luna = results.filter((item) => item.mode === 'normal')
const unsupported = luna.filter((item) => item.id.startsWith('u'))
const lunaGates = {
  lunaStructured: luna.filter((item) => item.valid).length === 40,
  lunaCategory: luna.filter((item) => item.categoryAccepted).length >= 36,
  lunaUnsupportedWarnings: unsupported.filter((item) => item.warningPresent).length >= 19,
  noUnsupportedNumbers: luna.every((item) => !item.unsupportedNumericClaim),
  lunaWordTarget: luna.filter((item) => item.wordCount >= 120 && item.wordCount <= 220).length >= 36
}
const lunaPassed = lunaCompleted && !environmentFailure && !budgetFailure && Object.values(lunaGates).every(Boolean)
if (lunaPassed) await evaluate('strong', strongCases)
else terraSkippedReason = environmentFailure ? 'environment_failure' : budgetFailure ? 'budget_failure' : 'luna_gate_failed'

// If fail-fast stopped this repair, retain the previous redacted records for
// selected cases that were never attempted. This keeps every unresolved ID
// visible without paying to rerun it.
results = restoreUnattemptedReruns(
  results as unknown as Array<Record<string, unknown>>,
  rerunPriorResults as unknown as Array<Record<string, unknown>>,
  completed
) as unknown as CaseResult[]

const terra = results.filter((item) => item.mode === 'strong')
const gates = {
  ...lunaGates,
  noUnsupportedNumbers: lunaGates.noUnsupportedNumbers && terra.every((item) => !item.unsupportedNumericClaim),
  terraStructured: terra.filter((item) => item.valid).length === 8
}
const failedCaseIds = results.filter((item) =>
  !item.valid || item.unsupportedNumericClaim ||
  (item.mode === 'normal' && !item.categoryAccepted) ||
  (item.mode === 'normal' && (item.wordCount < 120 || item.wordCount > 220)) ||
  (item.mode === 'normal' && item.id.startsWith('u') && !item.warningPresent)
).map((item) => caseKey(item.mode, item.id))
const passedAutomatedGate = !environmentFailure && !budgetFailure && Object.values(gates).every(Boolean)
const repairHistory = appendRepairHistory(existingReport, {
  explicitRerunFailed: rerunFailed, sourceSchemaVersion: resume.sourceSchemaVersion,
  promptRevision: PROMPT_REVISION, promptFingerprint, requestRevision: REQUEST_REVISION, requestFingerprint,
  rerunCaseKeys, preservedCaseKeys
})
const report = {
  schemaVersion: 5, evaluationRevision: EVALUATION_REVISION, corpusFingerprint, promptRevision: PROMPT_REVISION, promptFingerprint,
  requestRevision: REQUEST_REVISION, requestFingerprint,
  generatedAt: new Date().toISOString(), corpusSize: corpus.length, strongSmokeSize: strongCases.length,
  storesRawPromptsOrResponses: false, humanReview: failedCaseIds.length ? 'pending' : 'not_applicable',
  resumed: Boolean(existingReport), migratedLegacyReport: resume.migratedLegacyReport,
  repairHistory,
  environmentFailure, budgetFailure, terraSkippedReason, failedCaseIds,
  budget: {
    capUsd: M3_EVAL_BUDGET_USD, plannedMaximumUsd: Number(plannedMaximumUsd.toFixed(6)),
    actualUsd: Number(actualSpentUsd.toFixed(6)), minimumPersonalReserveUsd: 4.6, sdkRetries: 0,
    repairCapUsd: M3_TERRA_REPAIR_BUDGET_USD,
    repairProjectedMaximumUsd: Number(repairProjectedMaximumUsd.toFixed(6)),
    repairActualUsd: Number((actualSpentUsd - repairStartingSpendUsd).toFixed(6))
  },
  lifetimeUsage,
  approximatePriceMetadata: { unit: 'USD per million tokens', luna: M3_EVAL_PRICES.normal, terra: M3_EVAL_PRICES.strong },
  summary: { luna: summarize(luna), terra: summarize(terra), approximateUsd: Number(actualSpentUsd.toFixed(6)) },
  gates, passedAutomatedGate, results
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ reportPath, summary: report.summary, gates, failedCaseIds, environmentFailure, passedAutomatedGate }, null, 2))
if (!passedAutomatedGate) process.exitCode = 1

function summarize(items: CaseResult[]) {
  const latencies = items.map((item) => item.latencyMs).sort((a, b) => a - b)
  return {
    cases: items.length, valid: items.filter((item) => item.valid).length,
    acceptedCategories: items.filter((item) => item.categoryAccepted).length,
    warnings: items.filter((item) => item.warningPresent).length,
    withinWordTarget: items.filter((item) => item.wordCount >= 120 && item.wordCount <= 220).length,
    inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
    reasoningTokens: items.reduce((sum, item) => sum + item.reasoningTokens, 0),
    p50LatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95)
  }
}
function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)] ?? 0
}
async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function readLifetimeUsage(report: unknown): { inputTokens: number; outputTokens: number; reasoningTokens: number } {
  const value = report as { lifetimeUsage?: { inputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown }; summary?: { luna?: { inputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown }; terra?: { inputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown } } } | undefined
  if (value?.lifetimeUsage) return {
    inputTokens: Number(value.lifetimeUsage.inputTokens) || 0,
    outputTokens: Number(value.lifetimeUsage.outputTokens) || 0,
    reasoningTokens: Number(value.lifetimeUsage.reasoningTokens) || 0
  }
  return {
    inputTokens: (Number(value?.summary?.luna?.inputTokens) || 0) + (Number(value?.summary?.terra?.inputTokens) || 0),
    outputTokens: (Number(value?.summary?.luna?.outputTokens) || 0) + (Number(value?.summary?.terra?.outputTokens) || 0),
    reasoningTokens: (Number(value?.summary?.luna?.reasoningTokens) || 0) + (Number(value?.summary?.terra?.reasoningTokens) || 0)
  }
}
