import type { ClickThroughStatus } from '../../shared/contracts.js'

export interface ClickThroughWindowPort {
  readonly clickThroughStatus: ClickThroughStatus
  setClickThrough(enabled: boolean): void
}

export interface ClickThroughStorePort {
  updateSettings(patch: { clickThrough: boolean }): Promise<unknown>
}

/**
 * Applies the native state before persistence, then restores a safe in-memory
 * and on-disk value if persistence fails. A failed disable always remains
 * disabled; storage errors must never make the overlay ignore input again.
 */
export async function applyClickThroughTransaction(
  windows: ClickThroughWindowPort,
  store: ClickThroughStorePort,
  enabled: boolean
): Promise<ClickThroughStatus> {
  const previous = windows.clickThroughStatus.enabled
  windows.setClickThrough(enabled)
  try {
    await store.updateSettings({ clickThrough: enabled })
  } catch (error) {
    const safeFallback = enabled ? previous : false
    try { windows.setClickThrough(safeFallback) } catch { windows.setClickThrough(false) }
    // SettingsStore mutates its in-memory snapshot before flushing. A second
    // mutation is therefore required even when the recovery flush also fails.
    await store.updateSettings({ clickThrough: safeFallback }).catch(() => undefined)
    throw error
  }
  return windows.clickThroughStatus
}
