import { describe, expect, it } from 'vitest'
import {
  conservativeInputTokens,
  maximumCallCostUsd,
  M3_EVAL_BUDGET_USD,
  M3_EVAL_OUTPUT_TOKEN_CAPS,
  M3_TERRA_REPAIR_BUDGET_USD,
  staysWithinBudget,
  tokenCostUsd
} from '../src/main/ai/evalBudget'

describe('M3 live evaluation budget', () => {
  it('uses conservative input estimation and the approved official rates', () => {
    expect(conservativeInputTokens('x'.repeat(10))).toBe(4)
    expect(tokenCostUsd('normal', 1_000_000, 1_000_000)).toBe(7)
    expect(tokenCostUsd('strong', 1_000_000, 1_000_000)).toBe(17.5)
  })

  it('prices every request with its mode-specific output allowance', () => {
    expect(maximumCallCostUsd('normal', '')).toBe(0.0027)
    expect(maximumCallCostUsd('strong', '')).toBe(0.018)
    expect(M3_EVAL_OUTPUT_TOKEN_CAPS).toEqual({ normal: 450, strong: 1_200 })
    expect(M3_TERRA_REPAIR_BUDGET_USD).toBe(0.105)
  })

  it('refuses a request whose conservative maximum crosses $0.40', () => {
    expect(staysWithinBudget(0.39, 0.01)).toBe(true)
    expect(staysWithinBudget(0.39, 0.010001)).toBe(false)
    expect(M3_EVAL_BUDGET_USD).toBe(0.4)
  })
})
