import { afterEach, describe, expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => vi.fn())
const displays = vi.hoisted(() => [{ id: 1, label: 'Primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 }])
vi.mock('electron', () => ({ desktopCapturer: { getSources: capture }, screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0], getDisplayMatching: () => displays[0] } }))
import { electronSnapshotCapture } from '../src/main/snapshots/electronCapture'
import type { WindowManager } from '../src/main/windows/windowManager'
afterEach(() => vi.useRealTimers())
function harness(visible = true) {
  const window = { getBounds: () => displays[0]!.bounds, isVisible: () => visible, isDestroyed: () => false, hide: vi.fn() }
  const showTransmissionPreview = vi.fn()
  const adapter = electronSnapshotCapture({ window, showTransmissionPreview } as unknown as WindowManager)
  return { window, showTransmissionPreview, adapter }
}
describe('monitor capture restoration', () => {
  it('uses native scaled monitor resolution, hides before capture and restores once', async () => {
    vi.useFakeTimers(); const h = harness()
    capture.mockImplementationOnce(async () => {
      expect(h.window.hide).toHaveBeenCalledTimes(1)
      return [{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 3840, height: 2160 }), toPNG: () => Buffer.from('png') } }]
    })
    const result = h.adapter.capture('1', new AbortController().signal); await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ width: 3840, height: 2160 })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } }))
    expect(h.showTransmissionPreview).toHaveBeenCalledTimes(1)
  })
  it('restores after capture failure without modifying interaction state', async () => {
    vi.useFakeTimers(); const h = harness(); capture.mockRejectedValueOnce(new Error('denied'))
    const result = h.adapter.capture('1', new AbortController().signal); const assertion = expect(result).rejects.toThrow('denied')
    await vi.advanceTimersByTimeAsync(100); await assertion; expect(h.showTransmissionPreview).toHaveBeenCalledTimes(1)
  })
  it('does not show a previously hidden overlay', async () => {
    vi.useFakeTimers(); const h = harness(false); capture.mockRejectedValueOnce(new Error('denied'))
    const result = h.adapter.capture('1', new AbortController().signal); const assertion = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(100); await assertion; expect(h.showTransmissionPreview).not.toHaveBeenCalled()
  })
})
