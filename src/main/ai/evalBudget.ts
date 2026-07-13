import { AI_RESPONSE_REQUEST_POLICIES } from './requestPolicy.js'

export type EvalModelMode = 'normal' | 'strong'

export const M3_EVAL_BUDGET_USD = 0.4
export const M3_TERRA_REPAIR_BUDGET_USD = 0.105
export const M3_EVAL_OUTPUT_TOKEN_CAPS = {
  normal: AI_RESPONSE_REQUEST_POLICIES.normal.maxOutputTokens,
  strong: AI_RESPONSE_REQUEST_POLICIES.strong.maxOutputTokens
} as const
export const M3_EVAL_PRICES = {
  normal: { input: 1, output: 6 },
  strong: { input: 2.5, output: 15 }
} as const

/**
 * Conservative text-token estimate for the M3 evaluator. Dividing by three is
 * deliberately stricter than the common four-characters-per-token heuristic.
 */
export function conservativeInputTokens(serializedRequestText: string): number {
  return Math.ceil(serializedRequestText.length / 3)
}

export function maximumCallCostUsd(mode: EvalModelMode, serializedRequestText: string): number {
  return tokenCostUsd(
    mode,
    conservativeInputTokens(serializedRequestText),
    M3_EVAL_OUTPUT_TOKEN_CAPS[mode]
  )
}

export function tokenCostUsd(mode: EvalModelMode, inputTokens: number, outputTokens: number): number {
  const rates = M3_EVAL_PRICES[mode]
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000
}

export function staysWithinBudget(
  spentUsd: number,
  nextMaximumUsd: number,
  budgetUsd = M3_EVAL_BUDGET_USD
): boolean {
  return spentUsd + nextMaximumUsd <= budgetUsd + Number.EPSILON
}
