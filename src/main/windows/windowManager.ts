import { BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen } from 'electron'
import { join } from 'node:path'
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

export class WindowManager {
  window?: BrowserWindow
  private tray?: Tray
  shortcutWarnings: string[] = []
  private registeredShortcuts = new Set<string>()
  private boundsTimer?: NodeJS.Timeout
  private clickThrough = false
  private quitting = false
  private glassTint = 0.42
  private glassTintCssKey?: string
  private glassTintCssRevision = 0
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const requiresLayoutMigration = this.store.windowLayoutRevision < WINDOW_LAYOUT_REVISION
    const initialBounds = requiresLayoutMigration
      ? this.migrateLegacyBounds(this.store.windowBounds)
      : this.validBounds(this.store.windowBounds) ?? this.defaultBounds()
    this.window = new BrowserWindow({
      ...initialBounds,
      minWidth: OVERLAY_MIN_WIDTH, minHeight: OVERLAY_MIN_HEIGHT, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, movable: true, show: false, backgroundColor: '#00000000',
      hasShadow: false, roundedCorners: true,
      ...(process.platform === 'win32' ? { backgroundMaterial: 'none' as const } : {}),
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    // Applying the Electron-supported screen-saver level after native window
    // creation keeps the transparent overlay topmost without changing focus.
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.glassTint = this.clampGlassTint(this.store.settings.glassTint)
    this.window.webContents.once('did-finish-load', () => this.applyGlassTint())
    if (requiresLayoutMigration) void this.store.setWindowLayout(initialBounds, WINDOW_LAYOUT_REVISION)
    this.clickThrough = this.store.settings.clickThrough
    this.window.setIgnoreMouseEvents(this.clickThrough, { forward: true })
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
    this.window.on('closed', () => { this.window = undefined })
    this.window.on('move', () => this.persistBounds()); this.window.on('resize', () => this.persistBounds())
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    if (is.dev && process.env.ELECTRON_RENDERER_URL) this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else this.window.loadFile(join(__dirname, '../renderer/index.html'))
    if (!this.tray) this.createTray()
    this.registerShortcuts()
    return this.window
  }

  setClickThrough(enabled: boolean): void { this.clickThrough = enabled; this.window?.setIgnoreMouseEvents(enabled, { forward: true }) }
  setGlassTint(value: number): void {
    this.glassTint = this.clampGlassTint(value)
    this.applyGlassTint()
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
  toggleVisibility(): void { const window = this.ensureWindow(); window.isVisible() ? window.hide() : this.showInactiveTopmost(window) }
  emergencyUnlock(): void { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }) }
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
    for (const shortcut of this.registeredShortcuts) globalShortcut.unregister(shortcut)
    this.registeredShortcuts.clear(); this.shortcutWarnings = []
    const register = (shortcut: string, action: () => void): void => {
      if (!globalShortcut.register(shortcut, action)) this.shortcutWarnings.push(`Could not register ${shortcut}. Choose another shortcut in Settings.`)
      else this.registeredShortcuts.add(shortcut)
    }
    register(askShortcut, () => this.focusAsk())
    register(hideShortcut, () => this.toggleVisibility())
    const emergencyShortcut = 'Control+Shift+I'
    if (!globalShortcut.register(emergencyShortcut, () => this.emergencyUnlock())) {
      this.shortcutWarnings.push(`Could not register ${emergencyShortcut}. Click-through was disabled for safety.`)
      // This must be synchronous at the window layer; persistence follows in
      // the background so a failed recovery shortcut can never lock the user
      // out of a click-through overlay loaded from prior settings.
      this.emergencyUnlock()
    } else this.registeredShortcuts.add(emergencyShortcut)
    return this.shortcutWarnings.length === 0
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

  private clampGlassTint(value: number): number { return Math.min(0.78, Math.max(0.18, value)) }

  private applyGlassTint(): void {
    const window = this.window
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    const revision = ++this.glassTintCssRevision
    const previousKey = this.glassTintCssKey
    const css = `:root { --glass-tint: ${this.glassTint.toFixed(2)}; }`
    void window.webContents.insertCSS(css).then(async (key) => {
      if (!this.window || this.window.isDestroyed() || revision !== this.glassTintCssRevision) {
        await window.webContents.removeInsertedCSS(key).catch(() => undefined)
        return
      }
      this.glassTintCssKey = key
      if (previousKey && previousKey !== key) {
        await window.webContents.removeInsertedCSS(previousKey).catch(() => undefined)
      }
    }).catch(() => undefined)
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
