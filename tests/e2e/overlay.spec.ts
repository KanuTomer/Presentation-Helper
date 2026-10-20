import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

let application: ElectronApplication
/** The ordinary Setup window. */
let setup: Page
/** The protected presenter window; it stays alive while hidden. */
let page: Page
let userData: string

type View = 'setup' | 'presenter'
const status = () => setup.evaluate(() => window.presenter.getStatus())
/** Runs in the main process against the window that loaded `view`. */
const nativeWindow = <T>(view: View, read: string): Promise<T> => application.evaluate(({ BrowserWindow }, args) => {
  const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes(`view=${args.view}`))
  return new Function('window', `return (${args.read})(window)`)(window)
}, { view, read }) as Promise<T>

async function enterPresenter(): Promise<void> {
  if ((await status()).workspace?.mode !== 'presenter') {
    const enter = setup.getByRole('button', { name: 'Enter presenter mode →' })
    await expect(enter).toBeEnabled()
    // Setup hides as the presenter appears; do not wait on a disappearing mouse target.
    await enter.dispatchEvent('click')
  }
  await expect.poll(async () => (await status()).workspace?.mode).toBe('presenter')
  await expect.poll(async () => (await e2eState()).visible).toBe(true)
}
async function openSetup(section: 'settings' | 'privacy' | 'documents' | 'capture' | 'appearance' = 'settings'): Promise<void> {
  if ((await status()).workspace?.mode === 'presenter') {
    await page.evaluate((target) => window.presenter.requestSetup(target), section === 'appearance' ? 'settings' : section)
    await page.getByRole('button', { name: 'Return to Setup', exact: true }).click()
  }
  await expect.poll(async () => (await status()).workspace?.mode).toBe('setup')
  const names = { settings: 'Get started', privacy: 'Privacy & data', documents: 'Documents', appearance: 'Appearance', capture: 'Capture test' }
  await setup.locator('.setup-nav').getByRole('button', { name: names[section], exact: true }).click()
}

test.beforeEach(async ({}, info) => { if (!info.title.startsWith('starts in normal Setup')) await enterPresenter() })

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus || !application) return
  const diagnostic = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
    url: window.webContents.getURL().replace(/^.*\?/u, '?'), visible: window.isVisible(), protected: window.isContentProtected(), bounds: window.getBounds()
  }))).catch(() => ({ unavailable: true }))
  const workspace = await status().then((value) => value.workspace).catch(() => undefined)
  await info.attach('workspace-readiness', { body: JSON.stringify({ windows: diagnostic, workspace }), contentType: 'application/json' })
})

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'presenterai-e2e-'))
  await writeFile(join(userData, 'presenterai.json'), JSON.stringify({
    windowBounds: { x: 999_999, y: 999_999, width: 560, height: 720 }
  }))
  const childEnvironment = { ...process.env }
  delete childEnvironment.OPENAI_API_KEY
  application = await electron.launch({
    args: [resolve('.')],
    env: {
      ...childEnvironment,
      PRESENTERAI_E2E: '1',
      PRESENTERAI_E2E_AUDIO_BACKEND: 'synthetic-test',
      PRESENTERAI_E2E_USER_DATA: userData,
      PRESENTERAI_E2E_HELPER_START_DELAY_MS: '4000'
    }
  })
  await expect.poll(() => application.windows().filter((item) => item.url().startsWith('file:')).length, {
    timeout: 30_000, message: 'both windows did not load'
  }).toBe(2)
  setup = application.windows().find((item) => item.url().includes('view=setup'))!
  page = application.windows().find((item) => item.url().includes('view=presenter'))!
  for (const item of [setup, page]) {
    await item.waitForLoadState('domcontentloaded')
    await expect.poll(async () => item.evaluate(() => typeof window.presenter), {
      timeout: 30_000, message: 'sandboxed preload bridge did not become ready'
    }).toBe('object')
  }
  await expect.poll(async () => application.evaluate(() => (
    typeof (globalThis as typeof globalThis & { __presenterE2E?: unknown }).__presenterE2E === 'object'
  )), { timeout: 30_000, message: 'main-process E2E diagnostics did not become ready' }).toBe(true)
  await expect.poll(async () => (await e2eState()).visible, {
    timeout: 30_000, message: 'Setup did not reach its ready-to-show state'
  }).toBe(true)
})

