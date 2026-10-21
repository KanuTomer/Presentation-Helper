import { afterEach, describe, expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => vi.fn())
const displays = vi.hoisted(() => [{ id: 1, label: 'Primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 }])
vi.mock('electron', () => ({ desktopCapturer: { getSources: capture }, screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0], getDisplayMatching: () => displays[0] } }))
import { electronSnapshotCapture } from '../src/main/snapshots/electronCapture'
import type { WindowManager } from '../src/main/windows/windowManager'
afterEach(() => vi.useRealTimers())
function harness(visible = true, isProtected = false) {
  const window = { getBounds: () => displays[0]!.bounds, isVisible: () => visible, isDestroyed: () => false, isContentProtected: () => isProtected, hide: vi.fn() }
  const showTransmissionPreview = vi.fn()
  const captureScreen = electronSnapshotCapture({ presenterWindow: window, showTransmissionPreview } as unknown as WindowManager)
  return { window, showTransmissionPreview, captureScreen }
}
describe('monitor capture restoration', () => {
  it('uses native scaled monitor resolution, hides before capture and restores once', async () => {
    vi.useFakeTimers(); const h = harness()
    capture.mockImplementationOnce(async () => {
      expect(h.window.hide).toHaveBeenCalledTimes(1)
      return [{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 3840, height: 2160 }), toPNG: () => Buffer.from('png') } }]
    })
    const result = h.captureScreen(); await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ width: 3840, height: 2160 })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } }))
    expect(h.showTransmissionPreview).toHaveBeenCalledTimes(1)
  })
  it('restores after capture failure without modifying interaction state', async () => {
    vi.useFakeTimers(); const h = harness(); capture.mockRejectedValueOnce(new Error('denied'))
    const result = h.captureScreen(); const assertion = expect(result).rejects.toThrow('denied')
    await vi.advanceTimersByTimeAsync(100); await assertion; expect(h.showTransmissionPreview).toHaveBeenCalledTimes(1)
  })
  it('does not hide (flash) a presenter that is already excluded from capture', async () => {
    const h = harness(true, true)
    capture.mockImplementationOnce(async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 3840, height: 2160 }), toPNG: () => Buffer.from('png') } }])
    await expect(h.captureScreen()).resolves.toMatchObject({ width: 3840 })
    expect(h.window.hide).not.toHaveBeenCalled(); expect(h.showTransmissionPreview).not.toHaveBeenCalled()
  })
  it('does not show a previously hidden overlay', async () => {
    vi.useFakeTimers(); const h = harness(false); capture.mockRejectedValueOnce(new Error('denied'))
    const result = h.captureScreen(); const assertion = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(100); await assertion; expect(h.showTransmissionPreview).not.toHaveBeenCalled()
  })
})
