import type { ModelMode } from '../../shared/contracts.js'
import type { OpenAIClientLike } from './service.js'

export interface AiResponseRequestPolicy {
  reasoningEffort: 'none' | 'low'
  maxOutputTokens: number
  verbosity?: 'low'
}

export const AI_RESPONSE_REQUEST_POLICIES: Record<ModelMode, AiResponseRequestPolicy> = {
  normal: { reasoningEffort: 'none', maxOutputTokens: 450 },
  strong: { reasoningEffort: 'low', maxOutputTokens: 1_200, verbosity: 'low' }
}

export const CODE_RESPONSE_REQUEST_POLICIES: Record<ModelMode, AiResponseRequestPolicy> = {
  normal: { reasoningEffort: 'none', maxOutputTokens: 2_000 },
  strong: { reasoningEffort: 'low', maxOutputTokens: 3_000, verbosity: 'low' }
}

export function responseRequestPolicy(mode: ModelMode): AiResponseRequestPolicy {
  return AI_RESPONSE_REQUEST_POLICIES[mode]
}

export function codeResponseRequestPolicy(mode: ModelMode): AiResponseRequestPolicy {
  return CODE_RESPONSE_REQUEST_POLICIES[mode]
}

/**
 * Live evaluations only: wraps a client so each Responses request uses the
 * historical policy, and refuses models outside the evaluated set.
 */
export function withRequestPolicy(client: OpenAIClientLike, policy: AiResponseRequestPolicy, allowedModels: readonly string[]): OpenAIClientLike {
  return {
    ...client,
    responses: {
      create: (body, options) => {
        if (!allowedModels.includes(String(body.model))) return Promise.reject(new Error(`Evaluation policy does not allow ${String(body.model)}.`))
        const text = (body.text ?? {}) as Record<string, unknown>
        return client.responses.create({
          ...body,
          reasoning: { effort: policy.reasoningEffort },
          max_output_tokens: policy.maxOutputTokens,
          text: { ...text, ...(policy.verbosity ? { verbosity: policy.verbosity } : {}) }
        }, options)
      }
    }
  }
}

/** The models the historical live evaluations were accepted on. */
export const EVALUATED_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra'] as const
