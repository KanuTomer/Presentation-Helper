import type { BrowserWindow } from 'electron'
import type { CaptureProtectionStatus } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'

export class CaptureProtection {
  private requested = false
  constructor(private readonly settings: SettingsStore) {}
  enable(window: BrowserWindow): void {
    try { window.setContentProtection(true); this.requested = true } catch { this.requested = false }
  }
  status(window?: BrowserWindow): CaptureProtectionStatus {
    return {
      requested: this.requested,
      electronReported: window?.isContentProtected() ?? false,
      windowsAffinity: this.requested ? 'EXCLUDEFROMCAPTURE' : 'UNKNOWN',
      verifiedResults: this.settings.captureResults
    }
  }
}