test.afterAll(async () => {
  if (application) {
    let closed = false
    const closeEvent = new Promise<void>((resolveClose) => application.once('close', () => { closed = true; resolveClose() }))
    await application.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
    await Promise.race([closeEvent, new Promise<void>((resolveWait) => setTimeout(resolveWait, 15_000))])
    if (!closed) application.process().kill()
  }
  if (userData) await rm(userData, { recursive: true, force: true })
})

test('starts in normal Setup and enters presenter only through the explicit action', async () => {
  const state = await status()
  expect(state.workspace).toEqual({ mode: 'setup' })
  expect(state.capture.electronReported).toBe(false)
  expect(await nativeWindow<boolean>('setup', '(w) => w.isAlwaysOnTop()')).toBe(false)
  expect(await nativeWindow<boolean>('presenter', '(w) => w.isVisible()')).toBe(false)
  expect(await nativeWindow<boolean>('presenter', '(w) => w.isContentProtected()')).toBe(true)
  await enterPresenter()
  expect((await status()).capture.electronReported).toBe(true)
  expect(await nativeWindow<boolean>('setup', '(w) => w.isVisible()')).toBe(false)
  expect(await nativeWindow<boolean>('presenter', '(w) => w.isVisible()')).toBe(true)
})

test('registers renderer IPC before delayed helper initialization completes', async () => {
  const settings = await setup.evaluate(() => window.presenter.getSettings())
  expect(settings.listenShortcut).toBe('Control+Shift+Space')
  await expect.poll(async () => Boolean((await e2eState()).audioInitialized), {
    timeout: 30_000, message: 'audio initialization did not reach a terminal state'
  }).toBe(true)
})

test('grows and folds native presenter height from measured content without persisting an automatic height', async () => {
  const height = () => nativeWindow<number>('presenter', '(w) => w.getBounds().height')
  await page.waitForTimeout(150)
  const compact = await height()
  await page.locator('.workspace-content').evaluate((element) => {
    const fixture = document.createElement('div'); fixture.id = 'synthetic-response-size'; fixture.style.height = '280px'; fixture.style.flexShrink = '0'; element.append(fixture)
  })
  await expect.poll(height).toBeGreaterThan(compact + 200)
  await page.locator('#synthetic-response-size').evaluate((element) => { element.style.height = '10000px' })
  const maximum = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('view=presenter'))!
    return screen.getDisplayMatching(window.getBounds()).workArea.height - 32
  })
  await expect.poll(height).toBeLessThanOrEqual(maximum)
  await page.locator('#synthetic-response-size').evaluate((element) => element.remove())
  await expect.poll(height).toBe(compact)
})

test('requires cancellation before leaving active capture and retains the composer across Setup', async () => {
  await expect.poll(async () => (await status()).helperState, { timeout: 30_000 }).toBe('ready')
  const composer = page.getByPlaceholder('Ask a question…')
  await composer.fill('Retain this reviewer question across workspaces.')
  await page.evaluate(() => window.presenter.acceptListeningConsent(4))
  const started = await page.evaluate(() => window.presenter.toggleListening())
  expect(started.ok).toBe(true)
  await page.evaluate(() => window.presenter.requestSetup('settings'))
  await expect(page.getByRole('alertdialog', { name: 'Leave presenter mode?' })).toBeVisible()
  const rejected = await page.evaluate(async () => { try { await window.presenter.confirmSetup(false); return false } catch { return true } })
  expect(rejected).toBe(true)
  expect((await status()).capture.electronReported).toBe(true)
  await page.getByRole('button', { name: 'Cancel operation & return' }).click()
  await expect.poll(async () => (await status()).workspace?.mode).toBe('setup')
  expect(await status()).toMatchObject({ workspace: { mode: 'setup' }, operation: 'idle', temporaryAudioExists: false, capture: { electronReported: false } })
  expect(await nativeWindow<boolean>('presenter', '(w) => w.isVisible()')).toBe(false)
  await enterPresenter()
  await expect(composer).toHaveValue('Retain this reviewer question across workspaces.')
  await composer.fill('')
})

