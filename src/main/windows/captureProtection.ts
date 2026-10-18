import type { BrowserWindow } from 'electron'
import type { CaptureProtectionStatus } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'

export class CaptureProtection {
  private readonly requested = new WeakMap<BrowserWindow, boolean>()
  constructor(private readonly settings: SettingsStore) {}
  setEnabled(window: BrowserWindow, enabled: boolean): void {
    try { window.setContentProtection(enabled); this.requested.set(window, enabled) } catch { this.requested.set(window, false) }
  }
  status(window?: BrowserWindow): CaptureProtectionStatus {
    return {
      requested: window ? this.requested.get(window) ?? false : false,
      electronReported: window?.isContentProtected() ?? false,
      verifiedResults: this.settings.captureResults
    }
  }
}
