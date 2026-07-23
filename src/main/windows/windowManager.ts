import {
  BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen,
  type BrowserWindowConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { release as operatingSystemRelease } from 'node:os'
import { is } from '@electron-toolkit/utils'
import { channels } from '../../shared/channels.js'
import { WINDOW_LAYOUT_REVISION, type SettingsStore } from '../settings/store.js'
import type { CaptureProtection } from './captureProtection.js'

export interface OverlayBounds { x: number; y: number; width: number; height: number }
export interface WorkArea { x: number; y: number; width: number; height: number }

export const OVERLAY_DEFAULT_WIDTH = 1100
export const OVERLAY_DEFAULT_HEIGHT = 720
export const OVERLAY_MIN_WIDTH = 680
export const OVERLAY_MIN_HEIGHT = 420
export const OVERLAY_EDGE_MARGIN = 16
const LEGACY_NARROW_WIDTH = 900
export const CLICK_THROUGH_RECOVERY_SHORTCUT = 'Control+Shift+I'
export const WINDOWS_11_22H2_BUILD = 22_621

export interface WindowClickThroughStatus {
  enabled: boolean
  recoveryShortcut: typeof CLICK_THROUGH_RECOVERY_SHORTCUT
  recoveryAvailable: boolean
}

export type ClickThroughStatusListener = (status: WindowClickThroughStatus) => void

export class WindowManager {
  window?: BrowserWindow
  private tray?: Tray
  shortcutWarnings: string[] = []
  private registeredConfigurableShortcuts = new Set<string>()
  private recoveryShortcutRegistered = false
  private boundsTimer?: NodeJS.Timeout
  private shapeTimer?: NodeJS.Timeout
  private clickThrough = false
  private quitting = false
  onClickThroughStatusChange?: ClickThroughStatusListener
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const requiresLayoutMigration = this.store.windowLayoutRevision < WINDOW_LAYOUT_REVISION
    const initialBounds = requiresLayoutMigration
      ? this.migrateLegacyBounds(this.store.windowBounds)
      : this.validBounds(this.store.windowBounds) ?? this.defaultBounds()
    const acrylicSupported = supportsWindowsAcrylic()
    const windowOptions: BrowserWindowConstructorOptions = {
      ...initialBounds,
      minWidth: OVERLAY_MIN_WIDTH, minHeight: OVERLAY_MIN_HEIGHT, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, movable: true, show: false, backgroundColor: '#00000000',
      hasShadow: false, roundedCorners: true,
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    }
    if (acrylicSupported) {
      try {
        this.window = new BrowserWindow({ ...windowOptions, backgroundMaterial: 'acrylic' })
      } catch {
        // Windows editions, hosted runners, or transparency policy can reject
        // a backdrop despite reporting a recent build. Keep the transparent
        // shader/CSS fallback usable instead of preventing the overlay launch.
        this.window = new BrowserWindow(windowOptions)
      }
    } else {
      this.window = new BrowserWindow(windowOptions)
    }
    // Applying the Electron-supported screen-saver level after native window
    // creation keeps the transparent overlay topmost without changing focus.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.applyRoundedShape()
    if (requiresLayoutMigration) void this.store.setWindowLayout(initialBounds, WINDOW_LAYOUT_REVISION)
    const hadPersistedClickThrough = this.store.settings.clickThrough
    // Reserve the fixed recovery shortcut before exposing the window. A stale
    // persisted value is cleared below rather than restored automatically.
    this.registerShortcuts()
    // Click-through is runtime-only. Every enable must follow the renderer's
    // explicit confirmation, so even a previously clean shutdown starts
    // interactive and clears the stale persisted value.
    this.setClickThrough(false)
    if (hadPersistedClickThrough) void this.store.updateSettings({ clickThrough: false }).catch(() => undefined)
    this.capture.setEnabled(this.window, true)
    this.window.once('ready-to-show', () => {
      if (!this.window) return
      this.showInactiveTopmost(this.window)
    })
    this.window.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.window?.hide()
    })
    this.window.on('closed', () => {
      clearTimeout(this.shapeTimer)
      this.window = undefined
    })
    this.window.on('move', () => this.persistBounds())
    this.window.on('resize', () => {
      this.persistBounds()
      clearTimeout(this.shapeTimer)
      this.shapeTimer = setTimeout(() => this.applyRoundedShape(), 16)
    })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    if (is.dev && process.env.ELECTRON_RENDERER_URL) this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else this.window.loadFile(join(__dirname, '../renderer/index.html'))
    if (!this.tray) this.createTray()
    return this.window
  }

  setClickThrough(enabled: boolean): void {
    if (enabled && !this.recoveryShortcutRegistered) {
      this.applyClickThrough(false)
      throw new Error(`Click-through requires the ${CLICK_THROUGH_RECOVERY_SHORTCUT} recovery shortcut.`)
    }
    this.applyClickThrough(enabled)
  }
  focusAsk(): void { const window = this.ensureWindow(); this.showFocusedTopmost(window); window.webContents.send(channels.focusAsk) }
  openSettings(): void { const window = this.ensureWindow(); this.showFocusedTopmost(window); window.webContents.send(channels.openSettings) }
  openPrivacy(): void {
    this.emergencyUnlock()
    const window = this.ensureWindow()
    this.showFocusedTopmost(window)
    window.webContents.send(channels.openPrivacy)
  }
  showTransmissionPreview(): void { this.showInactiveTopmost(this.ensureWindow()) }
  get hasTray(): boolean { return Boolean(this.tray) }
  get isClickThrough(): boolean { return this.clickThrough }
  get clickThroughStatus(): WindowClickThroughStatus {
    return {
      enabled: this.clickThrough,
      recoveryShortcut: CLICK_THROUGH_RECOVERY_SHORTCUT,
      recoveryAvailable: this.recoveryShortcutRegistered
    }
  }
  toggleVisibility(): void { const window = this.ensureWindow(); window.isVisible() ? window.hide() : this.showInactiveTopmost(window) }
  emergencyUnlock(): void { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }).catch(() => undefined) }
  showFromTray(): void { this.emergencyUnlock(); this.showFocusedTopmost(this.ensureWindow()) }
  openSettingsFromTray(): void { this.emergencyUnlock(); this.openSettings() }
  prepareToQuit(): void { this.quitting = true }

  registerShortcuts(): boolean {
    return this.registerShortcutSet(this.store.settings.askShortcut, this.store.settings.hideShortcut)
  }

  applyShortcutSet(
    askShortcut: string,
    hideShortcut: string,
    fallback: { askShortcut: string; hideShortcut: string }
  ): boolean {
    if (this.registerShortcutSet(askShortcut, hideShortcut)) return true
    const failedWarnings = [...this.shortcutWarnings]
    const rollbackSucceeded = this.registerShortcutSet(fallback.askShortcut, fallback.hideShortcut)
    this.shortcutWarnings = [
      ...failedWarnings,
      ...(rollbackSucceeded ? [] : this.shortcutWarnings.map((warning) => `Rollback: ${warning}`))
    ]
    return false
  }

  private registerShortcutSet(askShortcut: string, hideShortcut: string): boolean {
    const recoveryAvailable = this.ensureRecoveryShortcut()
    const recoveryWarnings = recoveryAvailable
      ? []
      : [`Could not register ${CLICK_THROUGH_RECOVERY_SHORTCUT}. Click-through was disabled for safety.`]
    const attemptedWarnings = this.replaceConfigurableShortcuts(askShortcut, hideShortcut)
    this.shortcutWarnings = [...recoveryWarnings, ...attemptedWarnings]
    return recoveryAvailable && attemptedWarnings.length === 0
  }

  private replaceConfigurableShortcuts(askShortcut: string, hideShortcut: string): string[] {
    for (const shortcut of this.registeredConfigurableShortcuts) globalShortcut.unregister(shortcut)
    this.registeredConfigurableShortcuts.clear()
    const warnings: string[] = []
    const register = (shortcut: string, action: () => void): void => {
      if (!globalShortcut.register(shortcut, action)) warnings.push(`Could not register ${shortcut}. Choose another shortcut in Settings.`)
      else this.registeredConfigurableShortcuts.add(shortcut)
    }
    register(askShortcut, () => this.focusAsk())
    register(hideShortcut, () => this.toggleVisibility())
    return warnings
  }

  private ensureRecoveryShortcut(): boolean {
    if (this.recoveryShortcutRegistered) return true
    if (globalShortcut.register(CLICK_THROUGH_RECOVERY_SHORTCUT, () => this.emergencyUnlock())) {
      this.recoveryShortcutRegistered = true
      this.notifyClickThroughStatus()
      return true
    }
    // This must be synchronous at the window layer; persistence follows in
    // the background so a failed recovery shortcut can never lock the user
    // out of a click-through overlay loaded from prior settings.
    this.applyClickThrough(false)
    void this.store.updateSettings({ clickThrough: false }).catch(() => undefined)
    return false
  }

  private applyClickThrough(enabled: boolean): void {
    const changed = this.clickThrough !== enabled
    this.clickThrough = enabled
    this.window?.setIgnoreMouseEvents(enabled, { forward: true })
    if (changed) this.notifyClickThroughStatus()
  }

  private notifyClickThroughStatus(): void {
    try { this.onClickThroughStatusChange?.(this.clickThroughStatus) } catch { /* observer errors must not affect window safety */ }
  }

  private createTray(): void {
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#6366f1"/><text x="16" y="23" text-anchor="middle" font-family="Segoe UI" font-size="21" font-weight="700" fill="white">P</text></svg>').toString('base64')}`)
    this.tray = new Tray(icon)
    this.tray.setToolTip('PresenterAI')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show PresenterAI', click: () => this.showFromTray() },
      { label: 'Settings', click: () => this.openSettingsFromTray() },
      { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
    ]))
  }
  private persistBounds(): void { clearTimeout(this.boundsTimer); this.boundsTimer = setTimeout(() => { if (this.window) void this.store.setWindowBounds(this.window.getBounds()) }, 250) }
  private validBounds(bounds?: OverlayBounds): OverlayBounds | undefined {
    if (!bounds) return undefined
    const displays = screen.getAllDisplays()
    if (displays.length === 0) return undefined
    const intersects = displays.some(({ workArea }) => bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x && bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y)
    const display = intersects
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    return clampOverlayBounds(bounds, display.workArea)
  }

  private migrateLegacyBounds(bounds?: OverlayBounds): OverlayBounds {
    if (!bounds) return this.defaultBounds()
    const displays = screen.getAllDisplays()
    if (displays.length === 0) return bounds
    const intersects = displays.some(({ workArea }) => rectanglesIntersect(bounds, workArea))
    const display = intersects
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    return migrateLegacyOverlayBounds(bounds, display.workArea)
  }

  private defaultBounds(): OverlayBounds { return defaultOverlayBounds(screen.getPrimaryDisplay().workArea) }

  private applyRoundedShape(): void {
    const window = this.window
    if (process.platform !== 'win32' || !window || window.isDestroyed()) return
    const { width, height } = window.getBounds()
    try { window.setShape(roundedWindowShape(width, height)) } catch { /* roundedCorners and renderer clipping remain as fallbacks */ }
  }

  private showInactiveTopmost(window: BrowserWindow): void {
    window.showInactive()
    // The screen-saver level is the Electron-supported topmost tier that
    // remains effective over fullscreen presentation windows.
    window.setAlwaysOnTop(true, 'screen-saver')
  }

  private showFocusedTopmost(window: BrowserWindow): void {
    window.show()
    window.setAlwaysOnTop(true, 'screen-saver')
    window.focus()
  }

  private ensureWindow(): BrowserWindow { return this.window && !this.window.isDestroyed() ? this.window : this.create() }
}