test('reports real registration, retries while idle, and rejects a second instance of the same profile', async () => {
  const statuses = await page.evaluate(() => window.presenter.retryShortcuts())
  expect(statuses).toHaveLength(3)
  expect(statuses.every((item) => item.status === 'registered')).toBe(true)
  const env = { ...process.env, PRESENTERAI_E2E_USER_DATA: userData, PRESENTERAI_E2E: '1', PRESENTERAI_E2E_AUDIO_BACKEND: 'synthetic-test' }
  delete env.OPENAI_API_KEY
  const second = spawn(application.process().spawnfile, [resolve('.')], { env, stdio: 'ignore' })
  const code = await new Promise<number | null>((accept, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('Second instance did not exit.')) }, 10000)
    second.once('error', (error) => { clearTimeout(timer); reject(error) })
    second.once('exit', (value) => { clearTimeout(timer); accept(value) })
  })
  expect(code).toBe(0)
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)
})

test('reuses the system-audio toggle after a completed terminal path', async () => {
  const topmost = () => nativeWindow<boolean>('presenter', '(w) => w.isAlwaysOnTop()')
  const recoveryShortcut = () => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Shift+I'))
  // A failed earlier test restarts the worker and relaunches Electron, so this
  // test must not inherit helper readiness from tests that ran before it.
  await expect.poll(async () => (await status()).helperState, { timeout: 30_000 }).toBe('ready')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  const readiness = await page.evaluate(async () => {
    const current = await window.presenter.getStatus()
    if (!current.privacyConsent.satisfied) {
      await window.presenter.acceptListeningConsent(current.privacyConsent.requiredVersion)
    }
    return window.presenter.toggleListening()
  })
  expect(readiness).toEqual({ ok: true })
  await expect.poll(async () => (await status()).operation).toBe('listening')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => window.presenter.toggleListening())).toEqual({ ok: true })
  await expect.poll(async () => {
    const current = await status()
    return !current.temporaryAudioExists && (current.operation === 'idle' || current.operation === 'error')
  }, { timeout: 30_000 }).toBe(true)
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)

  expect(await page.evaluate(() => window.presenter.toggleListening())).toEqual({ ok: true })
  await expect.poll(async () => (await status()).operation).toBe('listening')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  expect(await page.evaluate(() => window.presenter.cancel())).toEqual({ ok: true })
  await expect.poll(async () => {
    const current = await status()
    return { operation: current.operation, temporaryAudioExists: current.temporaryAudioExists }
  }).toEqual({ operation: 'idle', temporaryAudioExists: false })
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
})

test('creates a protected, hardened presenter inside the work area and an ordinary Setup window', async () => {
  const state = await application.evaluate(({ BrowserWindow, screen }) => {
    const describe = (view: string) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes(`view=${view}`))!
      const bounds = window.getBounds()
      const contained = screen.getAllDisplays().some(({ workArea }) => (
        bounds.x >= workArea.x && bounds.x + bounds.width <= workArea.x + workArea.width &&
        bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height
      ))
      const preferences = window.webContents.getLastWebPreferences()
      return {
        alwaysOnTop: window.isAlwaysOnTop(), movable: window.isMovable(), resizable: window.isResizable(), protected: window.isContentProtected(),
        contained, bounds, preferences: { sandbox: preferences?.sandbox, contextIsolation: preferences?.contextIsolation, nodeIntegration: preferences?.nodeIntegration }
      }
    }
    return { presenter: describe('presenter'), setup: describe('setup') }
  })
  const hardened = { sandbox: true, contextIsolation: true, nodeIntegration: false }
  expect(state.presenter).toMatchObject({ alwaysOnTop: true, movable: true, resizable: true, protected: true, contained: true, preferences: hardened })
  expect(state.setup).toMatchObject({ alwaysOnTop: false, protected: false, preferences: hardened })
  expect(state.presenter.bounds.width).toBeGreaterThanOrEqual(600)
})

