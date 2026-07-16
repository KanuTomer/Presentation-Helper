import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  M6_LIVE_BUDGET_USD,
  M6BudgetLedger,
  actualAnswerCostUsd,
  appendM6Result,
  assertRedactedM6Report,
  evaluateM6AggregateGate,
  documentedMaximumM6CampaignCostUsd,
  maximumM6CampaignCostUsd,
  meaningLooksCorrect,
  m6CorpusFingerprint,
  newM6Report,
  parseM6Corpus,
  transcriptionMaximumCostUsd,
  transcriptionTokenCostUsd,
  validateM6ResumeReport,
  type M6CaseResult
} from '../src/main/ai/m6Eval'

const rawCorpus = JSON.parse(readFileSync(resolve('tests/fixtures/m6-live-corpus.json'), 'utf8')) as unknown
const corpus = parseM6Corpus(rawCorpus)

describe('M6 live evaluator', () => {
  it('validates the immutable 20-case corpus and ten predesignated pipeline cases', () => {
    expect(corpus).toHaveLength(20)
    expect(corpus.filter((item) => item.fullPipeline)).toHaveLength(10)
    expect(corpus.slice(0, 10).every((item) => item.fullPipeline)).toBe(true)
    expect(corpus.slice(10).every((item) => !item.fullPipeline)).toBe(true)
    expect(m6CorpusFingerprint(corpus)).toMatch(/^[a-f0-9]{64}$/)

    expect(() => parseM6Corpus([...rawCorpus as object[], (rawCorpus as object[])[0]])).toThrow(/exactly 20/i)
    expect(() => parseM6Corpus((rawCorpus as Array<Record<string, unknown>>).map((item, index) =>
      index === 19 ? { ...item, id: 'm6-19' } : item
    ))).toThrow(/duplicate/i)
  })

  it('projects the complete campaign below the immutable $0.15 ceiling without network access', () => {
    const maximum = maximumM6CampaignCostUsd(corpus)
    expect(maximum).toBeGreaterThan(0)
    expect(maximum).toBeLessThanOrEqual(M6_LIVE_BUDGET_USD)
    expect(documentedMaximumM6CampaignCostUsd(corpus)).toBeGreaterThan(M6_LIVE_BUDGET_USD)
    expect(transcriptionMaximumCostUsd(90)).toBe(0.005185)
    expect(transcriptionTokenCostUsd(1_000_000, 1_000_000)).toBe(6.25)
  })

  it('reserves projected spend and maintains lifetime accounting across a resume', () => {
    const ledger = new M6BudgetLedger(0.02)
    ledger.assertReserve(0.13)
    ledger.recordActual(0.01)
    expect(ledger.spentUsd).toBeCloseTo(0.03)
    expect(() => ledger.assertReserve(0.120001)).toThrow(/budget stop/i)
    const overCap = new M6BudgetLedger(0.150001)
    expect(() => overCap.assertReserve(0)).toThrow(/budget stop/i)
    const actualOverrun = new M6BudgetLedger(0.149)
    expect(() => actualOverrun.recordActual(0.002)).toThrow(/exceeded/i)
    expect(actualOverrun.spentUsd).toBeCloseTo(0.151)

    const report = newM6Report(corpus, new Date('2026-07-14T00:00:00.000Z'))
    const updated = appendM6Result(report, fixtureResult('m6-01'), new Date('2026-07-14T00:01:00.000Z'))
    const resumed = validateM6ResumeReport(updated, corpus)
    expect(resumed.results.map((item) => item.id)).toEqual(['m6-01'])
    expect(resumed.budget.actualUsd).toBe(fixtureCost())
    expect(() => appendM6Result(resumed, fixtureResult('m6-01'))).toThrow(/reruns are forbidden/i)
  })

  it('conservatively records an unreported-usage reserve and never accepts that case', () => {
    const report = newM6Report(corpus)
    const reserve = 0.0042
    const failed: M6CaseResult = {
      ...fixtureResult('m6-01'),
      passed: false,
      flags: { ...fixtureResult('m6-01').flags, pipelineValid: false },
      usage: {
        transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
        answerInputTokens: 0, answerOutputTokens: 0, answerReasoningTokens: 0,
        unreportedUsageReserveUsd: reserve
      },
      estimatedCostUsd: reserve,
      errorCode: 'missing_answer_usage'
    }
    const updated = appendM6Result(report, failed)
    expect(updated.budget.actualUsd).toBe(reserve)
    expect(updated.failedIds).toEqual(['m6-01'])
    expect(() => appendM6Result(report, { ...failed, passed: true, errorCode: undefined })).toThrow(/cannot pass|inconsistent pass/i)

    const overCap = appendM6Result(report, {
      ...failed,
      usage: { ...failed.usage, unreportedUsageReserveUsd: 0.151 },
      estimatedCostUsd: 0.151,
      errorCode: 'budget_exceeded'
    })
    expect(overCap.budget.actualUsd).toBe(0.151)
    expect(evaluateM6AggregateGate(overCap).flags.budget).toBe(false)
    expect(validateM6ResumeReport(overCap, corpus).budget.actualUsd).toBe(0.151)
  })

  it('rejects corpus mismatches, duplicate results, and reports containing sensitive content', () => {
    const report = newM6Report(corpus)
    expect(() => validateM6ResumeReport({ ...report, corpusFingerprint: 'changed' }, corpus)).toThrow(/invalid.*shape|does not match/i)
    const duplicate = { ...report, results: [fixtureResult('m6-01'), fixtureResult('m6-01')] }
    expect(() => validateM6ResumeReport(duplicate, corpus)).toThrow(/duplicate/i)
    const spendMismatch = { ...report, results: [fixtureResult('m6-01')], budget: { ...report.budget, actualUsd: 0 } }
    expect(() => validateM6ResumeReport(spendMismatch, corpus)).toThrow(/lifetime spend/i)
    const usageMismatchResult = { ...fixtureResult('m6-01'), estimatedCostUsd: 0 }
    const usageMismatch = { ...report, results: [usageMismatchResult], budget: { ...report.budget, actualUsd: 0 } }
    expect(() => validateM6ResumeReport(usageMismatch, corpus)).toThrow(/token usage/i)
    const pricingMismatch = { ...report, pricing: { ...report.pricing, transcriptionInputPerMillion: 0 } }
    expect(() => validateM6ResumeReport(pricingMismatch, corpus)).toThrow(/invalid.*shape|does not match/i)
    const shapeMismatch = { ...report, results: [{ ...fixtureResult('m6-01'), flags: { audioValid: 'yes' } }] }
    expect(() => validateM6ResumeReport(shapeMismatch, corpus)).toThrow(/invalid.*shape/i)
    expect(() => assertRedactedM6Report({ ...report, transcript: 'must never persist' })).toThrow(/forbidden field/i)
    expect(() => assertRedactedM6Report({ ...report, rawTranscript: 'must never persist' })).toThrow(/forbidden field/i)
    expect(() => assertRedactedM6Report({ ...report, generatedAnswer: 'must never persist' })).toThrow(/forbidden field/i)
    expect(() => assertRedactedM6Report({ ...report, prompts: ['must never persist'] })).toThrow(/forbidden field/i)
    expect(() => assertRedactedM6Report({ ...report, note: 'OPENAI_API_KEY=sk-not-allowed-123456789' })).toThrow(/redaction failed/i)
    expect(() => validateM6ResumeReport({ ...report, benignExtra: true }, corpus)).toThrow(/invalid.*shape/i)
    expect(() => validateM6ResumeReport({ ...report, requestConfigFingerprint: '0'.repeat(64) }, corpus)).toThrow(/invalid.*shape|does not match/i)
    expect(JSON.stringify(report)).not.toMatch(/expectedQuestion|evidenceText|meaningAnchors/)
  })

  it('uses anchors and lexical recall only for a non-persisted meaning recommendation', () => {
    const testCase = corpus[0]!
    expect(meaningLooksCorrect('Which port is used by the telemetry gateway?', testCase.expectedQuestion, testCase.meaningAnchors)).toBe(true)
    expect(meaningLooksCorrect('How large is the cache?', testCase.expectedQuestion, testCase.meaningAnchors)).toBe(false)
  })

  it('enforces the 18-of-20 meaning and full-pipeline p50/p95 acceptance thresholds', () => {
    const report = newM6Report(corpus)
    report.results = corpus.map((item, index) => ({
      ...fixtureResult(item.id),
      fullPipeline: item.fullPipeline,
      flags: {
        ...fixtureResult(item.id).flags,
        meaningCorrect: index >= 2,
        pipelineValid: true,
        evidenceValid: true
      },
      timingsMs: {
        ...fixtureResult(item.id).timingsMs,
        ...(item.fullPipeline ? { releaseToVisibleAnswer: 4_000 } : {}),
        total: item.fullPipeline ? 3_800 : 500
      },
      versions: item.fullPipeline
        ? fixtureResult(item.id).versions
        : {
            helperProtocol: 2 as const, requestedTranscriptionModel: 'gpt-4o-mini-transcribe' as const,
            returnedTranscriptionModel: 'gpt-4o-mini-transcribe', pricing: 'openai-2026-07-16' as const
          },
          usage: item.fullPipeline
        ? fixtureResult(item.id).usage
        : {
            transcriptionInputTokens: 40, transcriptionAudioTokens: 40, transcriptionOutputTokens: 8,
            answerInputTokens: 0, answerOutputTokens: 0, answerReasoningTokens: 0,
            unreportedUsageReserveUsd: 0
          },
      estimatedCostUsd: item.fullPipeline ? fixtureCost() : transcriptionTokenCostUsd(40, 8)
    }))
    report.budget.actualUsd = report.results.reduce((total, item) => total + item.estimatedCostUsd, 0)
    expect(evaluateM6AggregateGate(report)).toMatchObject({
      accepted: true, meaningCorrectCount: 18, fullPipelineValidCount: 10,
      releaseToAnswerP50Ms: 4_000, releaseToAnswerP95Ms: 4_000
    })

    report.results[2]!.flags.meaningCorrect = false
    expect(evaluateM6AggregateGate(report).flags.meaning).toBe(false)
    report.results[2]!.flags.meaningCorrect = true
    report.results[0]!.timingsMs.releaseToVisibleAnswer = 8_001
    expect(evaluateM6AggregateGate(report).flags.latency).toBe(false)
  })

  it('does not infer renderer-visible latency from internal pipeline timings', () => {
    const report = completePassingReport()
    expect(evaluateM6AggregateGate(report).flags.latency).toBe(false)
    expect(evaluateM6AggregateGate(report)).toMatchObject({
      accepted: false,
      releaseToAnswerP50Ms: 0,
      releaseToAnswerP95Ms: 0
    })
  })
})

