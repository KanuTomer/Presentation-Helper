import { M3_EVAL_BUDGET_USD, M3_EVAL_OUTPUT_TOKEN_CAPS, M3_EVAL_PRICES, type EvalModelMode } from './evalBudget.js'

export const M3_MIN_REQUEST_INTERVAL_MS = 1_100
export const M3_UNKNOWN_RESET_DELAY_MS = 60_000

export interface SafeProviderMetadata {
  requestId?: string
  providerCode?: string
  providerType?: string
  limitRequests?: string
  limitTokens?: string
  remainingRequests?: string
  remainingTokens?: string
  resetRequests?: string
  resetTokens?: string
}

interface HeaderLike { get(name: string): string | null }

export function safeProviderMetadata(value: unknown, response?: Response): SafeProviderMetadata {
  const error = value as { code?: unknown; type?: unknown; request_id?: unknown; headers?: unknown }
  const headers = response?.headers ?? error?.headers
  return compact({
    requestId: text(error?.request_id) ?? readHeader(headers, 'x-request-id'),
    providerCode: text(error?.code),
    providerType: text(error?.type),
    limitRequests: readHeader(headers, 'x-ratelimit-limit-requests'),
    limitTokens: readHeader(headers, 'x-ratelimit-limit-tokens'),
    remainingRequests: readHeader(headers, 'x-ratelimit-remaining-requests'),
    remainingTokens: readHeader(headers, 'x-ratelimit-remaining-tokens'),
    resetRequests: readHeader(headers, 'x-ratelimit-reset-requests'),
    resetTokens: readHeader(headers, 'x-ratelimit-reset-tokens')
  })
}

export function parseResetDurationMs(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const source = value.trim().toLowerCase()
  if (/^\d+(?:\.\d+)?$/u.test(source)) return Math.ceil(Number(source) * 1_000)
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
  let total = 0; let matched = ''; const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gu
  for (const item of source.matchAll(pattern)) { total += Number(item[1]) * units[item[2]!]!; matched += item[0] }
  return matched === source && Number.isFinite(total) ? Math.ceil(total) : undefined
}

export function pacingDelayMs(metadata: SafeProviderMetadata | undefined, nextInputTokens: number, mode: EvalModelMode): number {
  if (!metadata) return M3_UNKNOWN_RESET_DELAY_MS
  const requiredTokens = nextInputTokens + M3_EVAL_OUTPUT_TOKEN_CAPS[mode]
  const remainingRequests = finiteNumber(metadata.remainingRequests)
  const remainingTokens = finiteNumber(metadata.remainingTokens)
  const requestReset = parseResetDurationMs(metadata.resetRequests)
  const tokenReset = parseResetDurationMs(metadata.resetTokens)
  const waits: number[] = [M3_MIN_REQUEST_INTERVAL_MS]
  if (remainingRequests !== undefined && remainingRequests < 1) waits.push(requestReset ?? M3_UNKNOWN_RESET_DELAY_MS)
  if (remainingTokens !== undefined && remainingTokens < requiredTokens) waits.push(tokenReset ?? M3_UNKNOWN_RESET_DELAY_MS)
  if (remainingRequests === undefined && remainingTokens === undefined) {
    waits.push(Math.max(requestReset ?? 0, tokenReset ?? 0) || M3_UNKNOWN_RESET_DELAY_MS)
  }
  return Math.max(...waits)
}

export interface ResumeExpectation {
  corpusFingerprint: string
  corpusSize: number
  strongSmokeSize: number
  normalModel: string
  strongModel: string
  promptRevision: string
  promptFingerprint: string
  validCaseKeys: Set<string>
}

export interface ResumedEvaluation {
  results: Array<Record<string, unknown>>
  actualSpentUsd: number
  migratedLegacyReport: boolean
  sourceSchemaVersion?: number
}

export function readResumeReport(raw: unknown, expected: ResumeExpectation): ResumedEvaluation {
  if (!raw) return { results: [], actualSpentUsd: 0, migratedLegacyReport: false }
  const report = raw as Record<string, unknown>
  const schemaVersion = report.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== 5) throw new Error('Resume report schema is unsupported.')
  if (report.corpusSize !== expected.corpusSize || report.strongSmokeSize !== expected.strongSmokeSize) throw new Error('Resume report corpus size does not match.')
  if (schemaVersion !== 1 && report.corpusFingerprint !== expected.corpusFingerprint) throw new Error('Resume report corpus fingerprint does not match.')
  if (report.promptRevision !== expected.promptRevision || report.promptFingerprint !== expected.promptFingerprint) {
    throw new Error('Resume report prompt revision or fingerprint does not match.')
  }
  const budget = report.budget as Record<string, unknown> | undefined
  if (budget?.capUsd !== M3_EVAL_BUDGET_USD) throw new Error('Resume report budget cap does not match.')
  const pricing = report.approximatePriceMetadata as { luna?: unknown; terra?: unknown } | undefined
  if (JSON.stringify(pricing?.luna) !== JSON.stringify(M3_EVAL_PRICES.normal) || JSON.stringify(pricing?.terra) !== JSON.stringify(M3_EVAL_PRICES.strong)) {
    throw new Error('Resume report pricing metadata does not match.')
  }
  const stored = report.results
  if (!Array.isArray(stored)) throw new Error('Resume report results are invalid.')
  const seen = new Set<string>(); const results: Array<Record<string, unknown>> = []
  for (const item of stored) {
    if (!item || typeof item !== 'object') throw new Error('Resume report contains an invalid result.')
    const result = item as Record<string, unknown>; const key = `${result.mode}:${result.id}`
    if (!expected.validCaseKeys.has(key)) throw new Error(`Resume report contains an unknown case: ${key}.`)
    if (seen.has(key)) throw new Error(`Resume report contains a duplicate case: ${key}.`)
    seen.add(key)
    const expectedModel = result.mode === 'normal' ? expected.normalModel : expected.strongModel
    if (result.requestedModel !== expectedModel) throw new Error(`Resume report model does not match for ${key}.`)
    if (!isInfrastructureOutcome(result.outcome)) results.push(result)
  }
  const actualSpentUsd = finiteNumber(budget?.actualUsd)
  if (actualSpentUsd === undefined || actualSpentUsd < 0 || actualSpentUsd > M3_EVAL_BUDGET_USD) throw new Error('Resume report lifetime spend is invalid.')
  return { results, actualSpentUsd, migratedLegacyReport: schemaVersion === 1, sourceSchemaVersion: schemaVersion }
}

