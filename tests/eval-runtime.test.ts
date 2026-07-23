import { describe, expect, it } from 'vitest'
import {
  addMissingPromptLineage, appendRepairHistory, M3_MIN_REQUEST_INTERVAL_MS, M3_UNKNOWN_RESET_DELAY_MS, pacingDelayMs,
  parseResetDurationMs, readResumeReport, restoreUnattemptedReruns, safeProviderMetadata, selectFailedRerun,
  validateExplicitRepairSelection,
  type ResumeExpectation
} from '../src/main/ai/evalRuntime'

const expected: ResumeExpectation = {
  corpusFingerprint: 'fixture-hash', corpusSize: 40, strongSmokeSize: 8,
  normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
  promptRevision: 'presenter-natural-delivery-v1', promptFingerprint: 'prompt-hash',
  validCaseKeys: new Set(['normal:g01', 'normal:g02', 'strong:g01'])
}
const report = {
  schemaVersion: 2, corpusFingerprint: 'fixture-hash', corpusSize: 40, strongSmokeSize: 8,
  promptRevision: 'presenter-natural-delivery-v1', promptFingerprint: 'prompt-hash',
  budget: { capUsd: 0.4, actualUsd: 0.001654 },
  approximatePriceMetadata: { luna: { input: 1, output: 6 }, terra: { input: 2.5, output: 15 } },
  results: [
    { id: 'g01', mode: 'normal', requestedModel: 'gpt-5.6-luna', outcome: 'success', valid: true },
    { id: 'g02', mode: 'normal', requestedModel: 'gpt-5.6-luna', outcome: 'quota', valid: false }
  ]
}

