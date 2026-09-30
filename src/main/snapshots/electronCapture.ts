import { desktopCapturer, screen } from 'electron'
import type { WindowManager } from '../windows/windowManager.js'
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_EDGE, type SnapshotCaptureAdapter } from './store.js'

export function electronSnapshotCapture(windows: WindowManager): SnapshotCaptureAdapter {
  return {
    monitors: () => {
      const bounds = windows.window?.getBounds()
      const current = bounds ? screen.getDisplayMatching(bounds).id : screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((display, index) => ({ id: String(display.id), name: display.label || `Monitor ${index + 1}`, current: current === display.id, width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }))
    },
    async capture(monitorId, signal) {
      const display = screen.getAllDisplays().find((item) => String(item.id) === monitorId)
      if (!display) throw new Error('The selected monitor was disconnected.')
      const window = windows.window
      const restore = Boolean(window && !window.isDestroyed() && window.isVisible())
      try {
        window?.hide()
        // Let DWM composite one overlay-free frame before requesting the monitor.
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        signal.throwIfAborted()
        const width = Math.round(display.size.width * display.scaleFactor)
        const height = Math.round(display.size.height * display.scaleFactor)
        const ratio = Math.min(1, SNAPSHOT_MAX_EDGE / Math.max(width, height))
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * ratio), height: Math.round(height * ratio) }, fetchWindowIcons: false })
        signal.throwIfAborted()
        const source = sources.find((item) => item.display_id === monitorId)
        if (!source || source.thumbnail.isEmpty()) throw new Error('Windows did not provide a screen image. Check screen-capture permissions and try again.')
        let image = source.thumbnail
        const size = image.getSize()
        if (Math.max(size.width, size.height) > SNAPSHOT_MAX_EDGE) {
          const boundedRatio = SNAPSHOT_MAX_EDGE / Math.max(size.width, size.height)
          image = image.resize({ width: Math.round(size.width * boundedRatio), height: Math.round(size.height * boundedRatio) })
        }
        let bytes = image.toPNG()
        let mime: 'image/png' | 'image/jpeg' = 'image/png'
        if (bytes.length > SNAPSHOT_MAX_BYTES) { bytes = image.toJPEG(90); mime = 'image/jpeg' }
        return { bytes, ...image.getSize(), mime }
      } finally {
        // No focus stealing or click-through changes; restoration redraws glass.
        if (restore && window && !window.isDestroyed()) windows.showTransmissionPreview()
      }
    }
  }
}
