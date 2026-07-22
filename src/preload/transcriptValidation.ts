import type { TranscriptionDraft } from '../shared/contracts.js'

const allowedKeys = new Set(['operationId', 'text', 'durationMs', 'endpointId', 'endpointName', 'createdAt'])
const bounded = (value: unknown, minimum: number, maximum: number): value is string => (
  typeof value === 'string' && Array.from(value).length >= minimum && Array.from(value).length <= maximum
)

/** Dependency-free defense-in-depth for Electron's restricted sandbox preload. */
export function parseTranscriptDraft(value: unknown): TranscriptionDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const draft = value as Record<string, unknown>
  if (Object.keys(draft).some((key) => !allowedKeys.has(key))) return undefined
  if (!bounded(draft.operationId, 1, 128) || !bounded(draft.text, 1, 4_000) ||
      !Number.isInteger(draft.durationMs) || (draft.durationMs as number) < 250 || (draft.durationMs as number) > 90_000 ||
      !bounded(draft.endpointId, 1, 2_048) || !bounded(draft.endpointName, 1, 512) ||
      typeof draft.createdAt !== 'string' || !Number.isFinite(Date.parse(draft.createdAt))) return undefined
  return draft as unknown as TranscriptionDraft
}
