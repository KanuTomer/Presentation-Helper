export const USAGE_PRICING_VERSION = 'openai-2026-07-16'
export const MINI_TRANSCRIBE_INPUT_USD_PER_MILLION = 1.25
export const MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION = 5

export type BillableEndpoint = 'responses' | 'transcription'

export interface TokenPrice {
  endpoint: BillableEndpoint
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export interface TokenPriceResult {
  priced: boolean
  estimatedUsd: number
  pricingVersion: typeof USAGE_PRICING_VERSION
}

/**
 * Deliberately exact identifiers only. Provider-returned snapshots must be
 * reviewed and added explicitly before PresenterAI assigns them a cost.
 */
export const KNOWN_MODEL_PRICES: Readonly<Record<string, TokenPrice>> = Object.freeze({
  'gpt-5.6-luna': { endpoint: 'responses', inputUsdPerMillion: 1, outputUsdPerMillion: 6 },
  'gpt-5.6-terra': { endpoint: 'responses', inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
  'gpt-4o-mini-transcribe': {
    endpoint: 'transcription',
    inputUsdPerMillion: MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION
  },
  'gpt-4o-mini-transcribe-2025-12-15': {
    endpoint: 'transcription',
    inputUsdPerMillion: MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION
  },
  'gpt-4o-mini-transcribe-2025-03-20': {
    endpoint: 'transcription',
    inputUsdPerMillion: MINI_TRANSCRIBE_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: MINI_TRANSCRIBE_OUTPUT_USD_PER_MILLION
  }
})

export function estimateKnownModelTokens(
  endpoint: BillableEndpoint,
  model: string,
  inputTokens: number,
  outputTokens: number
): TokenPriceResult {
  const price = KNOWN_MODEL_PRICES[model]
  if (!price || price.endpoint !== endpoint) {
    return { priced: false, estimatedUsd: 0, pricingVersion: USAGE_PRICING_VERSION }
  }
  return {
    priced: true,
    estimatedUsd: (
      inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion
    ) / 1_000_000,
    pricingVersion: USAGE_PRICING_VERSION
  }
}
