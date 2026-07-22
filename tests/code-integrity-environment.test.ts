import { describe, expect, it } from 'vitest'
// The diagnostic is intentionally a standalone read-only Node script.
// @ts-expect-error JavaScript diagnostic module has no declaration file.
import { classifySpawnError, redactedSpawnOutcome } from '../scripts/code-integrity-environment.mjs'

describe('code-integrity environment diagnostics', () => {
  it('classifies Windows policy-shaped launch failures without retaining provider messages', () => {
    expect(classifySpawnError('UNKNOWN')).toBe('blocked-by-policy-or-access')
    expect(classifySpawnError('EACCES')).toBe('blocked-by-policy-or-access')
    expect(classifySpawnError('ENOENT')).toBe('launch-failed')
    expect(redactedSpawnOutcome({ state: 'blocked-by-policy-or-access', code: 'UNKNOWN', message: 'private path and policy detail' }))
      .toEqual({ state: 'blocked-by-policy-or-access', code: 'UNKNOWN' })
  })
})
