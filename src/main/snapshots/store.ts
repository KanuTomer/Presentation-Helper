import { randomUUID } from 'node:crypto'
import type { SnapshotMonitor, SnapshotPreview } from '../../shared/contracts.js'

export const SNAPSHOT_MAX_EDGE = 3_840
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
export const SNAPSHOT_EXPIRY_MS = 10 * 60_000
export interface CapturedSnapshot { bytes: Buffer; width: number; height: number; mime: 'image/png' | 'image/jpeg' }
export interface SnapshotCaptureAdapter {
  monitors(): SnapshotMonitor[]
  capture(monitorId: string, signal: AbortSignal): Promise<CapturedSnapshot>
}
/** One memory-only frame. IDs cannot be used to submit arbitrary renderer images. */
export class SnapshotStore {
  private frame?: { preview: SnapshotPreview; bytes: Buffer }
  private expiry?: ReturnType<typeof setTimeout>
  private revision = 0
  constructor(private adapter: SnapshotCaptureAdapter, private clock: () => number = Date.now) {}
  monitors(): SnapshotMonitor[] { return this.adapter.monitors() }
  async capture(monitorId: string | undefined, signal: AbortSignal): Promise<SnapshotPreview> {
    this.clear()
    const revision = this.revision
    const monitors = this.monitors()
    const selected = monitorId ? monitors.find((item) => item.id === monitorId) : monitors.find((item) => item.current) ?? monitors[0]
    if (!selected) throw new Error('The selected monitor is unavailable. Select a connected monitor and retake.')
    const image = await this.adapter.capture(selected.id, signal)
    try {
      signal.throwIfAborted()
      if (this.revision !== revision) throw new Error('Snapshot capture was discarded.')
      if (!image.bytes.length || image.bytes.length > SNAPSHOT_MAX_BYTES || image.width < 1 || image.height < 1 || Math.max(image.width, image.height) > SNAPSHOT_MAX_EDGE) throw new Error('The screenshot exceeds the supported resolution or 8 MiB image limit.')
      const preview: SnapshotPreview = { id: randomUUID(), monitorId: selected.id, width: image.width, height: image.height, bytes: image.bytes.length, dataUrl: `data:${image.mime};base64,${image.bytes.toString('base64')}`, expiresAt: new Date(this.clock() + SNAPSHOT_EXPIRY_MS).toISOString() }
      this.frame = { preview, bytes: image.bytes }
      this.expiry = setTimeout(() => this.clear(), SNAPSHOT_EXPIRY_MS)
      this.expiry.unref?.()
      return { ...preview }
    } catch (error) { image.bytes.fill(0); throw error }
  }
  get(id: string): SnapshotPreview {
    if (!this.frame || this.frame.preview.id !== id) throw new Error('This screenshot expired. Take a new snapshot.')
    if (this.clock() >= Date.parse(this.frame.preview.expiresAt)) { this.clear(); throw new Error('This screenshot expired. Take a new snapshot.') }
    return { ...this.frame.preview }
  }
  clear(): void {
    this.revision += 1
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = undefined
    this.frame?.bytes.fill(0)
    this.frame = undefined
  }
}
