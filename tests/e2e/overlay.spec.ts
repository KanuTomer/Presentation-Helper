import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

let application: ElectronApplication
let page: Page
let userData: string

async function enterPresenter(): Promise<void> {
  if ((await page.evaluate(() => window.presenter.getStatus())).workspace?.mode !== 'presenter') {
    const enter = page.getByRole('button', { name: 'Enter presenter mode →' })
    await expect(enter).toBeVisible()
    await expect(enter).toBeEnabled()
    // The handler deliberately hides/resizes the native window. Hosted Windows
    // can stall CDP's mouse-up acknowledgement during that transition; activate
    // the actual button handler without waiting on a disappearing mouse target.
    await enter.dispatchEvent('click')
  }
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).workspace).toMatchObject({ mode: 'presenter', transition: 'idle' })
  await expect.poll(async () => (await e2eState()).visible).toBe(true)
}
async function openSetup(section: 'settings' | 'privacy' | 'documents' | 'capture' | 'appearance' = 'settings'): Promise<void> {
  if ((await page.evaluate(() => window.presenter.getStatus())).workspace?.mode === 'presenter') {
    await page.evaluate((target) => window.presenter.requestSetup(target), section === 'appearance' ? 'settings' : section)
    await page.getByRole('button', { name: 'Return to Setup', exact: true }).click()
  }
  // The presenter workspace is already idle before confirmation starts the
  // transition, so only setup/idle proves the return was acknowledged.
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).workspace).toMatchObject({ mode: 'setup', transition: 'idle' })
  const names = { settings: 'Session & models', privacy: 'Privacy & data', documents: 'Documents & context', appearance: 'Appearance' }
  if (section === 'capture') await page.getByRole('button', { name: 'Capture compatibility', exact: true }).click()
  else await page.getByRole('button', { name: names[section], exact: true }).click()
}

test.beforeEach(async ({}, info) => { if (!info.title.startsWith('starts in normal Setup')) await enterPresenter() })

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus || !application) return
  const diagnostic = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window?.isVisible(), backgroundThrottling: window?.webContents.getBackgroundThrottling(), bounds: window?.getBounds() }
  }).catch(() => ({ unavailable: true }))
  const workspace = await page.evaluate(async () => (await window.presenter.getStatus()).workspace).catch(() => undefined)
  await info.attach('workspace-readiness', { body: JSON.stringify({ ...diagnostic, workspace }), contentType: 'application/json' })
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
  page = await application.firstWindow()
  await page.waitForURL((url) => url.protocol === 'file:')
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(async () => page.evaluate(() => typeof window.presenter), {
    timeout: 30_000, message: 'sandboxed preload bridge did not become ready'
  }).toBe('object')
  await expect.poll(async () => application.evaluate(() => (
    typeof (globalThis as typeof globalThis & { __presenterE2E?: unknown }).__presenterE2E === 'object'
  )), { timeout: 30_000, message: 'main-process E2E diagnostics did not become ready' }).toBe(true)
  await expect.poll(async () => (await e2eState()).visible, {
    timeout: 30_000, message: 'overlay did not reach its ready-to-show state'
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
  const state = await page.evaluate(() => window.presenter.getStatus())
  expect(state.workspace).toMatchObject({ mode: 'setup', transition: 'idle' })
  expect(state.capture.electronReported).toBe(false)
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isAlwaysOnTop())).toBe(false)
  await expect(page.getByRole('button', { name: 'Enter presenter mode →' })).toBeVisible()
  await enterPresenter()
  expect((await page.evaluate(() => window.presenter.getStatus())).capture.electronReported).toBe(true)
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getBackgroundThrottling())).toBe(true)
})

test('registers renderer IPC before delayed helper initialization completes', async () => {
  const settings = await page.evaluate(() => window.presenter.getSettings())
  expect(settings.listenShortcut).toBe('Control+Shift+Space')
  await expect.poll(async () => Boolean((await e2eState()).audioInitialized), {
    timeout: 30_000, message: 'audio initialization did not reach a terminal state'
  }).toBe(true)
})

test('grows and folds native presenter height from measured content without persisting an automatic height', async () => {
  const height = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds().height)
  await page.waitForTimeout(150)
  const compact = await height()
  await page.locator('.workspace-content').evaluate((element) => {
    const fixture = document.createElement('div'); fixture.id = 'synthetic-response-size'; fixture.style.height = '280px'; fixture.style.flexShrink = '0'; element.append(fixture)
  })
  await expect.poll(height).toBeGreaterThan(compact + 200)
  await page.locator('#synthetic-response-size').evaluate((element) => { element.style.height = '10000px' })
  const maximum = await application.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds()).workArea.height - 32)
  await expect.poll(height).toBeLessThanOrEqual(maximum)
  await page.locator('#synthetic-response-size').evaluate((element) => element.remove())
  await expect.poll(height).toBe(compact)
})

