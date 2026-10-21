import { randomUUID } from 'node:crypto'
import type { ScreenshotAttachment } from '../../shared/contracts.js'

export const SNAPSHOT_MAX_EDGE = 3_840
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
export const SNAPSHOT_EXPIRY_MS = 10 * 60_000
export interface CapturedSnapshot { bytes: Buffer; width: number; height: number; mime: 'image/png' | 'image/jpeg' }
/** Captures the monitor behind the presenter. */
export type SnapshotCapture = () => Promise<CapturedSnapshot>

/** One memory-only frame. IDs cannot be used to submit arbitrary renderer images. */
export class SnapshotStore {
  private frame?: ScreenshotAttachment & { bytes: Buffer; mime: CapturedSnapshot['mime'] }
  private expiry?: ReturnType<typeof setTimeout>
  private revision = 0
  constructor(private captureScreen: SnapshotCapture, private clock: () => number = Date.now) {}

  async capture(): Promise<ScreenshotAttachment> {
    this.clear()
    const revision = this.revision
    const image = await this.captureScreen()
    if (this.revision !== revision) throw new Error('Snapshot capture was discarded.')
    if (!image.bytes.length || image.bytes.length > SNAPSHOT_MAX_BYTES || image.width < 1 || image.height < 1 || Math.max(image.width, image.height) > SNAPSHOT_MAX_EDGE) throw new Error('The screenshot exceeds the supported resolution or 8 MiB image limit.')
    const attachment = { id: randomUUID(), expiresAt: new Date(this.clock() + SNAPSHOT_EXPIRY_MS).toISOString() }
    this.frame = { ...attachment, bytes: image.bytes, mime: image.mime }
    this.expiry = setTimeout(() => this.clear(), SNAPSHOT_EXPIRY_MS)
    this.expiry.unref?.()
    return attachment
  }

  /** The image as a data URL, built only when it is sent. */
  dataUrl(id: string): string {
    const frame = this.frame
    const expired = frame !== undefined && this.clock() >= Date.parse(frame.expiresAt)
    if (expired) this.clear()
    if (!frame || frame.id !== id || expired) throw new Error('This screenshot expired. Take a new snapshot.')
    return `data:${frame.mime};base64,${frame.bytes.toString('base64')}`
  }

  has(id: string): boolean { return this.frame?.id === id }

  clear(): void {
    this.revision += 1
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = undefined
    this.frame = undefined
  }
}
