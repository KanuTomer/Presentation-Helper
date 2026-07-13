import type { ModelMode } from '../../shared/contracts.js'

export interface AiResponseRequestPolicy {
  reasoningEffort: 'none' | 'low'
  maxOutputTokens: number
  verbosity?: 'low'
}

export const AI_RESPONSE_REQUEST_POLICIES: Record<ModelMode, AiResponseRequestPolicy> = {
  normal: { reasoningEffort: 'none', maxOutputTokens: 450 },
  strong: { reasoningEffort: 'low', maxOutputTokens: 1_200, verbosity: 'low' }
}

export function responseRequestPolicy(mode: ModelMode): AiResponseRequestPolicy {
  return AI_RESPONSE_REQUEST_POLICIES[mode]
}