test('starts code-first and applies glass haze and text size from Setup', async () => {
  const presenter = page.getByRole('button', { name: 'Presenter', exact: true })
  const code = page.getByRole('button', { name: '</> Code' })
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  await expect(presenter).toHaveAttribute('aria-pressed', 'false')
  await presenter.click()
  await expect(presenter).toHaveAttribute('aria-pressed', 'true')
  await code.click()
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('canvas.liquid-glass')).toHaveCount(1)

  await openSetup('appearance')
  await setup.getByRole('slider', { name: 'Glass haze' }).fill('0.2')
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).appearance?.glassHaze).toBe(0.2)
  await setup.getByRole('slider', { name: 'Text size' }).fill('1.2')
  await expect.poll(() => nativeWindow<number>('presenter', '(w) => w.webContents.getZoomFactor()')).toBeCloseTo(1.2)
  await expect.poll(() => nativeWindow<number>('setup', '(w) => w.webContents.getZoomFactor()')).toBeCloseTo(1.2)
  await setup.getByRole('slider', { name: 'Glass haze' }).fill('0.5')
  await setup.getByRole('slider', { name: 'Text size' }).fill('1')
  await expect.poll(async () => (await setup.evaluate(() => window.presenter.getSettings())).fontScale).toBe(1)
})

test('scrolls every long section by wheel and keyboard at wide and minimum sizes', async () => {
  const sections = [['copilot', '.content', '.workspace-content'], ['documents', '.setup-main', '.setup-main > .stack'], ['settings', '.setup-main', '.setup-main > .stack'], ['privacy', '.setup-main', '.setup-main > .stack'], ['capture', '.setup-main', '.setup-main > .stack']] as const
  for (const [width, height] of [[1100, 720], [680, 420]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => {
      for (const window of BrowserWindow.getAllWindows()) window.setContentSize(size.width, size.height)
    }, { width, height })
    for (const [section, scrollerSelector, hostSelector] of sections) {
      if (section === 'copilot') await enterPresenter()
      else await openSetup(section)
      const view = section === 'copilot' ? page : setup
      const scroller = view.locator(scrollerSelector)
      await view.locator(hostSelector).evaluate((element) => {
        const fixture = document.createElement('div')
        fixture.className = 'e2e-scroll-fixture'
        fixture.setAttribute('aria-hidden', 'true')
        fixture.style.height = '1400px'
        fixture.style.minHeight = '1400px'
        element.append(fixture)
      })
      await expect.poll(async () => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
      // Allow content-driven native resizing to settle before sending wheel input.
      await view.waitForTimeout(150)
      await scroller.evaluate((element) => { element.scrollTop = 0 })
      await scroller.hover()
      await view.mouse.wheel(0, 360)
      await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

      await scroller.focus()
      await view.keyboard.press('Home')
      await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBe(0)
      await view.keyboard.press('PageDown')
      await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await view.locator('.e2e-scroll-fixture').evaluate((element) => element.remove())
    }
  }
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1100, 720) })
})

