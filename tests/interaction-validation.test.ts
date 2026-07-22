import { describe, expect, it } from 'vitest'
import { parseAnswerFormat, parseClipboardCode } from '../src/main/ipc/interactionValidation'

describe('renderer interaction validation', () => {
  it('accepts only Auto and Code answer formats', () => {
    expect(parseAnswerFormat(undefined)).toBe('auto')
    expect(parseAnswerFormat('auto')).toBe('auto')
    expect(parseAnswerFormat('code')).toBe('code')
    expect(() => parseAnswerFormat('presenter')).toThrow('Invalid answer format')
    expect(() => parseAnswerFormat({ value: 'code' })).toThrow('Invalid answer format')
  })

  it('preserves valid code exactly and applies a Unicode code-point limit', () => {
    const code = 'const value = "😀";\n\treturn value;'
    expect(parseClipboardCode(code)).toBe(code)
    expect(() => parseClipboardCode('   ')).toThrow('Invalid code block')
    expect(() => parseClipboardCode('😀'.repeat(8_001))).toThrow('Invalid code block')
    expect(parseClipboardCode('😀'.repeat(8_000))).toHaveLength(16_000)
  })
})