test('requires cancellation before leaving active capture and retains the composer across Setup', async () => {
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).helperState, { timeout: 30_000 }).toBe('ready')
  const composer = page.getByPlaceholder('Ask a reviewer question…')
  await composer.fill('Retain this reviewer question across workspaces.')
  await page.evaluate(() => window.presenter.acceptListeningConsent(4))
  const started = await page.evaluate(() => window.presenter.toggleListening())
  expect(started.ok).toBe(true)
  await page.evaluate(() => window.presenter.requestSetup('settings'))
  await expect(page.getByRole('alertdialog', { name: 'Leave presenter mode?' })).toBeVisible()
  const rejected = await page.evaluate(async () => { try { await window.presenter.confirmSetup(false); return false } catch { return true } })
  expect(rejected).toBe(true)
  expect((await page.evaluate(() => window.presenter.getStatus())).capture.electronReported).toBe(true)
  await page.getByRole('button', { name: 'Cancel operation & return' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).workspace).toMatchObject({ mode: 'setup', transition: 'idle' })
  const state = await page.evaluate(() => window.presenter.getStatus())
  expect(state).toMatchObject({ workspace: { mode: 'setup' }, operation: 'idle', temporaryAudioExists: false, capture: { electronReported: false } })
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
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('reuses the system-audio toggle after a completed terminal path', async () => {
  const topmost = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())
  const recoveryShortcut = () => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Shift+I'))
  // A failed earlier test restarts the worker and relaunches Electron, so this
  // test must not inherit helper readiness from tests that ran before it.
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).helperState, { timeout: 30_000 }).toBe('ready')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  const readiness = await page.evaluate(async () => {
    const status = await window.presenter.getStatus()
    if (!status.privacyConsent.satisfied) {
      await window.presenter.acceptListeningConsent(status.privacyConsent.requiredVersion)
    }
    return window.presenter.toggleListening()
  })
  expect(readiness).toEqual({ ok: true })
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).operation).toBe('listening')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => window.presenter.toggleListening())).toEqual({ ok: true })
  await expect.poll(async () => {
    const status = await page.evaluate(() => window.presenter.getStatus())
    return !status.temporaryAudioExists && (status.operation === 'idle' || status.operation === 'error')
  }, { timeout: 30_000 }).toBe(true)
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)

  expect(await page.evaluate(() => window.presenter.toggleListening())).toEqual({ ok: true })
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getStatus())).operation).toBe('listening')
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
  expect(await page.evaluate(() => window.presenter.cancel())).toEqual({ ok: true })
  await expect.poll(async () => {
    const status = await page.evaluate(() => window.presenter.getStatus())
    return { operation: status.operation, temporaryAudioExists: status.temporaryAudioExists }
  }).toEqual({ operation: 'idle', temporaryAudioExists: false })
  expect(await topmost()).toBe(true)
  expect(await recoveryShortcut()).toBe(true)
})

