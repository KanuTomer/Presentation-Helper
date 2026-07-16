import { app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './settings/store.js'
import { SecretStore } from './settings/secrets.js'
import { CaptureProtection } from './windows/captureProtection.js'
import { WindowManager } from './windows/windowManager.js'
import { RetrievalIndex } from './retrieval/index.js'
import { AiService } from './ai/service.js'
import { AudioController } from './audio/controller.js'
import { OperationCoordinator } from './operations/coordinator.js'
import { registerIpc } from './ipc/register.js'
import { fts5SmokeOutputPath, runFts5Smoke } from './ftsSmoke.js'
import { helperSmokeOutputPath, runHelperSmoke } from './helperSmoke.js'

let retrieval: RetrievalIndex | undefined
let audio: AudioController | undefined
let windows: WindowManager | undefined
let quitting = false
let audioInitialized = false

if (process.env.PRESENTERAI_E2E_USER_DATA) app.setPath('userData', process.env.PRESENTERAI_E2E_USER_DATA)

const packagedFtsSmoke = fts5SmokeOutputPath()
const packagedHelperSmoke = helperSmokeOutputPath()
if (packagedFtsSmoke) {
  void app.whenReady().then(() => runFts5Smoke(packagedFtsSmoke)).then(() => quitAfterSmoke(0), () => quitAfterSmoke(1))
} else if (packagedHelperSmoke) {
  void app.whenReady().then(() => runHelperSmoke(packagedHelperSmoke)).then(() => quitAfterSmoke(0), () => quitAfterSmoke(1))
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => windows?.focusAsk())
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.presenterai.desktop')
    const store = new SettingsStore(); await store.initialize()
    const secrets = new SecretStore()
    const capture = new CaptureProtection(store)
    windows = new WindowManager(store, capture)
    retrieval = new RetrievalIndex({
      databasePath: join(app.getPath('userData'), 'documents.sqlite'),
      catalogSink: store
    })
    await retrieval.initialize()
    const ai = new AiService(secrets, store, retrieval)
    const operations = new OperationCoordinator(globalShortcut)
    audio = new AudioController(ai, store, operations)
    // Register the complete renderer contract before the native helper starts.
    // Defender, first-run extraction, or a missing helper may otherwise leave
    // the already-loaded renderer with rejected IPC calls for up to 60 seconds.
    registerIpc({ store, secrets, retrieval, ai, audio, windows, capture })
    if (process.env.PRESENTERAI_E2E === '1') {
      ;(globalThis as typeof globalThis & { __presenterE2E?: unknown }).__presenterE2E = {
        state: () => ({
          tray: windows?.hasTray ?? false,
          visible: windows?.window?.isVisible() ?? false,
          clickThrough: windows?.isClickThrough ?? false,
          askShortcut: globalShortcut.isRegistered(store.settings.askShortcut),
          hideShortcut: globalShortcut.isRegistered(store.settings.hideShortcut),
          emergencyShortcut: globalShortcut.isRegistered('Control+Shift+I'),
          audioInitialized
        }),
        toggleVisibility: () => windows?.toggleVisibility(),
        emergencyUnlock: () => windows?.emergencyUnlock(),
        trayShow: () => windows?.showFromTray(),
        traySettings: () => windows?.openSettingsFromTray(),
        reserveShortcut: (accelerator: string) => globalShortcut.register(accelerator, () => undefined),
        releaseShortcut: (accelerator: string) => globalShortcut.unregister(accelerator)
      }
    }
    // Navigation begins only after retrieval migration and every renderer IPC
    // handler are ready. This closes the same startup race for a slow FTS
    // rebuild that early helper registration closes for native initialization.
    windows.create()
    const e2eDelay = process.env.PRESENTERAI_E2E_HELPER_START_DELAY_MS
    if (process.env.PRESENTERAI_E2E === '1' && e2eDelay && Number(e2eDelay) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Number(e2eDelay))))
    }
    try { await audio.initialize() } finally { audioInitialized = true }
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault(); quitting = true; windows?.prepareToQuit()
    void (audio?.dispose() ?? Promise.resolve()).finally(() => {
      globalShortcut.unregisterAll(); retrieval?.close(); app.quit()
    })
  })
  app.on('window-all-closed', () => { /* keep tray application alive */ })
}

function quitAfterSmoke(exitCode: number): void {
  process.exitCode = exitCode
  app.quit()
}