test('attaches a screenshot to the composer without hiding the presenter, and removes it', async () => {
  const visible = () => nativeWindow<boolean>('presenter', '(w) => w.isVisible()')
  const hides: boolean[] = []
  const watcher = setInterval(() => { void visible().then((value) => hides.push(value)).catch(() => undefined) }, 15)
  try {
    await page.getByRole('button', { name: 'Snapshot', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Screenshot attached' })).toBeVisible()
  } finally { clearInterval(watcher) }
  expect(hides.every(Boolean), 'the presenter hid itself while capturing').toBe(true)
  await expect(page.getByRole('button', { name: 'Snapshot ✓' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Remove screenshot' }).click()
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('claims presenter shortcuts only while presenting and runs their actions', async () => {
  const isRegistered = (key: string) => application.evaluate(({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator), key)
  expect(await isRegistered('Control+Alt+S')).toBe(true)
  const command = (name: string) => application.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('view=presenter'))!.webContents.send('presenter:command', value)
  }, name)
  await command('format')
  await expect(page.getByRole('button', { name: 'Presenter', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await command('format')
  await expect(page.getByRole('button', { name: '</> Code' })).toHaveAttribute('aria-pressed', 'true')
  await command('snapshot')
  await expect(page.getByRole('status').filter({ hasText: 'Screenshot attached' })).toBeVisible()
  await command('snapshot')
  await expect(page.getByRole('status').filter({ hasText: 'Screenshot attached' })).toHaveCount(0)
  await openSetup('settings')
  expect(await isRegistered('Control+Alt+S')).toBe(false)
  await enterPresenter()
  expect(await isRegistered('Control+Alt+S')).toBe(true)
})

test('keeps wheel and touchpad-style deltas inside nested code scrolling surfaces', async () => {
  await page.locator('.content').evaluate((content) => {
    const card = document.createElement('article')
    card.className = 'code-block-card e2e-code-card'
    const pre = document.createElement('pre')
    pre.className = 'code-scroll'
    pre.tabIndex = 0
    pre.textContent = Array.from({ length: 80 }, (_, index) => `${index}: ${'nested-scroll-content '.repeat(12)}`).join('\n')
    card.append(pre)
    content.firstElementChild?.append(card)
  })
  const scroller = page.locator('.e2e-code-card .code-scroll')
  await scroller.hover()
  await page.mouse.wheel(300, 320)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await page.locator('.e2e-code-card').evaluate((element) => element.remove())
})

test('keeps quick controls usable across widths and scale factors', async () => {
  const presenterWindow = (body: string) => application.evaluate(({ BrowserWindow }, args) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('view=presenter'))!
    new Function('window', 'value', args.body)(window, args.value)
  }, { body, value: 0 })
  for (const width of [1100, 680]) {
    await presenterWindow(`window.setContentSize(${width}, window.getContentSize()[1])`)
    for (const scale of [1, 1.25, 1.5, 2]) {
      await presenterWindow(`window.webContents.setZoomFactor(${scale})`)
      await page.waitForTimeout(120)

      const commandButtons = page.locator('.quick-controls button')
      expect(await commandButtons.count()).toBe(6)
      for (let index = 0; index < await commandButtons.count(); index += 1) {
        await commandButtons.nth(index).scrollIntoViewIfNeeded()
        await expect(commandButtons.nth(index)).toBeInViewport()
      }

      const layout = await page.evaluate(() => {
        const controls = document.querySelector<HTMLElement>('.quick-controls')!
        const groups = [
          document.querySelector<HTMLElement>('.answer-format')!,
          document.querySelector<HTMLElement>('.click-through-control')!,
          document.querySelector<HTMLElement>('.command-actions')!
        ]
        const controlBounds = controls.getBoundingClientRect()
        return {
          rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          controlOverflow: controls.scrollWidth - controls.clientWidth,
          everyGroupInsideBar: groups.map((group) => group.getBoundingClientRect()).every((bounds) => (
            bounds.left >= controlBounds.left - 1 && bounds.right <= controlBounds.right + 1 &&
            bounds.top >= controlBounds.top - 1 && bounds.bottom <= controlBounds.bottom + 1
          ))
        }
      })
      expect(layout).toEqual({ rootOverflow: 0, controlOverflow: 0, everyGroupInsideBar: true })
    }
  }
  await presenterWindow('window.webContents.setZoomFactor(1); window.setContentSize(1100, window.getContentSize()[1])')
})

test('provides tray recovery, hide/show, and emergency click-through escape', async () => {
  // A preceding width/zoom change can still be settling content-sized bounds.
  await page.waitForTimeout(350)
  const initial = await e2eState()
  expect(initial).toMatchObject({ tray: true, emergencyShortcut: true, clickThrough: false })
  await page.evaluate(() => {
    const diagnostics = globalThis as typeof globalThis & {
      __surfaceRestoreCount?: number
      __surfaceRestoreDispose?: () => void
    }
    diagnostics.__surfaceRestoreDispose?.()
    diagnostics.__surfaceRestoreCount = 0
    diagnostics.__surfaceRestoreDispose = window.presenter.onSurfaceRestored(() => {
      diagnostics.__surfaceRestoreCount = (diagnostics.__surfaceRestoreCount ?? 0) + 1
    })
  })
  const surfaceRestoreCount = (): Promise<number> => page.evaluate(() => (
    (globalThis as typeof globalThis & { __surfaceRestoreCount?: number }).__surfaceRestoreCount ?? 0
  ))
  const expectRestoredSurface = async (expectedCount: number): Promise<void> => {
    await expect.poll(surfaceRestoreCount, {
      message: `surface-restored event ${expectedCount} was not observed`
    }).toBe(expectedCount)
    await page.waitForTimeout(50)
    expect(await surfaceRestoreCount(), 'one show path emitted more than one surface-restored event').toBe(expectedCount)
  }

  await nativeWindow('presenter', '(w) => w.close()')
  await expect.poll(async () => (await e2eState()).visible).toBe(false)
  await application.evaluate(() => (globalThis as any).__presenterE2E.trayShow())
  await expect.poll(async () => (await e2eState()).visible).toBe(true)
  await expectRestoredSurface(1)

  for (let cycle = 1; cycle <= 10; cycle += 1) {
    await application.evaluate(() => (globalThis as any).__presenterE2E.toggleVisibility())
    await expect.poll(async () => (await e2eState()).visible).toBe(false)
    await application.evaluate(() => (globalThis as any).__presenterE2E.toggleVisibility())
    await expect.poll(async () => (await e2eState()).visible).toBe(true)
    await expectRestoredSurface(cycle + 1)
  }

  await page.getByRole('button', { name: 'Enable click-through' }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Enable click-through?' })
  await expect(confirmation).toContainText('Ctrl+Shift+I')
  await expect(confirmation).toContainText('Tray → Show PresenterAI')
  await confirmation.getByRole('button', { name: 'Enable click-through' }).click()
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(true)
  await expect(page.locator('.click-through-banner')).toContainText('CLICK-THROUGH ON · Ctrl+Shift+I')
  await application.evaluate(() => (globalThis as any).__presenterE2E.traySettings())
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(false)
  await expect(page.getByRole('alertdialog', { name: 'Leave presenter mode?' })).toBeVisible()
  expect((await status()).capture.electronReported).toBe(true)
  await page.getByRole('button', { name: 'Stay in presenter' }).click()

  await page.evaluate(() => window.presenter.setClickThrough(true))
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(true)
  await application.evaluate(() => (globalThis as any).__presenterE2E.emergencyUnlock())
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(false)
  await page.evaluate(() => {
    const diagnostics = globalThis as typeof globalThis & { __surfaceRestoreDispose?: () => void }
    diagnostics.__surfaceRestoreDispose?.()
    delete diagnostics.__surfaceRestoreDispose
  })
})

test('rejects an OS-reserved shortcut and restores all prior recovery registrations', async () => {
  const reserved = 'Control+Shift+Alt+F11'
  expect(await application.evaluate((_electron, accelerator) => (globalThis as any).__presenterE2E.reserveShortcut(accelerator), reserved)).toBe(true)
  const result = await setup.evaluate(async () => {
    const before = await window.presenter.getSettings()
    try {
      await window.presenter.updateSettings({ hideShortcut: 'Control+Shift+Alt+F11' })
      return { rejected: false, message: '', before, after: await window.presenter.getSettings() }
    } catch (error) {
      return { rejected: true, message: (error as Error).message, before, after: await window.presenter.getSettings() }
    }
  })
  await application.evaluate((_electron, accelerator) => (globalThis as any).__presenterE2E.releaseShortcut(accelerator), reserved)
  expect(result.rejected).toBe(true)
  expect(result.message).toMatch(/could not register/i)
  expect(result.after.askShortcut).toBe(result.before.askShortcut)
  expect(result.after.hideShortcut).toBe(result.before.hideShortcut)
  expect(await e2eState()).toMatchObject({ askShortcut: true, hideShortcut: true, emergencyShortcut: true })
})

test('loads with a strict renderer CSP and no Electron security warnings', async () => {
  const warnings: string[] = []
  setup.on('console', (message) => { if (/electron security warning/i.test(message.text())) warnings.push(message.text()) })
  await setup.reload({ waitUntil: 'domcontentloaded' })
  const policy = await setup.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(policy).toContain("object-src 'none'")
  expect(policy).not.toContain('api.openai.com')
  expect(warnings).toEqual([])
})

async function e2eState(): Promise<Record<string, boolean>> {
  return application.evaluate(() => (globalThis as any).__presenterE2E.state())
}
