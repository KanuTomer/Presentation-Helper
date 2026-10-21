import {
  BrowserWindow, Menu, Tray, app, desktopCapturer, globalShortcut, nativeImage, nativeTheme, screen,
  type WebPreferences
} from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { channels } from '../../shared/channels.js'
import { PRESENTER_SHORTCUTS } from '../../shared/presenterShortcuts.js'
import { WINDOW_LAYOUT_REVISION, type SettingsStore } from '../settings/store.js'
import type { CaptureProtection } from './captureProtection.js'
import type { GlassDisplay, ShortcutRegistrationStatus, WorkspaceStatus } from '../../shared/contracts.js'

export interface OverlayBounds { x: number; y: number; width: number; height: number }
export interface WorkArea { x: number; y: number; width: number; height: number }

export const OVERLAY_DEFAULT_WIDTH = 1100
export const OVERLAY_DEFAULT_HEIGHT = 720
export const OVERLAY_MIN_WIDTH = 680
export const OVERLAY_MIN_HEIGHT = 420
export const OVERLAY_EDGE_MARGIN = 16
const LEGACY_NARROW_WIDTH = 900
export const CLICK_THROUGH_RECOVERY_SHORTCUT = 'Control+Shift+I'
const RESIZE_ANIMATION_MS = 160
const PRESENTER_SHORTCUT_WARNING = 'Presenter shortcuts unavailable:'

export interface WindowClickThroughStatus {
  enabled: boolean
  recoveryShortcut: typeof CLICK_THROUGH_RECOVERY_SHORTCUT
  recoveryAvailable: boolean
}

export type ClickThroughStatusListener = (status: WindowClickThroughStatus) => void