describe('M3 evaluator runtime', () => {
  it('extracts only allowlisted provider metadata', () => {
    const metadata = safeProviderMetadata({ code: 'rate_limit_exceeded', type: 'requests', request_id: 'req-safe', message: 'secret details', headers: new Headers({
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m2.5s'
    }) })
    expect(metadata).toEqual({ providerCode: 'rate_limit_exceeded', providerType: 'requests', requestId: 'req-safe', remainingRequests: '0', resetRequests: '1m2.5s' })
    expect(JSON.stringify(metadata)).not.toContain('secret details')
  })

  it('parses reset durations and chooses a conservative paced delay', () => {
    expect(parseResetDurationMs('1m2.5s')).toBe(62_500)
    expect(parseResetDurationMs('250ms')).toBe(250)
    expect(parseResetDurationMs('nonsense')).toBeUndefined()
    expect(pacingDelayMs({ remainingRequests: '8', remainingTokens: '5000', resetRequests: '12s' }, 500, 'normal')).toBe(M3_MIN_REQUEST_INTERVAL_MS)
    expect(pacingDelayMs({ remainingRequests: '0', resetRequests: '2s', remainingTokens: '5000' }, 500, 'strong')).toBe(2_000)
    expect(pacingDelayMs({ remainingRequests: '8', remainingTokens: '1600', resetTokens: '3s' }, 500, 'normal')).toBe(M3_MIN_REQUEST_INTERVAL_MS)
    expect(pacingDelayMs({ remainingRequests: '8', remainingTokens: '1600', resetTokens: '3s' }, 500, 'strong')).toBe(3_000)
    expect(pacingDelayMs(undefined, 500, 'strong')).toBe(M3_UNKNOWN_RESET_DELAY_MS)
  })

  it('resumes successful cases, removes infrastructure failures, and keeps lifetime spend', () => {
    expect(readResumeReport(report, expected)).toMatchObject({
      results: [{ id: 'g01', mode: 'normal' }], actualSpentUsd: 0.001654, migratedLegacyReport: false
    })
  })

  it('rejects corpus mismatches and duplicate cases', () => {
    expect(() => readResumeReport({ ...report, corpusFingerprint: 'changed' }, expected)).toThrow(/fingerprint/i)
    expect(() => readResumeReport({ ...report, promptRevision: 'changed' }, expected)).toThrow(/prompt/i)
    expect(() => readResumeReport({ ...report, promptFingerprint: 'changed' }, expected)).toThrow(/prompt/i)
    expect(() => readResumeReport({ ...report, results: [report.results[0], report.results[0]] }, expected)).toThrow(/duplicate/i)
  })

  it('selects only explicitly recorded failures and preserves passing results', () => {
    const selection = selectFailedRerun(report.results, ['normal:g02'], expected.validCaseKeys)
    expect(selection.rerunCaseKeys).toEqual(['normal:g02'])
    expect(selection.preservedResults).toEqual([report.results[0]])
  })

  it('rejects unknown, duplicate, and result-less failed IDs', () => {
    expect(() => selectFailedRerun(report.results, ['normal:g02', 'normal:g02'], expected.validCaseKeys)).toThrow(/duplicate/i)
    expect(() => selectFailedRerun(report.results, ['normal:missing'], expected.validCaseKeys)).toThrow(/unknown/i)
    expect(() => selectFailedRerun(report.results, ['strong:g01'], expected.validCaseKeys)).toThrow(/no prior result/i)
  })

  it('requires exactly the five reviewed final-repair IDs and preserves 35 passing cases', () => {
    const results = Array.from({ length: 40 }, (_, index) => ({ id: `c${index + 1}`, mode: 'normal', requestedModel: 'gpt-5.6-luna', outcome: 'success' }))
    const keys = new Set(results.map((item) => `normal:${item.id}`))
    const failed = results.slice(0, 5).map((item) => `normal:${item.id}`)
    const selection = selectFailedRerun(results, failed, keys)
    validateExplicitRepairSelection(selection.rerunCaseKeys, 5, failed)
    expect(selection.rerunCaseKeys).toHaveLength(5)
    expect(selection.preservedResults).toHaveLength(35)
    expect(() => validateExplicitRepairSelection(selection.rerunCaseKeys, 4, failed)).toThrow(/exactly 4/i)
    expect(() => validateExplicitRepairSelection(selection.rerunCaseKeys, 5, [...failed.slice(0, 4), 'normal:other'])).toThrow(/reviewed/i)
  })

  it('selects exactly five Terra failures while preserving 40 Luna and three Terra results', () => {
    const luna = Array.from({ length: 40 }, (_, index) => ({ id: `l${index + 1}`, mode: 'normal', requestedModel: 'gpt-5.6-luna' }))
    const terra = Array.from({ length: 8 }, (_, index) => ({ id: `t${index + 1}`, mode: 'strong', requestedModel: 'gpt-5.6-terra' }))
    const results = [...luna, ...terra]
    const keys = new Set(results.map((item) => `${item.mode}:${item.id}`))
    const failed = terra.slice(3).map((item) => `strong:${item.id}`)
    const selection = selectFailedRerun(results, failed, keys)
    validateExplicitRepairSelection(selection.rerunCaseKeys, 5, failed)
    expect(selection.preservedResults).toHaveLength(43)
    expect(selection.preservedResults.filter((item) => item.mode === 'normal')).toHaveLength(40)
    expect(selection.preservedResults.filter((item) => item.mode === 'strong')).toHaveLength(3)
  })

  it('adds legacy prompt lineage without overwriting existing revision data', () => {
    expect(addMissingPromptLineage([
      { id: 'old' }, { id: 'new', promptRevision: 'repair', promptFingerprint: 'new-hash' }
    ], 'baseline', 'legacy-unavailable')).toEqual([
      { id: 'old', promptRevision: 'baseline', promptFingerprint: 'legacy-unavailable' },
      { id: 'new', promptRevision: 'repair', promptFingerprint: 'new-hash' }
    ])
  })

  it('migrates legacy repair lineage and appends new repair history without overwriting it', () => {
    const legacy = { repairLineage: { explicitRerunFailed: true, rerunCaseKeys: ['normal:old'], preservedCaseKeys: [] } }
    const next = {
      explicitRerunFailed: true, promptRevision: 'm3-final-v3', requestRevision: 'm3-mode-specific-output-v1',
      requestFingerprint: 'request-hash', rerunCaseKeys: ['normal:g02'], preservedCaseKeys: ['normal:g01']
    }
    const history = appendRepairHistory(legacy, next)
    expect(history).toHaveLength(2)
    expect(history[0]?.rerunCaseKeys).toEqual(['normal:old'])
    expect(history[1]).toEqual(next)
    expect(legacy).not.toHaveProperty('repairHistory')
  })

  it('restores prior failed records for cases not attempted after fail-fast', () => {
    const current = [{ id: 'g01', mode: 'strong', outcome: 'output_limit' }]
    const prior = [
      { id: 'g01', mode: 'strong', outcome: 'malformed_response' },
      { id: 'g03', mode: 'strong', outcome: 'malformed_response' }
    ]
    const restored = restoreUnattemptedReruns(current, prior, new Set(['strong:g01']))
    expect(restored).toEqual([current[0], prior[1]])
  })
})
