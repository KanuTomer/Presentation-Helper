import type { AnswerFormat } from '../../shared/contracts.js'

export function parseAnswerFormat(value: unknown): AnswerFormat {
  const normalized = value ?? 'code'
  if (normalized === 'auto') return 'presenter'
  if (normalized !== 'presenter' && normalized !== 'code') throw new Error('Invalid answer format.')
  return normalized
}

export function parseClipboardCode(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > 8_000) {
    throw new Error('Invalid code block.')
  }
  return value
}