function webPreferences(): WebPreferences {
  return { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
}

/** Both windows load the same renderer; `view` selects Setup or presenter. */
function load(window: BrowserWindow, view: 'setup' | 'presenter'): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?view=${view}`)
  else void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } })
}

export class WindowManager {
  setupWindow?: BrowserWindow
  presenterWindow?: BrowserWindow
  private tray?: Tray
  shortcutWarnings: string[] = []
  private registeredConfigurableShortcuts = new Set<string>()
  private recoveryShortcutRegistered = false
  private boundsTimer?: NodeJS.Timeout
  private glassTimer?: NodeJS.Timeout
  private resizeTween?: NodeJS.Timeout
  private glassDisplayId?: number
  private displayListenersRegistered = false
  private clickThrough = false
  private quitting = false
  private presenterReady = false
  private workspace: WorkspaceStatus = { mode: 'setup' }
  private resizingContent = false
  private presenterHeight = 180
  onWorkspaceStatusChange?: () => void
  onClickThroughStatusChange?: ClickThroughStatusListener
  /** Turns click-through on through the same persisted path as the button. */
  onEnableClickThrough?: () => void
  /** Esc inside a PresenterAI window; returns true when it cancelled an operation. */
  onEscape?: () => boolean
  private presenterShortcutsRegistered = new Set<string>()
  private readonly handleDisplayChange = (): void => {
    const setup = this.setupWindow
    if (setup && !setup.isDestroyed()) { const bounds = this.validBounds(setup.getBounds()); if (bounds) setup.setBounds(bounds) }
    if (this.isPresenter) this.resizePresenter(this.presenterHeight)
    this.pushGlassDisplay(true)
    this.notifySurfaceRestored()
  }
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  /** The window the user is currently working in. */
  get window(): BrowserWindow | undefined { return this.isPresenter ? this.presenterWindow : this.setupWindow }
  get windows(): BrowserWindow[] { return [this.setupWindow, this.presenterWindow].filter((item): item is BrowserWindow => Boolean(item && !item.isDestroyed())) }

  create(): BrowserWindow {
    if (this.setupWindow && !this.setupWindow.isDestroyed()) return this.setupWindow
    const requiresLayoutMigration = this.store.windowLayoutRevision < WINDOW_LAYOUT_REVISION
    const initialBounds = requiresLayoutMigration
      ? this.migrateLegacyBounds(this.store.windowBounds)
      : this.validBounds(this.store.windowBounds) ?? this.defaultBounds()
    // Setup is an ordinary application window: framed, opaque, in the taskbar,
    // and deliberately visible to screen capture. Dark keeps its title bar
    // consistent with the presenter.
    nativeTheme.themeSource = 'dark'
    const setup = new BrowserWindow({
      ...initialBounds, minWidth: OVERLAY_MIN_WIDTH, minHeight: OVERLAY_MIN_HEIGHT,
      show: false, title: 'PresenterAI', backgroundColor: '#111318', autoHideMenuBar: true,
      webPreferences: webPreferences()
    })
    setup.setMenu(null)
    this.setupWindow = setup
    if (requiresLayoutMigration) void this.store.setWindowLayout(initialBounds, WINDOW_LAYOUT_REVISION)
    this.registerDisplayListeners()
    const hadPersistedClickThrough = this.store.settings.clickThrough
    // Reserve the fixed recovery shortcut before exposing any window. Click-
    // through is runtime-only, so a stale persisted value is always cleared.
    this.registerShortcuts()
    this.setClickThrough(false)
    if (hadPersistedClickThrough) void this.store.updateSettings({ clickThrough: false }).catch(() => undefined)
    this.capture.setEnabled(setup, false)
    setup.once('ready-to-show', () => { if (!this.isPresenter) setup.show() })
    this.guardWindow(setup)
    setup.on('move', () => this.persistBounds(setup))
    setup.on('resize', () => this.persistBounds(setup))
    load(setup, 'setup')
    this.createPresenter()
    if (!this.tray) this.createTray()
    return setup
  }

  /**
   * The presenter is created hidden with capture protection already requested,
   * then kept alive while hidden so the draft and answer survive Setup visits.
   */
  private createPresenter(): BrowserWindow {
    if (this.presenterWindow && !this.presenterWindow.isDestroyed()) return this.presenterWindow
    const presenter = new BrowserWindow({
      width: 860, height: this.presenterHeight, minWidth: 600, minHeight: 120,
      // Acrylic sits under the live-glass canvas and shows through when live
      // glass is off or unavailable, so low-power PCs still get real blur.
      frame: false, transparent: false, backgroundColor: '#00000000', backgroundMaterial: 'acrylic', roundedCorners: true,
      skipTaskbar: true, alwaysOnTop: true, resizable: true, show: false,
      webPreferences: webPreferences()
    })
    this.presenterWindow = presenter
    this.presenterReady = false
    this.capture.setEnabled(presenter, true)
    presenter.once('ready-to-show', () => {
      this.presenterReady = true
      if (this.isPresenter) this.showPresenter()
    })
    this.guardWindow(presenter)
    presenter.on('move', () => { this.persistBounds(presenter); this.pushGlassDisplay() })
    presenter.on('resize', () => { this.persistBounds(presenter); this.notifySurfaceRestored(presenter) })
    presenter.on('restore', () => this.notifySurfaceRestored(presenter))
    this.registerGlassCapture(presenter)
    load(presenter, 'presenter')
    return presenter
  }

  setClickThrough(enabled: boolean): void {
    if (enabled && !this.isRecoveryRegistered()) {
      this.applyClickThrough(false)
      throw new Error(`Click-through requires the ${CLICK_THROUGH_RECOVERY_SHORTCUT} recovery shortcut.`)
    }
    if (enabled && !this.isPresenter) throw new Error('Enter presenter mode before enabling click-through.')
    this.applyClickThrough(enabled)
  }
  get workspaceStatus(): WorkspaceStatus { return { ...this.workspace } }
  get isPresenter(): boolean { return this.workspace.mode === 'presenter' }
  enterPresenter(): void {
    if (this.isPresenter) return
    const presenter = this.createPresenter()
    const setup = this.setupWindow
    const setupBounds = setup && !setup.isDestroyed() ? setup.getBounds() : this.defaultBounds()
    clearTimeout(this.boundsTimer)
    void this.store.setWindowBounds(setupBounds)
    this.capture.setEnabled(presenter, true)
    if (!this.capture.status(presenter).electronReported) {
      this.workspace = { ...this.workspace, error: 'Windows capture protection could not be enabled. Presenter mode was not opened.' }
      this.onWorkspaceStatusChange?.()
      throw new Error(this.workspace.error)
    }
    this.setClickThrough(false)
    const saved = this.store.presenterLayout
    const area = screen.getDisplayMatching(setupBounds).workArea
    presenter.setBounds(presenterBounds({ x: saved?.x ?? setupBounds.x, y: saved?.y ?? setupBounds.y, width: saved?.width ?? 860, height: this.presenterHeight }, area))
    this.workspace = { mode: 'presenter' }
    this.registerPresenterShortcuts()
    setup?.hide()
    this.onWorkspaceStatusChange?.()
    if (this.presenterReady) this.showPresenter()
  }
  requestSetup(section: NonNullable<WorkspaceStatus['setupRequest']> = 'settings'): void {
    this.emergencyUnlock()
    this.workspace = { ...this.workspace, setupRequest: section }
    this.onWorkspaceStatusChange?.()
    if (this.isPresenter) { this.showPresenter(); return }
    this.showSetup()
    this.setupWindow?.webContents.send(section === 'privacy' ? channels.openPrivacy : channels.openSettings)
  }
  dismissSetupRequest(): void { this.workspace = { ...this.workspace, setupRequest: undefined }; this.onWorkspaceStatusChange?.() }
  confirmSetup(): void {
    if (!this.isPresenter || !this.workspace.setupRequest) throw new Error('No pending Setup confirmation.')
    const presenter = this.presenterWindow
    clearTimeout(this.boundsTimer)
    if (presenter && !presenter.isDestroyed()) {
      const { x, y, width } = presenter.getBounds()
      void this.store.setPresenterLayout({ x, y, width })
    }
    this.setClickThrough(false)
    presenter?.hide()
    this.unregisterPresenterShortcuts()
    this.workspace = { ...this.workspace, mode: 'setup', error: undefined }
    const setup = this.setupWindow ?? this.create()
    // A capture-compatibility test may have protected Setup; Setup is never stealth.
    this.capture.setEnabled(setup, false)
    this.onWorkspaceStatusChange?.()
    this.showSetup()
  }
  resizePresenter(height: number): void {
    if (!Number.isFinite(height) || height < 80 || height > 100_000) throw new Error('Invalid presenter content height.')
    const presenter = this.presenterWindow
    const zoom = presenter?.webContents.getZoomFactor?.() ?? 1
    this.presenterHeight = Math.ceil(height)
    if (!presenter || presenter.isDestroyed()) return
    const current = presenter.getBounds()
    const next = presenterBounds({ ...current, height: Math.ceil(this.presenterHeight * zoom) }, screen.getDisplayMatching(current).workArea)
    if (next.height === current.height && next.y === current.y) return
    this.animateBounds(presenter, current, next)
  }
  /** Eases height changes (folding, new answers) instead of jumping. */
  private animateBounds(window: BrowserWindow, from: OverlayBounds, to: OverlayBounds): void {
    clearInterval(this.resizeTween)
    const apply = (bounds: OverlayBounds): void => {
      if (window.isDestroyed()) { clearInterval(this.resizeTween); return }
      this.resizingContent = true
      try { window.setBounds(bounds) } finally { this.resizingContent = false }
    }
    if (!window.isVisible()) { apply(to); return }
    const started = Date.now()
    const step = (): void => {
      const progress = Math.min(1, (Date.now() - started) / RESIZE_ANIMATION_MS)
      const eased = 1 - (1 - progress) ** 3
      apply({ ...to, y: Math.round(from.y + (to.y - from.y) * eased), height: Math.round(from.height + (to.height - from.height) * eased) })
      if (progress >= 1) clearInterval(this.resizeTween)
    }
    this.resizeTween = setInterval(step, 16)
    step()
  }
  /** Text size applies to both windows; the presenter re-fits its height. */
  applyFontScale(scale: number): void {
    for (const item of this.windows) item.webContents.setZoomFactor(scale)
    this.resizePresenter(this.presenterHeight)
  }
  focusAsk(): void {
    if (!this.isPresenter) { this.showSetup(); return }
    this.showPresenter()
    this.presenterWindow?.webContents.send(channels.focusAsk)
  }
  openSettings(): void { this.requestSetup('settings') }
  openPrivacy(): void { this.requestSetup('privacy') }
  showTransmissionPreview(): void {
    if (this.isPresenter) { this.showPresenterInactive(); return }
    const setup = this.setupWindow
    if (!setup || setup.isDestroyed()) return
    setup.showInactive()
    this.notifySurfaceRestored(setup)
  }
  get hasTray(): boolean { return Boolean(this.tray) }
  get isClickThrough(): boolean { return this.clickThrough }
  get clickThroughStatus(): WindowClickThroughStatus {
    return {
      enabled: this.clickThrough,
      recoveryShortcut: CLICK_THROUGH_RECOVERY_SHORTCUT,
      recoveryAvailable: this.isRecoveryRegistered()
    }
  }
  toggleVisibility(): void {
    const window = this.window
    if (window && !window.isDestroyed() && window.isVisible()) window.hide()
    else this.showTransmissionPreview()
  }
  emergencyUnlock(): void { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }).catch(() => undefined) }
  showFromTray(): void { this.emergencyUnlock(); if (this.isPresenter) this.showPresenter(); else this.showSetup() }
  openSettingsFromTray(): void { this.emergencyUnlock(); this.openSettings() }
  prepareToQuit(): void { this.quitting = true; clearTimeout(this.boundsTimer); clearTimeout(this.glassTimer); clearInterval(this.resizeTween); this.unregisterPresenterShortcuts() }

  /** Presenter controls work without clicking, so no cursor moves across a shared screen. */
  private registerPresenterShortcuts(): void {
    const failed: string[] = []
    for (const { accelerator, command, keys } of PRESENTER_SHORTCUTS) {
      if (this.presenterShortcutsRegistered.has(accelerator)) continue
      const registered = globalShortcut.register(accelerator, () => this.presenterWindow?.webContents.send(channels.presenterCommand, command))
      if (registered) this.presenterShortcutsRegistered.add(accelerator)
      else failed.push(keys)
    }
    this.shortcutWarnings = this.shortcutWarnings.filter((warning) => !warning.startsWith(PRESENTER_SHORTCUT_WARNING))
    if (failed.length) this.shortcutWarnings.push(`${PRESENTER_SHORTCUT_WARNING} ${failed.join(', ')}. Another app is using them.`)
  }
  private unregisterPresenterShortcuts(): void {
    for (const accelerator of this.presenterShortcutsRegistered) globalShortcut.unregister(accelerator)
    this.presenterShortcutsRegistered.clear()
    this.shortcutWarnings = this.shortcutWarnings.filter((warning) => !warning.startsWith(PRESENTER_SHORTCUT_WARNING))
  }

  /** Display (DIP) behind the presenter; the glass backdrop captures only this screen. */
  get glassDisplay(): GlassDisplay {
    const presenter = this.presenterWindow
    const display = presenter && !presenter.isDestroyed() ? screen.getDisplayMatching(presenter.getBounds()) : screen.getPrimaryDisplay()
    return { ...display.bounds }
  }

  private showSetup(): void {
    const setup = this.setupWindow && !this.setupWindow.isDestroyed() ? this.setupWindow : this.create()
    setup.show()
    setup.focus()
    this.notifySurfaceRestored(setup)
  }
  /** Fail closed: the presenter never appears without requested protection. */
  private presenterShowable(): BrowserWindow | undefined {
    const presenter = this.presenterWindow
    if (!presenter || presenter.isDestroyed() || !this.isPresenter || !this.presenterReady) return undefined
    if (this.capture.status(presenter).electronReported) return presenter
    this.workspace = { ...this.workspace, error: 'Capture protection was lost. The presenter window remains hidden.' }
    this.onWorkspaceStatusChange?.()
    return undefined
  }
  private showPresenter(): void {
    const presenter = this.presenterShowable()
    if (!presenter) return
    presenter.show()
    // The screen-saver level stays above fullscreen presentation windows.
    presenter.setAlwaysOnTop(true, 'screen-saver')
    presenter.focus()
    this.pushGlassDisplay(true)
    this.notifySurfaceRestored(presenter)
  }
  private showPresenterInactive(): void {
    const presenter = this.presenterShowable()
    if (!presenter) return
    presenter.showInactive()
    presenter.setAlwaysOnTop(true, 'screen-saver')
    this.notifySurfaceRestored(presenter)
  }
  private guardWindow(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => {
      if (window === this.setupWindow) { this.setupWindow = undefined; this.unregisterDisplayListeners() }
      if (window === this.presenterWindow) this.presenterWindow = undefined
    })
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.onEscape?.()) event.preventDefault()
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
  }
  /**
   * Grants the presenter's own screen to its liquid-glass backdrop. Capture
   * protection keeps the presenter itself out of the stream, frames never
   * leave the renderer, and any other requester is denied.
   */
  private registerGlassCapture(presenter: BrowserWindow): void {
    presenter.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const target = this.presenterWindow
      const allowed = Boolean(target && !target.isDestroyed() && request.frame === target.webContents.mainFrame &&
        this.isPresenter && this.store.settings.liveGlass && !request.audioRequested)
      if (!allowed || !target) { callback({}); return }
      const displayId = String(screen.getDisplayMatching(target.getBounds()).id)
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => { const source = sources.find((item) => item.display_id === displayId); callback(source ? { video: source } : {}) })
        .catch(() => callback({}))
    })
  }
  /** Windows emits thousands of move events while dragging; only display changes matter here. */
  private pushGlassDisplay(force = false): void {
    if (this.glassTimer && !force) return
    clearTimeout(this.glassTimer)
    this.glassTimer = setTimeout(() => {
      this.glassTimer = undefined
      const presenter = this.presenterWindow
      if (!presenter || presenter.isDestroyed()) return
      const display = screen.getDisplayMatching(presenter.getBounds())
      if (!force && display.id === this.glassDisplayId) return
      this.glassDisplayId = display.id
      presenter.webContents.send(channels.glassDisplay, { ...display.bounds })
    }, force ? 0 : 100)
  }

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
    const presenterWarnings = this.shortcutWarnings.filter((warning) => warning.startsWith(PRESENTER_SHORTCUT_WARNING))
    this.shortcutWarnings = [...recoveryWarnings, ...attemptedWarnings, ...presenterWarnings]
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

  /**
   * Ctrl+Shift+I turns click-through off immediately and unconditionally, or
   * on while presenting. The same key always turns it off again.
   */
  private toggleClickThroughFromShortcut(): void {
    if (this.clickThrough || !this.isPresenter || !this.onEnableClickThrough) { this.emergencyUnlock(); return }
    this.onEnableClickThrough()
  }
  private ensureRecoveryShortcut(): boolean {
    if (this.isRecoveryRegistered()) return true
    this.recoveryShortcutRegistered = false
    if (globalShortcut.register(CLICK_THROUGH_RECOVERY_SHORTCUT, () => this.toggleClickThroughFromShortcut())) {
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
    this.presenterWindow?.setIgnoreMouseEvents(enabled, { forward: true })
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
  private persistBounds(window: BrowserWindow): void {
    if (this.resizingContent || this.quitting) return
    clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => {
      if (window.isDestroyed() || !window.isVisible()) return
      const bounds = window.getBounds()
      if (window === this.presenterWindow) { const { x, y, width } = bounds; void this.store.setPresenterLayout({ x, y, width }); this.resizePresenter(this.presenterHeight) }
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