export function defaultOverlayBounds(area: WorkArea): OverlayBounds {
  const horizontalMargin = area.width >= OVERLAY_MIN_WIDTH + OVERLAY_EDGE_MARGIN * 2 ? OVERLAY_EDGE_MARGIN : 0
  const verticalMargin = area.height >= OVERLAY_MIN_HEIGHT + OVERLAY_EDGE_MARGIN * 2 ? OVERLAY_EDGE_MARGIN : 0
  const width = Math.min(OVERLAY_DEFAULT_WIDTH, area.width - horizontalMargin * 2)
  const height = Math.min(OVERLAY_DEFAULT_HEIGHT, area.height - verticalMargin * 2)
  return {
    x: area.x + Math.max(horizontalMargin, Math.floor((area.width - width) / 2)),
    y: area.y + Math.max(verticalMargin, Math.floor((area.height - height) / 2)),
    width,
    height
  }
}

export function migrateLegacyOverlayBounds(bounds: OverlayBounds, area: WorkArea): OverlayBounds {
  if (bounds.width >= LEGACY_NARROW_WIDTH) return clampOverlayBounds(bounds, area)
  const targetWidth = Math.min(OVERLAY_DEFAULT_WIDTH, availableDimension(area.width, OVERLAY_MIN_WIDTH))
  const centerX = bounds.x + bounds.width / 2
  return clampOverlayBounds({
    ...bounds,
    x: Math.round(centerX - targetWidth / 2),
    width: targetWidth
  }, area)
}