test('creates a protected transparent overlay with hardened preferences, smooth corner transparency, and clamped bounds', async () => {
  const state = await application.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const bounds = window.getBounds()
    const contentBounds = window.getContentBounds()
    const workAreas = screen.getAllDisplays().map(({ workArea }) => workArea)
    const contained = workAreas.some((workArea) => (
      bounds.x >= workArea.x && bounds.x + bounds.width <= workArea.x + workArea.width &&
      bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height
    ))
    const image = await window.webContents.capturePage()
    const bitmap = image.toBitmap()
    const imageSize = image.getSize()
    const alphaAt = (x: number, y: number): number => bitmap[(y * imageSize.width + x) * 4 + 3] ?? 255
    const cornerSamples = [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
      [0, 2], [1, 2], [2, 2]
    ] as const
    const sampleCorner = (right: boolean, bottom: boolean): number[] => cornerSamples.map(([x, y]) => alphaAt(
      right ? imageSize.width - 1 - x : x,
      bottom ? imageSize.height - 1 - y : y
    ))
    return {
      alwaysOnTop: window.isAlwaysOnTop(), movable: window.isMovable(), resizable: window.isResizable(),
      protected: window.isContentProtected(), hasShadow: window.hasShadow(), contained, bounds, contentBounds, workAreas,
      preferences: window.webContents.getLastWebPreferences(),
      cornerAlphas: [
        ...sampleCorner(false, false),
        ...sampleCorner(true, false),
        ...sampleCorner(false, true),
        ...sampleCorner(true, true)
      ],
      interiorAlpha: alphaAt(Math.min(28, imageSize.width - 1), Math.min(28, imageSize.height - 1))
    }
  })
  expect(state).toMatchObject({
    alwaysOnTop: true, movable: true, resizable: true, protected: true, hasShadow: false,
    preferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  expect(state.contained, `bounds ${JSON.stringify(state.bounds)} (content ${JSON.stringify(state.contentBounds)}) were outside work areas ${JSON.stringify(state.workAreas)}`).toBe(true)
  // The renderer owns the rounded glass edge; native shadowing is disabled.
  expect(state.contentBounds.width).toBeGreaterThanOrEqual(680)
  expect(state.contentBounds.width).toBeLessThanOrEqual(1116)
  expect(Math.abs(state.bounds.width - state.contentBounds.width)).toBeLessThanOrEqual(16)
  expect(
    Math.max(...state.cornerAlphas),
    `renderer content bled into the outer 3×3 corner pixels: ${state.cornerAlphas.join(', ')}`
  ).toBeLessThanOrEqual(4)
  expect(state.interiorAlpha, 'the transparent-corner sample was invalid because the clipped renderer interior was also transparent').toBeGreaterThan(32)
})

test('starts code-first, keeps the command bar compact, and exposes Accent intensity in Settings', async () => {
  await enterPresenter()
  const presenter = page.getByRole('button', { name: 'Presenter', exact: true })
  const code = page.getByRole('button', { name: '</> Code' })
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  await expect(presenter).toHaveAttribute('aria-pressed', 'false')
  await presenter.click()
  await expect(presenter).toHaveAttribute('aria-pressed', 'true')
  await code.click()
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('slider', { name: 'Accent intensity' })).toHaveCount(0)
  await expect(page.locator('.command-bar')).toHaveCSS('min-height', '40px')
  expect(await page.locator('.command-bar').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(44)

  await openSetup('appearance')
  const neon = page.getByRole('slider', { name: 'Accent intensity' })
  await expect(neon.locator('xpath=ancestor::fieldset/legend')).toHaveText('Appearance')
  await neon.fill('0')
  await expect.poll(async () => page.locator('.shell').evaluate((element) => getComputedStyle(element).getPropertyValue('--neon-intensity').trim())).toBe('0')
  await enterPresenter()
  const zeroEmission = await page.locator('.primary').first().evaluate((element) => getComputedStyle(element).boxShadow)
  expect(zeroEmission).toContain('rgba(160, 158, 255, 0)')
  await openSetup('appearance')
  await neon.fill('1')
  await enterPresenter()
  const fullEmission = await page.locator('.primary').first().evaluate((element) => getComputedStyle(element).boxShadow)
  expect(fullEmission).not.toBe(zeroEmission)
  expect(fullEmission).not.toContain('rgba(160, 158, 255, 0)')
  await openSetup('appearance')
  await neon.fill('0.65')
  await expect.poll(async () => (await page.evaluate(() => window.presenter.getSettings())).neonIntensity).toBe(0.65)
  await enterPresenter()

  const shell = page.locator('.shell')
  await expect(shell).toHaveCSS('border-radius', '24px')
  await expect(page.locator('.quiet-glass-layer')).toHaveCount(1)
  await expect(page.locator('canvas')).toHaveCount(0)
})

test('scrolls every long tab by wheel and keyboard at wide and minimum sizes', async () => {
  for (const [width, height] of [[1100, 720], [680, 420]] as const) {
    await application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    }, { width, height })
    for (const tab of ['copilot', 'documents', 'settings', 'privacy', 'capture'] as const) {
      if (tab === 'copilot') await enterPresenter()
      else await openSetup(tab)
      const content = page.locator('.content')
      await page.locator('.workspace-content').evaluate((element) => {
        const fixture = document.createElement('div')
        fixture.className = 'e2e-scroll-fixture'
        fixture.setAttribute('aria-hidden', 'true')
        fixture.style.height = '1400px'
        fixture.style.minHeight = '1400px'
        element.append(fixture)
      })
      await expect.poll(async () => content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
      // Allow content-driven native resizing to settle before sending wheel input.
      await page.waitForTimeout(150)
      await content.evaluate((element) => { element.scrollTop = 0 })
      await content.hover()
      await page.mouse.wheel(0, 360)
      await expect.poll(async () => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

      await content.focus()
      await page.keyboard.press('Home')
      await expect.poll(async () => content.evaluate((element) => element.scrollTop)).toBe(0)
      await page.keyboard.press('PageDown')
      await expect.poll(async () => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await content.locator('.e2e-scroll-fixture').evaluate((element) => element.remove())
    }
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 720))
})

