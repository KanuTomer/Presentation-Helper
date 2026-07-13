import { app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from './settings/store.js'
import { SecretStore } from './settings/secrets.js'
import { CaptureProtection } from './windows/captureProtection.js'
import { WindowManager } from './windows/windowManager.js'
import { RetrievalIndex } from './retrieval/index.js'
import { AiService } from './ai/service.js'
import { AudioController } from './audio/controller.js'
import { registerIpc } from './ipc/register.js'
import { fts5SmokeOutputPath, runFts5Smoke } from './ftsSmoke.js'

let retrieval: RetrievalIndex | undefined
let audio: AudioController | undefined
let windows: WindowManager | undefined
let quitting = false

const packagedFtsSmoke = fts5SmokeOutputPath()
if (packagedFtsSmoke) {
  void runFts5Smoke(packagedFtsSmoke).then(() => app.exit(0), () => app.exit(1))
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => windows?.focusAsk())
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.presenterai.desktop')
    const store = new SettingsStore(); await store.initialize()
    const secrets = new SecretStore()
    const capture = new CaptureProtection(store)
    windows = new WindowManager(store, capture); windows.create()
    retrieval = new RetrievalIndex({
      databasePath: join(app.getPath('userData'), 'documents.sqlite'),
      catalogSink: store
    })
    await retrieval.initialize()
    const ai = new AiService(secrets, store, retrieval)
    audio = new AudioController(ai, store); await audio.initialize()
    registerIpc({ store, secrets, retrieval, ai, audio, windows, capture })
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault(); quitting = true; globalShortcut.unregisterAll(); retrieval?.close()
    void (audio?.dispose() ?? Promise.resolve()).finally(() => app.quit())
  })
  app.on('window-all-closed', () => { /* keep tray application alive */ })
}
