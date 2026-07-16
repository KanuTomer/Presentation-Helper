import { BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { channels } from '../../shared/channels.js'
import type { SettingsStore } from '../settings/store.js'
import type { CaptureProtection } from './captureProtection.js'

export class WindowManager {
  window?: BrowserWindow
  private tray?: Tray
  shortcutWarnings: string[] = []
  private registeredShortcuts = new Set<string>()
  private boundsTimer?: NodeJS.Timeout
  private clickThrough = false
  private quitting = false
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const initialBounds = this.validBounds(this.store.windowBounds) ?? this.defaultBounds()
    this.window = new BrowserWindow({
      ...initialBounds,
      minWidth: 380, minHeight: 300, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, movable: true, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.window.setOpacity(this.store.settings.opacity)
    this.clickThrough = this.store.settings.clickThrough
    this.window.setIgnoreMouseEvents(this.clickThrough, { forward: true })
    this.capture.setEnabled(this.window, true)
    this.window.once('ready-to-show', () => {
      if (!this.window) return
      this.window.showInactive()
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
  setOpacity(value: number): void { this.window?.setOpacity(Math.min(1, Math.max(0.45, value))) }
  focusAsk(): void { const window = this.ensureWindow(); window.show(); window.focus(); window.webContents.send(channels.focusAsk) }
  openSettings(): void { const window = this.ensureWindow(); window.show(); window.focus(); window.webContents.send(channels.openSettings) }
  openPrivacy(): void {
    this.emergencyUnlock()
    const window = this.ensureWindow()
    window.show()
    window.focus()
    window.webContents.send(channels.openPrivacy)
  }
  showTransmissionPreview(): void { this.ensureWindow().showInactive() }
  get hasTray(): boolean { return Boolean(this.tray) }
  get isClickThrough(): boolean { return this.clickThrough }
  toggleVisibility(): void { const window = this.ensureWindow(); window.isVisible() ? window.hide() : window.showInactive() }
  emergencyUnlock(): void { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }) }
  showFromTray(): void { this.emergencyUnlock(); const window = this.ensureWindow(); window.show(); window.focus() }
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
  private validBounds(bounds?: { x: number; y: number; width: number; height: number }) {
    if (!bounds) return undefined
    const displays = screen.getAllDisplays()
    if (displays.length === 0) return undefined
    const intersects = displays.some(({ workArea }) => bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x && bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y)
    const display = intersects
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    const area = display.workArea
    // Leave room for the DWM shadow that Windows can add to transparent,
    // frameless windows after BrowserWindow has applied the requested bounds.
    const edgeMargin = 16
    const horizontalMargin = area.width >= 380 + edgeMargin * 2 ? edgeMargin : 0
    const verticalMargin = area.height >= 300 + edgeMargin * 2 ? edgeMargin : 0
    const width = Math.min(Math.max(380, bounds.width), area.width - horizontalMargin * 2)
    const height = Math.min(Math.max(300, bounds.height), area.height - verticalMargin * 2)
    return {
      x: Math.min(Math.max(bounds.x, area.x + horizontalMargin), area.x + area.width - horizontalMargin - width),
      y: Math.min(Math.max(bounds.y, area.y + verticalMargin), area.y + area.height - verticalMargin - height),
      width,
      height
    }
  }

  private defaultBounds(): { x: number; y: number; width: number; height: number } {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(560, area.width)
    const height = Math.min(720, area.height)
    return {
      x: area.x + Math.max(0, Math.floor((area.width - width) / 2)),
      y: area.y + Math.max(0, Math.floor((area.height - height) / 2)),
      width,
      height
    }
  }

  private ensureWindow(): BrowserWindow { return this.window && !this.window.isDestroyed() ? this.window : this.create() }
}
