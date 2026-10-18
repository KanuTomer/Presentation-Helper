import {
  BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen,
  type BrowserWindowConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { is } from '@electron-toolkit/utils'
import { channels } from '../../shared/channels.js'
import { WINDOW_LAYOUT_REVISION, type SettingsStore } from '../settings/store.js'
import type { CaptureProtection } from './captureProtection.js'
import type { ShortcutRegistrationStatus, WorkspaceStatus } from '../../shared/contracts.js'

export interface OverlayBounds { x: number; y: number; width: number; height: number }
export interface WorkArea { x: number; y: number; width: number; height: number }

export const OVERLAY_DEFAULT_WIDTH = 1100
export const OVERLAY_DEFAULT_HEIGHT = 720
export const OVERLAY_MIN_WIDTH = 680
export const OVERLAY_MIN_HEIGHT = 420
export const OVERLAY_EDGE_MARGIN = 16
const LEGACY_NARROW_WIDTH = 900
export const CLICK_THROUGH_RECOVERY_SHORTCUT = 'Control+Shift+I'

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
  private displayListenersRegistered = false
  private clickThrough = false
  private quitting = false
  private workspace: WorkspaceStatus = { mode: 'setup', transition: 'idle' }
  private transitionTimer?: NodeJS.Timeout
  private resizingContent = false
  private presenterHeight = 180
  onWorkspaceStatusChange?: () => void
  onClickThroughStatusChange?: ClickThroughStatusListener
  private readonly handleDisplayChange = (): void => {
    if (this.window && this.workspace.transition === 'idle') {
      if (this.isPresenter) this.resizePresenter(this.presenterHeight)
      else { const bounds = this.validBounds(this.window.getBounds()); if (bounds) this.window.setBounds(bounds) }
    }
    this.notifySurfaceRestored()
  }
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const requiresLayoutMigration = this.store.windowLayoutRevision < WINDOW_LAYOUT_REVISION
    const initialBounds = requiresLayoutMigration
      ? this.migrateLegacyBounds(this.store.windowBounds)
      : this.validBounds(this.store.windowBounds) ?? this.defaultBounds()
    const windowOptions: BrowserWindowConstructorOptions = {
      ...initialBounds,
      minWidth: OVERLAY_MIN_WIDTH, minHeight: OVERLAY_MIN_HEIGHT, frame: false, transparent: true, alwaysOnTop: false,
      skipTaskbar: false, resizable: true, movable: true, show: false, backgroundColor: '#00000000',
      hasShadow: false, roundedCorners: true,
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    }
    this.window = new BrowserWindow(windowOptions)
    // Applying the Electron-supported screen-saver level after native window
    // creation keeps the transparent overlay topmost without changing focus.
    this.window.setAlwaysOnTop(false)
    this.registerDisplayListeners()
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
    this.capture.setEnabled(this.window, false)
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
      this.unregisterDisplayListeners()
      this.window = undefined
    })
    this.window.on('move', () => this.persistBounds())
    this.window.on('resize', () => {
      this.persistBounds()
      this.notifySurfaceRestored()
    })
    this.window.on('restore', () => this.notifySurfaceRestored())
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    if (is.dev && process.env.ELECTRON_RENDERER_URL) this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else this.window.loadFile(join(__dirname, '../renderer/index.html'))
    if (!this.tray) this.createTray()
    return this.window
  }

  setClickThrough(enabled: boolean): void {
    if (enabled && !this.isRecoveryRegistered()) {
      this.applyClickThrough(false)
      throw new Error(`Click-through requires the ${CLICK_THROUGH_RECOVERY_SHORTCUT} recovery shortcut.`)
    }
    if (enabled && this.workspace.mode !== 'presenter') throw new Error('Enter presenter mode before enabling click-through.')
    this.applyClickThrough(enabled)
  }
  get workspaceStatus(): WorkspaceStatus { return { ...this.workspace } }
  get isPresenter(): boolean { return this.workspace.mode === 'presenter' && this.workspace.transition === 'idle' }
  enterPresenter(): void {
    if (this.workspace.mode === 'presenter' || this.workspace.transition !== 'idle') return
    const window = this.ensureWindow()
    clearTimeout(this.boundsTimer)
    const setupBounds = window.getBounds()
    void this.store.setWindowBounds(setupBounds)
    window.hide()
    this.capture.setEnabled(window, true)
    if (!this.capture.status(window).electronReported) {
      this.capture.setEnabled(window, false)
      this.workspace.error = 'Windows capture protection could not be enabled. Presenter mode was not opened.'
      this.onWorkspaceStatusChange?.()
      this.showFocusedTopmost(window)
      throw new Error(this.workspace.error)
    }
    this.setClickThrough(false)
    this.workspace = { mode: 'presenter', transition: 'entering', transitionId: randomUUID() }
    window.setMinimumSize(600, 120)
    const saved = this.store.presenterLayout
    const area = screen.getDisplayMatching(setupBounds).workArea
    window.setBounds(presenterBounds({ x: saved?.x ?? setupBounds.x, y: saved?.y ?? setupBounds.y, width: saved?.width ?? 860, height: this.presenterHeight }, area))
    window.setSkipTaskbar(true)
    window.setAlwaysOnTop(true, 'screen-saver')
    this.beginTransition()
  }
  requestSetup(section: NonNullable<WorkspaceStatus['setupRequest']> = 'settings'): void {
    if (this.workspace.transition !== 'idle') return
    const window = this.ensureWindow()
    this.emergencyUnlock()
    this.workspace = { ...this.workspace, setupRequest: section }
    this.onWorkspaceStatusChange?.()
    this.showFocusedTopmost(window)
    if (this.workspace.mode === 'setup') window.webContents.send(section === 'privacy' ? channels.openPrivacy : channels.openSettings)
  }
  dismissSetupRequest(): void { this.workspace = { ...this.workspace, setupRequest: undefined }; this.onWorkspaceStatusChange?.() }
  confirmSetup(): void {
    if (this.workspace.mode !== 'presenter' || !this.workspace.setupRequest || this.workspace.transition !== 'idle') throw new Error('No pending Setup confirmation.')
    const window = this.ensureWindow()
    clearTimeout(this.boundsTimer)
    const { x, y, width } = window.getBounds()
    void this.store.setPresenterLayout({ x, y, width })
    window.hide()
    this.setClickThrough(false)
    this.workspace = { ...this.workspace, mode: 'setup', transition: 'leaving', transitionId: randomUUID(), error: undefined }
    window.setMinimumSize(OVERLAY_MIN_WIDTH, OVERLAY_MIN_HEIGHT)
    window.setBounds(this.validBounds(this.store.windowBounds) ?? this.defaultBounds())
    this.beginTransition()
  }
  acknowledgeWorkspace(id: string): void {
    if (this.workspace.transition === 'idle' || this.workspace.transitionId !== id) return
    const window = this.ensureWindow()
    clearTimeout(this.transitionTimer)
    if (this.workspace.mode === 'setup') {
      this.capture.setEnabled(window, false)
      window.setAlwaysOnTop(false)
      window.setSkipTaskbar(false)
    } else if (!this.capture.status(window).electronReported) {
      this.workspace.error = 'Capture protection was lost. The presenter window remains hidden.'
      this.onWorkspaceStatusChange?.(); return
    }
    this.workspace = { ...this.workspace, transition: 'idle', transitionId: undefined, error: undefined }
    this.onWorkspaceStatusChange?.()
    this.showFocusedTopmost(window)
  }
  resizePresenter(height: number): void {
    if (!Number.isFinite(height) || height < 80 || height > 100_000) throw new Error('Invalid presenter content height.')
    const zoom = this.window?.webContents.getZoomFactor?.() ?? 1
    this.presenterHeight = Math.ceil(height)
    if (this.workspace.mode !== 'presenter') return
    const window = this.ensureWindow()
    const current = window.getBounds()
    const next = presenterBounds({ ...current, height: Math.ceil(this.presenterHeight * zoom) }, screen.getDisplayMatching(current).workArea)
    if (next.height === current.height && next.y === current.y) return
    this.resizingContent = true
    try { window.setBounds(next) } finally { this.resizingContent = false }
  }
  private beginTransition(): void {
    clearTimeout(this.transitionTimer)
    this.transitionTimer = setTimeout(() => {
      this.workspace.error = 'The workspace could not be rendered safely. The window remains hidden; use the tray to retry.'
      this.onWorkspaceStatusChange?.()
    }, 8000)
    this.transitionTimer.unref?.()
    this.onWorkspaceStatusChange?.()
  }
  focusAsk(): void { const window = this.ensureWindow(); this.showFocusedTopmost(window); if (this.isPresenter) window.webContents.send(channels.focusAsk) }
  openSettings(): void { this.requestSetup('settings') }
  openPrivacy(): void {
    this.requestSetup('privacy')
  }
  showTransmissionPreview(): void { this.showInactiveTopmost(this.ensureWindow()) }
  get hasTray(): boolean { return Boolean(this.tray) }
  get isClickThrough(): boolean { return this.clickThrough }
  get clickThroughStatus(): WindowClickThroughStatus {
    return {
      enabled: this.clickThrough,
      recoveryShortcut: CLICK_THROUGH_RECOVERY_SHORTCUT,
      recoveryAvailable: this.isRecoveryRegistered()
    }
  }
  toggleVisibility(): void { const window = this.ensureWindow(); window.isVisible() ? window.hide() : this.showInactiveTopmost(window) }
  emergencyUnlock(): void { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }).catch(() => undefined) }
  showFromTray(): void { this.emergencyUnlock(); this.showFocusedTopmost(this.ensureWindow()) }
  openSettingsFromTray(): void { this.emergencyUnlock(); this.openSettings() }
  prepareToQuit(): void { this.quitting = true; clearTimeout(this.boundsTimer); clearTimeout(this.transitionTimer) }

  registerShortcuts(): boolean {
    return this.registerShortcutSet(this.store.settings.askShortcut, this.store.settings.hideShortcut)
  }

  get shortcutRegistrations(): ShortcutRegistrationStatus[] {
    const settings = this.store.settings
    return [
      { purpose: 'ask', accelerator: settings.askShortcut },
      { purpose: 'hide', accelerator: settings.hideShortcut },
      { purpose: 'recovery', accelerator: CLICK_THROUGH_RECOVERY_SHORTCUT }
    ].map(({ purpose, accelerator }) => ({
      purpose: purpose as ShortcutRegistrationStatus['purpose'], accelerator,
      status: globalShortcut.isRegistered(accelerator) ? 'registered' : 'unavailable'
    }))
  }

  private isRecoveryRegistered(): boolean {
    return this.recoveryShortcutRegistered && globalShortcut.isRegistered(CLICK_THROUGH_RECOVERY_SHORTCUT)
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
      if (!globalShortcut.register(shortcut, action)) warnings.push(`Could not register ${shortcut}. Quit duplicate copies, retry, or choose another shortcut in Settings. Windows does not identify the conflicting application.`)
      else this.registeredConfigurableShortcuts.add(shortcut)
    }
    register(askShortcut, () => this.focusAsk())
    register(hideShortcut, () => this.toggleVisibility())
    return warnings
  }

  private ensureRecoveryShortcut(): boolean {
    if (this.isRecoveryRegistered()) return true
    this.recoveryShortcutRegistered = false
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
  private persistBounds(): void {
    if (this.resizingContent || this.workspace.transition !== 'idle') return
    clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => {
      if (!this.window || this.workspace.transition !== 'idle') return
      const bounds = this.window.getBounds()
      if (this.isPresenter) { const { x, y, width } = bounds; void this.store.setPresenterLayout({ x, y, width }); this.resizePresenter(this.presenterHeight) }
      else void this.store.setWindowBounds(bounds)
    }, 250)
  }
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

  private showInactiveTopmost(window: BrowserWindow): void {
    if (this.workspace.transition !== 'idle') { this.onWorkspaceStatusChange?.(); return }
    window.showInactive()
    // The screen-saver level is the Electron-supported topmost tier that
    // remains effective over fullscreen presentation windows.
    window.setAlwaysOnTop(this.isPresenter, this.isPresenter ? 'screen-saver' : 'normal')
    this.notifySurfaceRestored(window)
  }

  private showFocusedTopmost(window: BrowserWindow): void {
    if (this.workspace.transition !== 'idle') {
      if (this.workspace.error) { this.workspace = { ...this.workspace, transitionId: randomUUID(), error: undefined }; this.beginTransition() }
      else this.onWorkspaceStatusChange?.()
      return
    }
    window.show()
    window.setAlwaysOnTop(this.isPresenter, this.isPresenter ? 'screen-saver' : 'normal')
    window.focus()
    this.notifySurfaceRestored(window)
  }

  private notifySurfaceRestored(window = this.window): void {
    if (!window || window.isDestroyed()) return
    try { window.webContents.send(channels.surfaceRestored) } catch { /* renderer lifecycle notifications are best effort */ }
  }

  private registerDisplayListeners(): void {
    if (this.displayListenersRegistered) return
    screen.on('display-added', this.handleDisplayChange)
    screen.on('display-removed', this.handleDisplayChange)
    screen.on('display-metrics-changed', this.handleDisplayChange)
    this.displayListenersRegistered = true
  }

  private unregisterDisplayListeners(): void {
    if (!this.displayListenersRegistered) return
    screen.removeListener('display-added', this.handleDisplayChange)
    screen.removeListener('display-removed', this.handleDisplayChange)
    screen.removeListener('display-metrics-changed', this.handleDisplayChange)
    this.displayListenersRegistered = false
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

export function presenterBounds(bounds: OverlayBounds, area: WorkArea): OverlayBounds {
  const margin = OVERLAY_EDGE_MARGIN
  const width = Math.min(Math.max(600, bounds.width), Math.max(1, area.width - margin * 2))
  const height = Math.min(Math.max(120, bounds.height), Math.max(1, area.height - margin * 2))
  return { x: Math.max(area.x + margin, Math.min(bounds.x, area.x + area.width - margin - width)),
    y: Math.max(area.y + margin, Math.min(bounds.y, area.y + area.height - margin - height)), width, height }
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
