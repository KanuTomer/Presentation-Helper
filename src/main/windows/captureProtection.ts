import type { BrowserWindow } from 'electron'
import type { CaptureProtectionStatus } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'

export class CaptureProtection {
  private requested = false
  constructor(private readonly settings: SettingsStore) {}
  setEnabled(window: BrowserWindow, enabled: boolean): void {
    try { window.setContentProtection(enabled); this.requested = enabled } catch { this.requested = false }
  }
  status(window?: BrowserWindow): CaptureProtectionStatus {
    return {
      requested: this.requested,
      electronReported: window?.isContentProtected() ?? false,
      verifiedResults: this.settings.captureResults
    }
  }
}
