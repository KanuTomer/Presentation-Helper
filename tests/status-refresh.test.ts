import { describe, expect, it } from 'vitest'
import { StatusRefreshGuard } from '../src/renderer/statusRefresh'

describe('renderer status refresh ordering', () => {
  it('rejects an older status snapshot after a newer pushed status event', () => {
    const guard = new StatusRefreshGuard()
    const slowRefresh = guard.begin()
    guard.observeStatus()
    expect(guard.acceptsStatus(slowRefresh)).toBe(false)

    const currentRefresh = guard.begin()
    expect(guard.acceptsStatus(currentRefresh)).toBe(true)
  })

  it('rejects resources from an older refresh when a newer refresh finishes first', () => {
    const guard = new StatusRefreshGuard()
    const older = guard.begin()
    const newer = guard.begin()
    expect(guard.acceptsResources(older)).toBe(false)
    expect(guard.acceptsResources(newer)).toBe(true)
  })
})
