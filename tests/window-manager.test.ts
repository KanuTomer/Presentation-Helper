import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowConstructor, getAllDisplays, getDisplayMatching, getDisplayNearestPoint, getPrimaryDisplay,
  register, unregister, screenOn, screenRemoveListener, registered
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  getAllDisplays: vi.fn(),
  getDisplayMatching: vi.fn(),
  getDisplayNearestPoint: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  register: vi.fn(),
  registered: new Set<string>(),
  unregister: vi.fn(),
  screenOn: vi.fn(),
  screenRemoveListener: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: browserWindowConstructor,
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class {},
  app: { quit: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  nativeTheme: {},
  globalShortcut: { register: (key: string, action: () => void) => { const ok = register(key, action); if (ok) registered.add(key); return ok }, unregister: (key: string) => { registered.delete(key); unregister(key) }, isRegistered: (key: string) => registered.has(key) },
  nativeImage: { createFromDataURL: vi.fn() },
  screen: {
    getAllDisplays, getDisplayMatching, getDisplayNearestPoint, getPrimaryDisplay,
    on: screenOn, removeListener: screenRemoveListener
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

describe('window recovery shortcuts', () => {
  it('rechecks lost emergency registration instead of trusting a cached success', async () => {
    const store = { settings: { askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H' }, updateSettings: vi.fn(async () => undefined) }
    const { WindowManager } = await import('../src/main/windows/windowManager')
    const windows = new WindowManager(store as never, {} as never)
    expect(windows.registerShortcuts()).toBe(true)
    registered.delete('Control+Shift+I')
    expect(windows.clickThroughStatus.recoveryAvailable).toBe(false)
    expect(() => windows.setClickThrough(true)).toThrow(/recovery shortcut/)
    expect(windows.shortcutRegistrations.find((item) => item.purpose === 'recovery')?.status).toBe('unavailable')
    expect(windows.registerShortcuts()).toBe(true)
    expect(windows.clickThroughStatus.recoveryAvailable).toBe(true)
  })
  beforeEach(() => {
    browserWindowConstructor.mockReset()
    register.mockReset()
    registered.clear()
    register.mockReturnValue(true)
    unregister.mockReset()
    screenOn.mockReset()
    screenRemoveListener.mockReset()
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
    windows.presenterWindow = { setIgnoreMouseEvents } as never

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
    windows.presenterWindow = { setIgnoreMouseEvents } as never
    const statuses: unknown[] = []
    windows.onClickThroughStatusChange = (status) => statuses.push(status)

    expect(windows.registerShortcuts()).toBe(true)
    ;(windows as unknown as { workspace: unknown }).workspace = { mode: 'presenter' }
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
    const { windows, created, store } = await created2({ clickThrough: true })
    windows.create()
    const presenter = created[1]!
    const recoveryAttempt = register.mock.invocationCallOrder[register.mock.calls.findIndex(([shortcut]) => shortcut === 'Control+Shift+I')]
    expect(recoveryAttempt).toBeLessThan(presenter.loadFile.mock.invocationCallOrder[0]!)
    expect(presenter.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, expect.anything())
    expect(store.updateSettings).toHaveBeenCalledWith({ clickThrough: false })
  })

  it('never restores persisted click-through without a fresh user confirmation', async () => {
    const { windows, store } = await created2({ clickThrough: true })
    windows.create()
    expect(windows.clickThroughStatus).toMatchObject({ enabled: false, recoveryAvailable: true })
    expect(store.updateSettings).toHaveBeenCalledWith({ clickThrough: false })
  })

  it('creates an ordinary Setup window and a hidden, protected, frameless presenter', async () => {
    const { windows, created, capture } = await created2()
    windows.create()
    expect(created).toHaveLength(2)
    const [setup, presenter] = created
    expect(setup!.options).toMatchObject({ show: false, title: 'PresenterAI' })
    expect(setup!.options).not.toHaveProperty('frame')
    expect(setup!.options).not.toHaveProperty('transparent')
    expect(presenter!.options).toMatchObject({ frame: false, transparent: false, backgroundMaterial: 'acrylic', skipTaskbar: true, alwaysOnTop: true, show: false })
    expect(capture.setEnabled).toHaveBeenCalledWith(presenter, true)
    expect(capture.setEnabled).toHaveBeenCalledWith(setup, false)
    // Protection is requested before the presenter loads any content.
    const protectCall = capture.setEnabled.mock.calls.findIndex(([window, enabled]) => window === presenter && enabled)
    expect(capture.setEnabled.mock.invocationCallOrder[protectCall]).toBeLessThan(presenter!.loadFile.mock.invocationCallOrder[0]!)
    expect(presenter!.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { view: 'presenter' } })
    expect(setup!.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { view: 'setup' } })
  })

  it('requests protected confirmation before opening Privacy from presenter mode', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    presenter!.fire('ready-to-show')
    windows.enterPresenter()
    windows.setClickThrough(true)
    presenter!.show.mockClear()

    windows.openPrivacy()

    expect(windows.isClickThrough).toBe(false)
    expect(presenter!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(presenter!.show).toHaveBeenCalledOnce()
    expect(presenter!.webContents.send).not.toHaveBeenCalledWith('ui:open-privacy')
    expect(windows.workspaceStatus).toMatchObject({ mode: 'presenter', setupRequest: 'privacy' })
  })
})

interface FakeWindow {
  options: Record<string, unknown>
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  handlers: Map<string, Array<() => void>>
  fire(event: string): void
  [key: string]: unknown
  show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>; loadFile: ReturnType<typeof vi.fn>; setAlwaysOnTop: ReturnType<typeof vi.fn>
  webContents: { send: ReturnType<typeof vi.fn>; [key: string]: unknown }
}

/** Builds a WindowManager whose BrowserWindow constructor records each window it creates. */
async function created2(settings: Record<string, unknown> = {}, protectionWorks = true) {
  const created: FakeWindow[] = []
  browserWindowConstructor.mockImplementation(function FakeBrowserWindow(options: Record<string, unknown>) {
    const handlers = new Map<string, Array<() => void>>()
    const window: FakeWindow = {
      options,
      visible: false, bounds: { x: 100, y: 100, width: Number(options.width ?? 1100), height: Number(options.height ?? 720) }, handlers,
      fire: (event: string) => handlers.get(event)?.forEach((handler) => handler()),
      isDestroyed: () => false, isVisible: () => window.visible,
      getBounds: () => window.bounds, setBounds: vi.fn((value) => { window.bounds = value }),
      show: vi.fn(() => { window.visible = true }), showInactive: vi.fn(() => { window.visible = true }),
      hide: vi.fn(() => { window.visible = false }), focus: vi.fn(), setMenu: vi.fn(),
      setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents: vi.fn(), loadFile: vi.fn(async () => undefined),
      once: vi.fn((event: string, handler: () => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
      webContents: {
        send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn(), getZoomFactor: () => 1,
        mainFrame: {}, session: { setDisplayMediaRequestHandler: vi.fn() }
      }
    }
    created.push(window)
    return window
  })
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const display = { id: 1, bounds: area, workArea: area }
  getDisplayMatching.mockReturnValue(display); getPrimaryDisplay.mockReturnValue(display); getAllDisplays.mockReturnValue([display])
  const protectedWindows = new Set<unknown>()
  const capture = {
    setEnabled: vi.fn((window: unknown, enabled: boolean) => { if (enabled && protectionWorks) protectedWindows.add(window); else protectedWindows.delete(window) }),
    status: (window?: unknown) => ({ electronReported: protectedWindows.has(window) })
  }
  const store = {
    windowLayoutRevision: 999, windowBounds: { x: 100, y: 100, width: 1100, height: 720 }, presenterLayout: undefined,
    settings: { clickThrough: false, askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', liveGlass: true, ...settings },
    updateSettings: vi.fn(async () => undefined), setWindowBounds: vi.fn(async () => undefined),
    setWindowLayout: vi.fn(async () => undefined), setPresenterLayout: vi.fn(async () => undefined)
  }
  const { WindowManager } = await import('../src/main/windows/windowManager')
  const windows = new WindowManager(store as never, capture as never)
  ;(windows as unknown as { tray: unknown }).tray = {}
  return { windows, created, store, capture }
}

describe('two-window workspaces', () => {
  beforeEach(() => { browserWindowConstructor.mockReset(); registered.clear(); register.mockReset(); register.mockReturnValue(true) })

  it('shows Setup first, then swaps to the presenter only once it has rendered', async () => {
    const { windows, created } = await created2()
    windows.create(); const [setup, presenter] = created
    setup!.fire('ready-to-show')
    expect(setup!.show).toHaveBeenCalledOnce()
    expect(windows.workspaceStatus).toEqual({ mode: 'setup' })

    windows.enterPresenter()
    expect(setup!.hide).toHaveBeenCalledOnce()
    expect(presenter!.show).not.toHaveBeenCalled()
    presenter!.fire('ready-to-show')
    expect(presenter!.show).toHaveBeenCalledOnce()
    expect(presenter!.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver')
    expect(windows.isPresenter).toBe(true)
    expect(presenter!.bounds).toMatchObject({ width: 860, height: 180 })
    windows.prepareToQuit()
  })

  it('fails closed when Electron cannot confirm content protection', async () => {
    const { windows, created } = await created2({}, false)
    windows.create(); const [setup, presenter] = created
    presenter!.fire('ready-to-show')
    expect(() => windows.enterPresenter()).toThrow(/protection/)
    expect(windows.workspaceStatus.mode).toBe('setup')
    expect(presenter!.show).not.toHaveBeenCalled()
    expect(setup!.hide).not.toHaveBeenCalled()
    windows.prepareToQuit()
  })

  it('keeps the presenter hidden if protection is lost before it is shown', async () => {
    const { windows, created, capture } = await created2()
    windows.create(); const [, presenter] = created
    windows.enterPresenter()
    capture.setEnabled(presenter, false)
    presenter!.fire('ready-to-show')
    expect(presenter!.show).not.toHaveBeenCalled()
    expect(windows.workspaceStatus.error).toContain('protection was lost')
    windows.prepareToQuit()
  })

  it('requires confirmation to return to Setup and keeps the presenter alive while hidden', async () => {
    const { windows, created, store, capture } = await created2()
    windows.create(); const [setup, presenter] = created
    presenter!.fire('ready-to-show')
    windows.enterPresenter()
    expect(() => windows.confirmSetup()).toThrow(/confirmation/)
    windows.openSettingsFromTray()
    expect(windows.workspaceStatus).toMatchObject({ mode: 'presenter', setupRequest: 'settings' })
    windows.dismissSetupRequest()
    expect(windows.workspaceStatus.setupRequest).toBeUndefined()

    windows.requestSetup('privacy'); windows.confirmSetup()
    expect(presenter!.hide).toHaveBeenCalledOnce()
    expect(setup!.show).toHaveBeenCalled()
    expect(windows.workspaceStatus).toMatchObject({ mode: 'setup', setupRequest: 'privacy' })
    expect(capture.status(presenter).electronReported).toBe(true)
    expect(capture.status(setup).electronReported).toBe(false)
    expect(store.setPresenterLayout.mock.calls[0]![0]).not.toHaveProperty('height')
    expect(browserWindowConstructor).toHaveBeenCalledTimes(2)
    windows.prepareToQuit()
  })

  it('clamps dynamic height, shrinks again, and rejects invalid size notifications', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    presenter!.fire('ready-to-show'); windows.enterPresenter()
    vi.useFakeTimers()
    try {
      windows.resizePresenter(5000)
      expect(presenter!.bounds.height).toBeLessThan(1048) // eased, not jumped
      vi.advanceTimersByTime(200); expect(presenter!.bounds.height).toBe(1048)
      windows.resizePresenter(175); vi.advanceTimersByTime(200); expect(presenter!.bounds.height).toBe(175)
    } finally { vi.useRealTimers() }
    for (const height of [NaN, Infinity, -1, 100001]) expect(() => windows.resizePresenter(height)).toThrow(/height/)
    windows.prepareToQuit()
  })

  it('does not send focus-to-ask from Setup or allow click-through there', async () => {
    const { windows, created } = await created2()
    windows.create(); const [setup, presenter] = created
    windows.focusAsk()
    expect(presenter!.webContents.send).not.toHaveBeenCalledWith('ui:focus-ask')
    expect(setup!.show).toHaveBeenCalled()
    expect(() => windows.setClickThrough(true)).toThrow()
    windows.prepareToQuit()
  })

  it('registers presenter shortcuts only while presenting and forwards them to the presenter', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    expect(registered.has('Control+Alt+S')).toBe(false)
    presenter!.fire('ready-to-show'); windows.enterPresenter()
    for (const key of ['Control+Alt+Enter', 'Control+Alt+S', 'Control+Alt+F', 'Control+Alt+A', 'Control+Alt+C', 'Control+Alt+R', 'Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3']) expect(registered.has(key)).toBe(true)
    const snapshot = register.mock.calls.find(([key]) => key === 'Control+Alt+S')![1] as () => void
    snapshot()
    expect(presenter!.webContents.send).toHaveBeenCalledWith('presenter:command', 'snapshot')
    windows.requestSetup('settings'); windows.confirmSetup()
    expect(registered.has('Control+Alt+S')).toBe(false)
    presenter!.fire('ready-to-show'); windows.enterPresenter(); windows.prepareToQuit()
    expect(registered.has('Control+Alt+Enter')).toBe(false)
  })

  it('reports presenter shortcuts another app already owns', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    register.mockImplementation((key: string) => key !== 'Control+Alt+F')
    presenter!.fire('ready-to-show'); windows.enterPresenter()
    expect(windows.shortcutWarnings.join(' ')).toContain('Ctrl+Alt+F')
    windows.requestSetup('settings'); windows.confirmSetup()
    expect(windows.shortcutWarnings.join(' ')).not.toContain('Ctrl+Alt+F')
    windows.prepareToQuit()
  })

  it('toggles click-through with Ctrl+Shift+I while presenting and only turns it off elsewhere', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    const toggle = register.mock.calls.find(([key]) => key === 'Control+Shift+I')![1] as () => void
    windows.onEnableClickThrough = () => windows.setClickThrough(true)
    toggle()
    expect(windows.isClickThrough).toBe(false) // not presenting: never turns on
    presenter!.fire('ready-to-show'); windows.enterPresenter()
    toggle(); expect(windows.isClickThrough).toBe(true)
    expect(presenter!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    toggle(); expect(windows.isClickThrough).toBe(false)
    expect(presenter!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    windows.prepareToQuit()
  })

  it('grants the glass capture only to the presenter frame while presenting', async () => {
    const { windows, created } = await created2()
    windows.create(); const [, presenter] = created
    const handler = (presenter!.webContents.session as { setDisplayMediaRequestHandler: ReturnType<typeof vi.fn> }).setDisplayMediaRequestHandler.mock.calls[0]![0] as (request: unknown, callback: (value: unknown) => void) => void
    const denied = vi.fn()
    handler({ frame: presenter!.webContents.mainFrame, audioRequested: false }, denied)
    expect(denied).toHaveBeenCalledWith({})
    presenter!.fire('ready-to-show'); windows.enterPresenter()
    const foreign = vi.fn()
    handler({ frame: {}, audioRequested: false }, foreign)
    expect(foreign).toHaveBeenCalledWith({})
    windows.prepareToQuit()
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
