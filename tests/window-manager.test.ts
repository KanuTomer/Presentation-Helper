import { beforeEach, describe, expect, it, vi } from 'vitest'

const { register, unregister } = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class {},
  app: { quit: vi.fn() },
  globalShortcut: { register, unregister },
  nativeImage: { createFromDataURL: vi.fn() },
  screen: { getAllDisplays: vi.fn(() => []), getPrimaryDisplay: vi.fn() }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

describe('window recovery shortcuts', () => {
  beforeEach(() => { register.mockReset(); unregister.mockReset() })

  it('disables and persists click-through when the emergency shortcut cannot register', async () => {
    register.mockImplementation((accelerator: string) => accelerator !== 'Control+Shift+I')
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)
    windows.setClickThrough(true)

    expect(windows.registerShortcuts()).toBe(false)
    expect(windows.isClickThrough).toBe(false)
    expect(windows.shortcutWarnings).toContain('Could not register Control+Shift+I. Click-through was disabled for safety.')
    expect(updateSettings).toHaveBeenCalledWith({ clickThrough: false })
  })

  it('makes Privacy interactive before showing a consent-required acknowledgement', async () => {
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)
    const fakeWindow = {
      isDestroyed: () => false,
      setIgnoreMouseEvents: vi.fn(),
      show: vi.fn(), focus: vi.fn(),
      webContents: { send: vi.fn() }
    }
    windows.window = fakeWindow as never
    windows.setClickThrough(true)

    windows.openPrivacy()

    expect(windows.isClickThrough).toBe(false)
    expect(fakeWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(updateSettings).toHaveBeenCalledWith({ clickThrough: false })
    expect(fakeWindow.show).toHaveBeenCalledOnce()
    expect(fakeWindow.focus).toHaveBeenCalledOnce()
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('ui:open-privacy')
  })
})
