import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowConstructor, getAllDisplays, getDisplayMatching, getDisplayNearestPoint, getPrimaryDisplay,
  register, unregister
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  getAllDisplays: vi.fn(),
  getDisplayMatching: vi.fn(),
  getDisplayNearestPoint: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: browserWindowConstructor,
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class {},
  app: { quit: vi.fn() },
  globalShortcut: { register, unregister },
  nativeImage: { createFromDataURL: vi.fn() },
  screen: { getAllDisplays, getDisplayMatching, getDisplayNearestPoint, getPrimaryDisplay }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

describe('window recovery shortcuts', () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset()
    register.mockReset()
    register.mockReturnValue(true)
    unregister.mockReset()
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    getAllDisplays.mockReset()
    getAllDisplays.mockReturnValue([display])
    getDisplayMatching.mockReset()
    getDisplayMatching.mockReturnValue(display)
    getDisplayNearestPoint.mockReset()
    getDisplayNearestPoint.mockReturnValue(display)
    getPrimaryDisplay.mockReset()
    getPrimaryDisplay.mockReturnValue(display)
  })

  it('fails closed when click-through is enabled without a registered recovery shortcut', async () => {
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)
    const setIgnoreMouseEvents = vi.fn()
    windows.window = { setIgnoreMouseEvents } as never

    expect(() => windows.setClickThrough(true)).toThrow(/Control\+Shift\+I/)
    expect(windows.clickThroughStatus).toEqual({
      enabled: false,
      recoveryShortcut: 'Control+Shift+I',
      recoveryAvailable: false
    })
    expect(setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true })
  })

  it('disables and persists click-through when the emergency shortcut cannot register', async () => {
    register.mockImplementation((accelerator: string) => accelerator !== 'Control+Shift+I')
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)

    expect(windows.registerShortcuts()).toBe(false)
    expect(windows.isClickThrough).toBe(false)
    expect(windows.shortcutWarnings).toContain('Could not register Control+Shift+I. Click-through was disabled for safety.')
    expect(updateSettings).toHaveBeenCalledWith({ clickThrough: false })
  })

  it('enables only after recovery registration and notifies every state transition', async () => {
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings: vi.fn(async () => undefined)
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)
    const setIgnoreMouseEvents = vi.fn()
    windows.window = { setIgnoreMouseEvents } as never
    const statuses: unknown[] = []
    windows.onClickThroughStatusChange = (status) => statuses.push(status)

    expect(windows.registerShortcuts()).toBe(true)
    windows.setClickThrough(true)
    windows.emergencyUnlock()

    expect(statuses).toEqual([
      { enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true },
      { enabled: true, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true },
      { enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }
    ])
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, true, { forward: true })
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, false, { forward: true })
  })

  it('does not register the fixed recovery shortcut more than once', async () => {
    const store = {
      settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' },
      updateSettings: vi.fn(async () => undefined)
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)

    expect(windows.registerShortcuts()).toBe(true)
    expect(windows.registerShortcuts()).toBe(true)

    expect(register.mock.calls.filter(([shortcut]) => shortcut === 'Control+Shift+I')).toHaveLength(1)
    expect(unregister).not.toHaveBeenCalledWith('Control+Shift+I')
  })

  it('registers recovery before refusing an unsafe persisted click-through state at startup', async () => {
    register.mockImplementation((accelerator: string) => accelerator !== 'Control+Shift+I')
    const setIgnoreMouseEvents = vi.fn()
    const fakeWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 100, y: 100, width: 1100, height: 720 }),
      setShape: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setIgnoreMouseEvents,
      once: vi.fn(),
      on: vi.fn(),
      loadFile: vi.fn(),
      webContents: {
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn()
      }
    }
    browserWindowConstructor.mockImplementation(function BrowserWindowMock() { return fakeWindow })
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      windowLayoutRevision: 999,
      windowBounds: { x: 100, y: 100, width: 1100, height: 720 },
      settings: {
        neonIntensity: 0.65,
        clickThrough: true,
        askShortcut: 'Control+Space',
        hideShortcut: 'Control+Shift+H'
      },
      updateSettings,
      setWindowBounds: vi.fn(async () => undefined),
      setWindowLayout: vi.fn(async () => undefined)
    }
    const capture = { setEnabled: vi.fn() }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, capture as never)
    ;(windows as unknown as { tray: unknown }).tray = {}

    windows.create()

    expect(browserWindowConstructor).toHaveBeenCalledWith(expect.objectContaining({
      backgroundMaterial: 'acrylic',
      roundedCorners: true,
      hasShadow: false
    }))
    const recoveryAttempt = register.mock.invocationCallOrder[
      register.mock.calls.findIndex(([shortcut]) => shortcut === 'Control+Shift+I')
    ]
    const firstWindowState = setIgnoreMouseEvents.mock.invocationCallOrder[0]
    expect(recoveryAttempt).toBeLessThan(firstWindowState)
    expect(setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, expect.anything())
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(updateSettings).toHaveBeenCalledWith({ clickThrough: false })
  })

  it('falls back to the shader-only transparent window when Acrylic creation is rejected', async () => {
    const fakeWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 100, y: 100, width: 1100, height: 720 }),
      setShape: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      loadFile: vi.fn(),
      webContents: {
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn()
      }
    }
    browserWindowConstructor
      .mockImplementationOnce(function AcrylicWindowMock() {
        throw new Error('Backdrop unavailable under this Windows policy.')
      })
      .mockImplementationOnce(function TransparentWindowMock() {
        return fakeWindow
      })
    const store = {
      windowLayoutRevision: 999,
      windowBounds: { x: 100, y: 100, width: 1100, height: 720 },
      settings: {
        neonIntensity: 0.65, clickThrough: false,
        askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H'
      },
      updateSettings: vi.fn(async () => undefined),
      setWindowBounds: vi.fn(async () => undefined),
      setWindowLayout: vi.fn(async () => undefined)
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, { setEnabled: vi.fn() } as never)
    ;(windows as unknown as { tray: unknown }).tray = {}

    expect(windows.create()).toBe(fakeWindow)
    expect(browserWindowConstructor).toHaveBeenCalledTimes(2)
    expect(browserWindowConstructor.mock.calls[0]?.[0]).toMatchObject({ backgroundMaterial: 'acrylic' })
    expect(browserWindowConstructor.mock.calls[1]?.[0]).not.toHaveProperty('backgroundMaterial')
  })

  it('never restores persisted click-through without a fresh user confirmation', async () => {
    const setIgnoreMouseEvents = vi.fn()
    const fakeWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 100, y: 100, width: 1100, height: 720 }),
      setShape: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setIgnoreMouseEvents,
      once: vi.fn(),
      on: vi.fn(),
      loadFile: vi.fn(),
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn()
      }
    }
    browserWindowConstructor.mockImplementation(function BrowserWindowMock() { return fakeWindow })
    const updateSettings = vi.fn(async () => undefined)
    const store = {
      windowLayoutRevision: 999,
      windowBounds: { x: 100, y: 100, width: 1100, height: 720 },
      settings: {
        neonIntensity: 0.65,
        clickThrough: true,
        askShortcut: 'Control+Space',
        hideShortcut: 'Control+Shift+H'
      },
      updateSettings,
      setWindowBounds: vi.fn(async () => undefined),
      setWindowLayout: vi.fn(async () => undefined)
    }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, { setEnabled: vi.fn() } as never)
    ;(windows as unknown as { tray: unknown }).tray = {}

    windows.create()

    expect(windows.clickThroughStatus).toMatchObject({ enabled: false, recoveryAvailable: true })
    expect(setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, expect.anything())
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
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
    expect(windows.registerShortcuts()).toBe(true)
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

})

describe('wide overlay bounds', () => {
  it('requests Acrylic only on supported Windows builds so the shader remains the fallback', async () => {
    const { supportsWindowsAcrylic } = await import('../src/main/windows/windowManager')
    expect(supportsWindowsAcrylic('win32', '10.0.22621')).toBe(true)
    expect(supportsWindowsAcrylic('win32', '10.0.22000')).toBe(false)
    expect(supportsWindowsAcrylic('linux', '6.8.0')).toBe(false)
    expect(supportsWindowsAcrylic('win32', 'invalid')).toBe(false)
  })

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

  it('builds a symmetric rounded region without leaving native material in the corners', async () => {
    const { roundedWindowShape } = await import('../src/main/windows/windowManager')
    const shape = roundedWindowShape(680, 420, 24)
    expect(shape[0]).toMatchObject({ y: 0 })
    expect(shape[0]!.x).toBeGreaterThan(0)
    expect(shape.at(-1)).toMatchObject({ y: expect.any(Number) })
    expect(shape.at(-1)!.x).toBe(shape[0]!.x)
    expect(shape.some((rect) => rect.x === 0 && rect.width === 680)).toBe(true)
    expect(shape.reduce((height, rect) => height + rect.height, 0)).toBe(420)
  })
})
