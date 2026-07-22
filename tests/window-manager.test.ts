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
      show: vi.fn(), focus: vi.fn(), setAlwaysOnTop: vi.fn(),
      webContents: { send: vi.fn() }
    }
    windows.window = fakeWindow as never
    windows.setClickThrough(true)

    windows.openPrivacy()

    expect(windows.isClickThrough).toBe(false)
    expect(fakeWindow.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(updateSettings).toHaveBeenCalledWith({ clickThrough: false })
    expect(fakeWindow.show).toHaveBeenCalledOnce()
    expect(fakeWindow.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(fakeWindow.focus).toHaveBeenCalledOnce()
    expect(fakeWindow.webContents.send).toHaveBeenCalledWith('ui:open-privacy')
  })

  it('applies opacity to renderer glass surfaces instead of fading the native window', async () => {
    const insertCSS = vi.fn(async () => 'glass-css')
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        insertCSS,
        removeInsertedCSS: vi.fn(async () => undefined)
      }
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager({} as never, {} as never)
    windows.window = fakeWindow as never

    windows.setOpacity(0.1)

    await vi.waitFor(() => expect(insertCSS).toHaveBeenCalledWith(':root { --glass-opacity: 0.45; }'))
    expect(fakeWindow).not.toHaveProperty('setOpacity')
  })

})

describe('wide overlay bounds', () => {
  it('centres a fresh 1100 by 720 overlay inside the work area', async () => {
    const { defaultOverlayBounds } = await import('../src/main/windows/windowManager')
    expect(defaultOverlayBounds({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 410, y: 180, width: 1100, height: 720
    })
  })

  it('expands legacy narrow bounds once while retaining their centre and monitor coordinates', async () => {
    const { migrateLegacyOverlayBounds } = await import('../src/main/windows/windowManager')
    const migrated = migrateLegacyOverlayBounds(
      { x: 2400, y: 120, width: 560, height: 700 },
      { x: 1920, y: 0, width: 1920, height: 1080 }
    )
    expect(migrated).toEqual({ x: 2130, y: 120, width: 1100, height: 700 })
    expect(migrated.x + migrated.width / 2).toBe(2400 + 560 / 2)
  })

  it('clamps bounds with a sixteen-pixel margin without widening a later user resize', async () => {
    const { clampOverlayBounds } = await import('../src/main/windows/windowManager')
    expect(clampOverlayBounds(
      { x: -1_000, y: 2_000, width: 760, height: 500 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    )).toEqual({ x: 16, y: 564, width: 760, height: 500 })
  })
})