export function clampOverlayBounds(bounds: OverlayBounds, area: WorkArea): OverlayBounds {
  const horizontalMargin = area.width >= OVERLAY_MIN_WIDTH + OVERLAY_EDGE_MARGIN * 2 ? OVERLAY_EDGE_MARGIN : 0
  const verticalMargin = area.height >= OVERLAY_MIN_HEIGHT + OVERLAY_EDGE_MARGIN * 2 ? OVERLAY_EDGE_MARGIN : 0
  const availableWidth = area.width - horizontalMargin * 2
  const availableHeight = area.height - verticalMargin * 2
  const width = Math.min(Math.max(OVERLAY_MIN_WIDTH, bounds.width), availableWidth)
  const height = Math.min(Math.max(OVERLAY_MIN_HEIGHT, bounds.height), availableHeight)
  return {
    x: Math.min(Math.max(bounds.x, area.x + horizontalMargin), area.x + area.width - horizontalMargin - width),
    y: Math.min(Math.max(bounds.y, area.y + verticalMargin), area.y + area.height - verticalMargin - height),
    width,
    height
  }
}

function availableDimension(size: number, minimum: number): number {
  return size >= minimum + OVERLAY_EDGE_MARGIN * 2 ? size - OVERLAY_EDGE_MARGIN * 2 : size
}