test('keeps wheel and touchpad-style deltas inside nested code scrolling surfaces', async () => {
  await enterPresenter()
  const code = page.locator('.content').evaluate((content) => {
    const card = document.createElement('article')
    card.className = 'code-block-card e2e-code-card'
    const pre = document.createElement('pre')
    pre.className = 'code-scroll'
    pre.tabIndex = 0
    pre.textContent = Array.from({ length: 80 }, (_, index) => `${index}: ${'nested-scroll-content '.repeat(12)}`).join('\n')
    card.append(pre)
    content.firstElementChild?.append(card)
  })
  await code
  const scroller = page.locator('.e2e-code-card .code-scroll')
  await scroller.hover()
  await page.mouse.wheel(300, 320)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await page.locator('.e2e-code-card').evaluate((element) => element.remove())
})

test('keeps quick controls and rounded clipping usable across scale factors', async () => {
  for (const size of [{ width: 1100, height: 720 }, { width: 680, height: 420 }]) {
    await application.evaluate(({ BrowserWindow }, nextSize) => BrowserWindow.getAllWindows()[0]?.setContentSize(nextSize.width, nextSize.height), size)
    await enterPresenter()
    for (const scale of [1, 1.25, 1.5, 2]) {
      await application.evaluate(({ BrowserWindow }, zoomFactor) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoomFactor)
      }, scale)
      await page.waitForTimeout(120)

      const commandButtons = page.locator('.quick-controls button')
      expect(await commandButtons.count()).toBe(6)
      for (let index = 0; index < await commandButtons.count(); index += 1) {
        await commandButtons.nth(index).scrollIntoViewIfNeeded()
        await expect(commandButtons.nth(index)).toBeInViewport()
      }

      const layout = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.shell')!
        const controls = document.querySelector<HTMLElement>('.quick-controls')!
        const groups = [
          document.querySelector<HTMLElement>('.answer-format')!,
          document.querySelector<HTMLElement>('.click-through-control')!,
          document.querySelector<HTMLElement>('.command-actions')!
        ]
        const controlBounds = controls.getBoundingClientRect()
        const groupBounds = groups.map((group) => group.getBoundingClientRect())
        const rowTops = [...new Set(groupBounds.map((bounds) => Math.round(bounds.top)))]
        return {
          cssViewportWidth: window.innerWidth,
          shellRadius: getComputedStyle(shell).borderRadius,
          rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          controlOverflow: controls.scrollWidth - controls.clientWidth,
          rowCount: rowTops.length,
          everyGroupInsideBar: groupBounds.every((bounds) => (
            bounds.left >= controlBounds.left - 1 &&
            bounds.right <= controlBounds.right + 1 &&
            bounds.top >= controlBounds.top - 1 &&
            bounds.bottom <= controlBounds.bottom + 1
          ))
        }
      })
      expect(layout.shellRadius).toBe('24px')
      expect(layout.rootOverflow).toBe(0)
      expect(layout.controlOverflow).toBe(0)
      expect(layout.everyGroupInsideBar).toBe(true)
      expect(layout.rowCount).toBe(layout.cssViewportWidth >= 600 ? 1 : 2)
    }
  }
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.webContents.setZoomFactor(1)
    window?.setContentSize(1100, 720)
  })
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
    await expect(page.locator('.quiet-glass-layer')).toHaveCount(1)
    await expect(page.locator('canvas')).toHaveCount(0)
  }

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
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

  await enterPresenter()
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
  expect((await page.evaluate(() => window.presenter.getStatus())).capture.electronReported).toBe(true)
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
  const result = await page.evaluate(async () => {
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
  page.on('console', (message) => { if (/electron security warning/i.test(message.text())) warnings.push(message.text()) })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(policy).toContain("object-src 'none'")
  expect(policy).not.toContain('api.openai.com')
  expect(warnings).toEqual([])
})

async function e2eState(): Promise<Record<string, boolean>> {
  return application.evaluate(() => (globalThis as any).__presenterE2E.state())
}
