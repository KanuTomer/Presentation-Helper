// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { scheduleRelaunchAfterDeletion } from '../src/main/ipc/relaunchAfterDeletion'

describe('successful local-data deletion relaunch', () => {
  it('schedules, unreferences, and performs a relaunch only for complete deletion', () => {
    const callbacks: Array<() => void> = []
    const unref = vi.fn()
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback)
      return { unref }
    })
    const application = { relaunch: vi.fn(), exit: vi.fn() }

    expect(scheduleRelaunchAfterDeletion({ ok: false }, application, schedule)).toBe(false)
    expect(schedule).not.toHaveBeenCalled()

    expect(scheduleRelaunchAfterDeletion({ ok: true }, application, schedule)).toBe(true)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 100)
    expect(unref).toHaveBeenCalledOnce()
    expect(application.relaunch).not.toHaveBeenCalled()

    callbacks[0]?.()
    expect(application.relaunch).toHaveBeenCalledOnce()
    expect(application.exit).toHaveBeenCalledWith(0)
  })
})