function rectanglesIntersect(left: OverlayBounds, right: WorkArea): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
}

export function roundedWindowShape(width: number, height: number, radius = 24): OverlayBounds[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const safeHeight = Math.max(1, Math.floor(height))
  const safeRadius = Math.max(0, Math.min(Math.floor(radius), Math.floor(safeWidth / 2), Math.floor(safeHeight / 2)))
  if (safeRadius === 0) return [{ x: 0, y: 0, width: safeWidth, height: safeHeight }]

  const rows: Array<{ y: number; inset: number }> = []
  for (let y = 0; y < safeHeight; y += 1) {
    let inset = 0
    if (y < safeRadius) {
      const distance = safeRadius - y - 0.5
      inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt(Math.max(0, safeRadius ** 2 - distance ** 2))))
    } else if (y >= safeHeight - safeRadius) {
      const distance = y - (safeHeight - safeRadius) + 0.5
      inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt(Math.max(0, safeRadius ** 2 - distance ** 2))))
    }
    rows.push({ y, inset })
  }

  const rects: OverlayBounds[] = []
  let start = rows[0]!
  let previous = start
  for (const row of rows.slice(1)) {
    if (row.inset !== start.inset) {
      rects.push({
        x: start.inset, y: start.y,
        width: Math.max(1, safeWidth - start.inset * 2),
        height: previous.y - start.y + 1
      })
      start = row
    }
    previous = row
  }
  rects.push({
    x: start.inset, y: start.y,
    width: Math.max(1, safeWidth - start.inset * 2),
    height: previous.y - start.y + 1
  })
  return rects
}

export function supportsWindowsAcrylic(
  platform: NodeJS.Platform = process.platform,
  osRelease = operatingSystemRelease()
): boolean {
  if (platform !== 'win32') return false
  const build = Number(osRelease.split('.')[2])
  return Number.isInteger(build) && build >= WINDOWS_11_22H2_BUILD
}
