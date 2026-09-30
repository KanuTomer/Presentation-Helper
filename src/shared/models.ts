export type ReasoningEffort = 'low' | 'medium' | 'high'
export interface ModelDefinition {
  id: string
  label: string
  imageInput: boolean
  structuredOutputs: boolean
  reasoning: readonly ReasoningEffort[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}
const efforts = ['low', 'medium', 'high'] as const
export const MODEL_REGISTRY: readonly ModelDefinition[] = Object.freeze([
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', imageInput: true, structuredOutputs: true, reasoning: efforts, inputUsdPerMillion: 2, outputUsdPerMillion: 12 }
])
export function findModel(id: string): ModelDefinition | undefined { return MODEL_REGISTRY.find((model) => model.id === id) }
