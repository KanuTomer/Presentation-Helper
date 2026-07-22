import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

let application: ElectronApplication
let page: Page
let userData: string

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

test('registers renderer IPC before delayed helper initialization completes', async () => {
  const settings = await page.evaluate(() => window.presenter.getSettings())
  expect(settings.listenShortcut).toBe('Control+Shift+Space')
  await expect.poll(async () => Boolean((await e2eState()).audioInitialized), {
    timeout: 30_000, message: 'audio initialization did not reach a terminal state'
  }).toBe(true)
})

test('reuses the system-audio toggle after a completed terminal path', async () => {
  const topmost = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())
  const recoveryShortcut = () => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Shift+I'))
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

test('creates a protected overlay with hardened web preferences and clamped bounds', async () => {
  const state = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const bounds = window.getBounds()
    const contentBounds = window.getContentBounds()
    const workAreas = screen.getAllDisplays().map(({ workArea }) => workArea)
    const contained = workAreas.some((workArea) => (
      bounds.x >= workArea.x && bounds.x + bounds.width <= workArea.x + workArea.width &&
      bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height
    ))
    return {
      alwaysOnTop: window.isAlwaysOnTop(), movable: window.isMovable(), resizable: window.isResizable(),
      protected: window.isContentProtected(), contained, bounds, contentBounds, workAreas,
      preferences: window.webContents.getLastWebPreferences()
    }
  })
  expect(state).toMatchObject({
    alwaysOnTop: true, movable: true, resizable: true, protected: true,
    preferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  expect(state.contained, `bounds ${JSON.stringify(state.bounds)} (content ${JSON.stringify(state.contentBounds)}) were outside work areas ${JSON.stringify(state.workAreas)}`).toBe(true)
  // DWM can add a small native shadow outside a transparent frameless
  // window. Validate the requested content width and bound the decoration.
  expect(state.contentBounds.width).toBeGreaterThanOrEqual(680)
  expect(state.contentBounds.width).toBeLessThanOrEqual(1116)
  expect(Math.abs(state.bounds.width - state.contentBounds.width)).toBeLessThanOrEqual(16)
})

test('shows the wide glass composer and supports a per-request Code override', async () => {
  await page.getByRole('button', { name: 'copilot' }).click()
  const auto = page.getByRole('button', { name: 'Auto' })
  const code = page.getByRole('button', { name: '</> Code' })
  await expect(auto).toHaveAttribute('aria-pressed', 'true')
  await code.click()
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  await expect(auto).toHaveAttribute('aria-pressed', 'false')
  const shell = page.locator('.shell')
  await expect(shell).toHaveCSS('border-radius', '24px')
})

test('provides tray recovery, hide/show, and emergency click-through escape', async () => {
  const initial = await e2eState()
  expect(initial).toMatchObject({ tray: true, emergencyShortcut: true, clickThrough: false })

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(async () => (await e2eState()).visible).toBe(false)
  await application.evaluate(() => (globalThis as any).__presenterE2E.trayShow())
  await expect.poll(async () => (await e2eState()).visible).toBe(true)

  await application.evaluate(() => (globalThis as any).__presenterE2E.toggleVisibility())
  await expect.poll(async () => (await e2eState()).visible).toBe(false)
  await application.evaluate(() => (globalThis as any).__presenterE2E.toggleVisibility())
  await expect.poll(async () => (await e2eState()).visible).toBe(true)

  await page.evaluate(() => window.presenter.setClickThrough(true))
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(true)
  await application.evaluate(() => (globalThis as any).__presenterE2E.traySettings())
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(false)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  await page.evaluate(() => window.presenter.setClickThrough(true))
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(true)
  await application.evaluate(() => (globalThis as any).__presenterE2E.emergencyUnlock())
  await expect.poll(async () => (await e2eState()).clickThrough).toBe(false)
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
