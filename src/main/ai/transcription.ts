import { z } from 'zod'

export const MAX_TRANSCRIPT_CHARACTERS = 4_000
export const MAX_TERMINOLOGY_HINT_CHARACTERS = 500
export const MAX_APPROVED_VOCABULARY_TERMS = 30
export const MAX_APPROVED_VOCABULARY_TERM_CHARACTERS = 64

export interface TokenTranscriptionUsage {
  type: 'tokens'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  audioTokens: number
  textTokens: number
}

export interface DurationTranscriptionUsage {
  type: 'duration'
  inputTokens: 0
  outputTokens: 0
  totalTokens: 0
  audioTokens: 0
  textTokens: 0
  durationSeconds: number
}

export interface EmptyTranscriptionUsage {
  type: 'none'
  inputTokens: 0
  outputTokens: 0
  totalTokens: 0
  audioTokens: 0
  textTokens: 0
}

export type TranscriptionUsage = TokenTranscriptionUsage | DurationTranscriptionUsage | EmptyTranscriptionUsage

export interface TranscriptionResult {
  text: string
  /** Provider-returned model identifier; absent when the JSON payload omits provenance. */
  model?: string
  latencyMs: number
  usage: TranscriptionUsage
}

const tokenUsageSchema = z.object({
  type: z.literal('tokens'),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_token_details: z.object({
    audio_tokens: z.number().int().nonnegative().optional(),
    text_tokens: z.number().int().nonnegative().optional()
  }).passthrough().optional()
}).passthrough().superRefine((usage, context) => {
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    context.addIssue({ code: 'custom', message: 'Transcription total token usage is inconsistent.' })
  }
  const audio = usage.input_token_details?.audio_tokens ?? 0
  const text = usage.input_token_details?.text_tokens ?? 0
  if (audio > usage.input_tokens || text > usage.input_tokens || audio + text > usage.input_tokens) {
    context.addIssue({ code: 'custom', message: 'Transcription input token details are inconsistent.' })
  }
})

const durationUsageSchema = z.object({
  type: z.literal('duration'),
  seconds: z.number().nonnegative().finite()
}).passthrough()

const usageSchema = z.union([tokenUsageSchema, durationUsageSchema])

const transcriptionEnvelopeSchema = z.object({
  text: z.string(),
  model: z.string().trim().min(1).optional(),
  usage: usageSchema.optional()
}).passthrough()

const transcriptionMetadataSchema = z.object({
  model: z.string().trim().min(1).optional(),
  usage: usageSchema.optional()
}).passthrough()

export type ParsedTranscriptionResponse = {
  text: string
  model?: string
  usage: TranscriptionUsage
}

export function parseTranscriptionResponse(value: unknown): ParsedTranscriptionResponse | undefined {
  const parsed = transcriptionEnvelopeSchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    text: parsed.data.text,
    ...(parsed.data.model ? { model: parsed.data.model } : {}),
    usage: normalizeTranscriptionUsage(parsed.data.usage)
  }
}

export function parseTranscriptionMetadata(value: unknown): Omit<ParsedTranscriptionResponse, 'text'> | undefined {
  const parsed = transcriptionMetadataSchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    ...(parsed.data.model ? { model: parsed.data.model } : {}),
    usage: normalizeTranscriptionUsage(parsed.data.usage)
  }
}

export function normalizeTranscript(value: string): string | undefined {
  const normalized = value
    .normalize('NFKC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized || Array.from(normalized).length > MAX_TRANSCRIPT_CHARACTERS) return undefined
  // Punctuation/noise alone is not a reviewer question and should never seed
  // retrieval or a model request.
  if (!/[\p{L}\p{N}]/u.test(normalized)) return undefined
  return normalized
}

export function buildTerminologyHint(input: {
  approvedVocabulary?: readonly string[]
  documentNames?: readonly string[]
  documentTitles?: readonly string[]
}): string {
  const approvedSeen = new Set<string>()
  const approved: string[] = []
  for (const candidate of input.approvedVocabulary ?? []) {
    const term = normalizeTerm(candidate)
    if (!term) continue
    const key = term.toLocaleLowerCase('en-US')
    if (approvedSeen.has(key)) continue
    approvedSeen.add(key)
    approved.push(term)
    if (approved.length === MAX_APPROVED_VOCABULARY_TERMS) break
  }
  const documentNames = (input.documentNames ?? [])
    .map((name) => name.replace(/\.[^.]+$/, ''))
    .map(normalizeTerm)
    .filter((value): value is string => Boolean(value))
  const documentTitles = (input.documentTitles ?? [])
    .map(normalizeTerm)
    .filter((value): value is string => Boolean(value))

  const seen = new Set<string>()
  const accepted: string[] = []
  let length = 0
  for (const term of [...approved, ...documentNames, ...documentTitles]) {
    const key = term.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    const addedLength = Array.from(term).length + (accepted.length === 0 ? 0 : 2)
    if (length + addedLength > MAX_TERMINOLOGY_HINT_CHARACTERS) continue
    seen.add(key)
    accepted.push(term)
    length += addedLength
  }
  return accepted.join(', ')
}

function normalizeTranscriptionUsage(
  usage: z.infer<typeof usageSchema> | undefined
): TranscriptionUsage {
  if (!usage) return emptyUsage()
  if (usage.type === 'duration') {
    return {
      ...emptyUsage(),
      type: 'duration',
      durationSeconds: usage.seconds
    }
  }
  return {
    type: 'tokens',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    audioTokens: usage.input_token_details?.audio_tokens ?? 0,
    textTokens: usage.input_token_details?.text_tokens ?? 0
  }
}

function emptyUsage(): EmptyTranscriptionUsage {
  return { type: 'none', inputTokens: 0, outputTokens: 0, totalTokens: 0, audioTokens: 0, textTokens: 0 }
}

function normalizeTerm(value: string): string | undefined {
  const normalized = value
    .normalize('NFKC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const length = Array.from(normalized).length
  if (!normalized || length > MAX_APPROVED_VOCABULARY_TERM_CHARACTERS) return undefined
  return normalized
}
