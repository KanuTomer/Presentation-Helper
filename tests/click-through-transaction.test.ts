import { describe, expect, it, vi } from 'vitest'
import { applyClickThroughTransaction } from '../src/main/windows/clickThroughTransaction'

function windowPort(initial: boolean) {
  let enabled = initial
  return {
    get clickThroughStatus() {
      return { enabled, recoveryShortcut: 'Control+Shift+I' as const, recoveryAvailable: true }
    },
    setClickThrough: vi.fn((value: boolean) => { enabled = value })
  }
}

describe('click-through persistence transaction', () => {
  it('rolls a failed enable back in both window and mutable settings memory', async () => {
    const windows = windowPort(false)
    let stored = false
    let call = 0
    const store = {
      updateSettings: vi.fn(async ({ clickThrough }: { clickThrough: boolean }) => {
        stored = clickThrough
        call += 1
        if (call === 1) throw new Error('disk denied')
      })
    }

    await expect(applyClickThroughTransaction(windows, store, true)).rejects.toThrow('disk denied')
    expect(windows.clickThroughStatus.enabled).toBe(false)
    expect(stored).toBe(false)
    expect(store.updateSettings).toHaveBeenNthCalledWith(2, { clickThrough: false })
  })

  it('keeps interaction restored when persisting a disable fails', async () => {
    const windows = windowPort(true)
    let stored = true
    let call = 0
    const store = {
      updateSettings: vi.fn(async ({ clickThrough }: { clickThrough: boolean }) => {
        stored = clickThrough
        call += 1
        if (call === 1) throw new Error('disk denied')
      })
    }

    await expect(applyClickThroughTransaction(windows, store, false)).rejects.toThrow('disk denied')
    expect(windows.clickThroughStatus.enabled).toBe(false)
    expect(stored).toBe(false)
  })

  it('returns the synchronized native status after a successful commit', async () => {
    const windows = windowPort(false)
    const store = { updateSettings: vi.fn(async () => undefined) }
    await expect(applyClickThroughTransaction(windows, store, true)).resolves.toEqual({
      enabled: true, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true
    })
  })
})
