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
  private boundsTimer?: NodeJS.Timeout
  constructor(private store: SettingsStore, private capture: CaptureProtection) {}

  create(): BrowserWindow {
    const saved = this.validBounds(this.store.windowBounds)
    this.window = new BrowserWindow({
      width: saved?.width ?? 560, height: saved?.height ?? 720, x: saved?.x, y: saved?.y,
      minWidth: 380, minHeight: 300, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, movable: true, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.window.setOpacity(this.store.settings.opacity)
    this.window.setIgnoreMouseEvents(this.store.settings.clickThrough, { forward: true })
    this.capture.enable(this.window)
    this.window.once('ready-to-show', () => this.window?.showInactive())
    this.window.on('move', () => this.persistBounds()); this.window.on('resize', () => this.persistBounds())
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    if (is.dev && process.env.ELECTRON_RENDERER_URL) this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else this.window.loadFile(join(__dirname, '../renderer/index.html'))
    this.createTray(); this.registerShortcuts()
    return this.window
  }

  setClickThrough(enabled: boolean): void { this.window?.setIgnoreMouseEvents(enabled, { forward: true }) }
  setOpacity(value: number): void { this.window?.setOpacity(Math.min(1, Math.max(0.45, value))) }
  focusAsk(): void { this.window?.show(); this.window?.focus(); this.window?.webContents.send(channels.focusAsk) }
  openSettings(): void { this.window?.show(); this.window?.focus(); this.window?.webContents.send(channels.openSettings) }

  registerShortcuts(): boolean {
    globalShortcut.unregisterAll(); this.shortcutWarnings = []
    const register = (shortcut: string, action: () => void): void => {
      if (!globalShortcut.register(shortcut, action)) this.shortcutWarnings.push(`Could not register ${shortcut}. Choose another shortcut in Settings.`)
    }
    register(this.store.settings.askShortcut, () => this.focusAsk())
    register(this.store.settings.hideShortcut, () => this.window?.isVisible() ? this.window.hide() : this.window?.showInactive())
    register('Control+Shift+I', () => { this.setClickThrough(false); void this.store.updateSettings({ clickThrough: false }) })
    return this.shortcutWarnings.length === 0
  }

  private createTray(): void {
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#6366f1"/><text x="16" y="23" text-anchor="middle" font-family="Segoe UI" font-size="21" font-weight="700" fill="white">P</text></svg>').toString('base64')}`)
    this.tray = new Tray(icon)
    this.tray.setToolTip('PresenterAI')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show PresenterAI', click: () => this.window?.show() },
      { label: 'Settings', click: () => this.openSettings() },
      { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
    ]))
  }
  private persistBounds(): void { clearTimeout(this.boundsTimer); this.boundsTimer = setTimeout(() => { if (this.window) void this.store.setWindowBounds(this.window.getBounds()) }, 250) }
  private validBounds(bounds?: { x: number; y: number; width: number; height: number }) {
    if (!bounds) return undefined
    const visible = screen.getAllDisplays().some(({ workArea }) => bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x && bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y)
    return visible ? bounds : undefined
  }
}