function completePassingReport() {
  const report = newM6Report(corpus)
  report.results = corpus.map((item) => {
    const base = fixtureResult(item.id)
    if (item.fullPipeline) return base
    return {
      ...base,
      fullPipeline: false,
      versions: {
        helperProtocol: 2 as const,
        requestedTranscriptionModel: 'gpt-4o-mini-transcribe' as const,
        returnedTranscriptionModel: 'gpt-4o-mini-transcribe',
        pricing: 'openai-2026-07-16' as const
      },
      timingsMs: { capture: 1_000, finalization: 50, transcription: 500, total: 500 },
      usage: {
        transcriptionInputTokens: 40, transcriptionAudioTokens: 40, transcriptionOutputTokens: 8,
        answerInputTokens: 0, answerOutputTokens: 0, answerReasoningTokens: 0,
        unreportedUsageReserveUsd: 0
      },
      estimatedCostUsd: transcriptionTokenCostUsd(40, 8)
    }
  })
  report.budget.actualUsd = report.results.reduce((total, item) => total + item.estimatedCostUsd, 0)
  return report
}

function fixtureResult(id: string): M6CaseResult {
  return {
    id, fullPipeline: true, passed: true,
    flags: { audioValid: true, transcriptionValid: true, meaningCorrect: true, wavDeleted: true, pipelineValid: true, evidenceValid: true },
    versions: {
      helperProtocol: 2, requestedTranscriptionModel: 'gpt-4o-mini-transcribe', returnedTranscriptionModel: 'gpt-4o-mini-transcribe',
      requestedAnswerModel: 'gpt-5.6-luna', returnedAnswerModel: 'gpt-5.6-luna', pricing: 'openai-2026-07-16'
    },
    timingsMs: { capture: 1000, finalization: 50, transcription: 500, retrieval: 5, generation: 600, total: 1155 },
    usage: {
      transcriptionInputTokens: 40, transcriptionAudioTokens: 40, transcriptionOutputTokens: 8,
      answerInputTokens: 100, answerOutputTokens: 100, answerReasoningTokens: 0,
      unreportedUsageReserveUsd: 0
    },
    estimatedCostUsd: fixtureCost()
  }
}

function fixtureCost(): number {
  return transcriptionTokenCostUsd(40, 8) + actualAnswerCostUsd(100, 100)
}