export function caseKey(mode: EvalModelMode, id: string): string { return `${mode}:${id}` }

export function addMissingPromptLineage(
  results: Array<Record<string, unknown>>,
  revision: string,
  fingerprint: string
): Array<Record<string, unknown>> {
  return results.map((item) => ({
    ...item,
    promptRevision: typeof item.promptRevision === 'string' ? item.promptRevision : revision,
    promptFingerprint: typeof item.promptFingerprint === 'string' ? item.promptFingerprint : fingerprint
  }))
}

export interface FailedRerunSelection {
  rerunCaseKeys: string[]
  preservedResults: Array<Record<string, unknown>>
}

export function selectFailedRerun(
  results: Array<Record<string, unknown>>,
  failedCaseKeys: unknown,
  validCaseKeys: Set<string>
): FailedRerunSelection {
  if (!Array.isArray(failedCaseKeys) || failedCaseKeys.length === 0) throw new Error('The report has no failed cases to rerun.')
  const rerunCaseKeys = failedCaseKeys.map(String)
  if (new Set(rerunCaseKeys).size !== rerunCaseKeys.length) throw new Error('The report contains duplicate failed case IDs.')
  for (const key of rerunCaseKeys) if (!validCaseKeys.has(key)) throw new Error(`The report contains an unknown failed case: ${key}.`)
  const existingKeys = new Set(results.map((item) => `${item.mode}:${item.id}`))
  for (const key of rerunCaseKeys) if (!existingKeys.has(key)) throw new Error(`The failed case has no prior result: ${key}.`)
  const selected = new Set(rerunCaseKeys)
  return { rerunCaseKeys, preservedResults: results.filter((item) => !selected.has(`${item.mode}:${item.id}`)) }
}

export function validateExplicitRepairSelection(
  caseKeys: string[],
  expectedCount: number,
  approvedCaseKeys: readonly string[]
): void {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('The expected repair count must be a positive integer.')
  if (caseKeys.length !== expectedCount) throw new Error(`The report selected ${caseKeys.length} cases; expected exactly ${expectedCount}.`)
  if (new Set(caseKeys).size !== caseKeys.length) throw new Error('The repair selection contains duplicate case IDs.')
  const actual = [...caseKeys].sort()
  const approved = [...approvedCaseKeys].sort()
  if (actual.length !== approved.length || actual.some((key, index) => key !== approved[index])) {
    throw new Error(`The report selection does not match the reviewed repair IDs: ${approved.join(', ')}.`)
  }
}

export interface RepairHistoryEntry {
  explicitRerunFailed: boolean
  sourceSchemaVersion?: number
  promptRevision?: string
  promptFingerprint?: string
  requestRevision?: string
  requestFingerprint?: string
  rerunCaseKeys: string[]
  preservedCaseKeys: string[]
}

export function appendRepairHistory(rawReport: unknown, entry: RepairHistoryEntry): RepairHistoryEntry[] {
  const report = rawReport as { repairHistory?: unknown; repairLineage?: unknown } | undefined
  const history: RepairHistoryEntry[] = []
  if (Array.isArray(report?.repairHistory)) {
    for (const item of report.repairHistory) {
      if (!item || typeof item !== 'object') throw new Error('The report repair history is invalid.')
      history.push(item as RepairHistoryEntry)
    }
  } else if (report?.repairLineage && typeof report.repairLineage === 'object') {
    history.push(report.repairLineage as RepairHistoryEntry)
  }
  return [...history, entry]
}

export function restoreUnattemptedReruns(
  results: Array<Record<string, unknown>>,
  priorRerunResults: Array<Record<string, unknown>>,
  completedCaseKeys: Set<string>
): Array<Record<string, unknown>> {
  const existing = new Set(results.map((item) => `${item.mode}:${item.id}`))
  const restored = priorRerunResults.filter((item) => {
    const key = `${item.mode}:${item.id}`
    return !completedCaseKeys.has(key) && !existing.has(key)
  })
  return [...results, ...restored]
}

function isInfrastructureOutcome(value: unknown): boolean {
  return ['invalid_key', 'quota', 'rate_limit', 'timeout', 'offline'].includes(String(value))
}
function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as HeaderLike).get === 'function') return (headers as HeaderLike).get(name) ?? undefined
  const record = headers as Record<string, unknown>
  return text(record[name]) ?? text(record[name.toLowerCase()])
}
function compact<T extends Record<string, string | undefined>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}
