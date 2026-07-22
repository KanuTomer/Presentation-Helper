import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript gate module has no declaration file.
import { helperTestFailure, parseHelperTestSummary } from '../scripts/helper-tests.mjs'

describe('strict .NET helper test gate', () => {
  it('accepts 29 or more passing tests only when the summary is complete', () => {
    const output = 'Passed! - Failed: 0, Passed: 29, Skipped: 0, Total: 29, Duration: 1 s'
    expect(parseHelperTestSummary(output)).toEqual({ failed: 0, passed: 29, skipped: 0, total: 29 })
    expect(helperTestFailure(output, 0)).toBeUndefined()
    expect(helperTestFailure('Passed! - Failed: 0, Passed: 28, Skipped: 0, Total: 28', 0)).toMatch(/at least 29/i)
    expect(helperTestFailure('no tests are available', 0)).toMatch(/zero discovered tests/i)
  })

  it('reports policy blocks and ordinary nonzero exits distinctly', () => {
    expect(helperTestFailure('An Application Control policy has blocked this file. (0x800711C7)', 0))
      .toMatch(/^blocked-by-smart-app-control:/)
    expect(helperTestFailure('', 2)).toMatch(/exited with code 2/i)
  })
})
