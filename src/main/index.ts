import { app, globalShortcut } from 'electron'
import { SettingsStore } from './settings/store.js'
import { SecretStore } from './settings/secrets.js'
import { CaptureProtection } from './windows/captureProtection.js'
import { WindowManager } from './windows/windowManager.js'
import { RetrievalIndex } from './retrieval/index.js'
import { AiService } from './ai/service.js'
import { AudioController } from './audio/controller.js'
import { registerIpc } from './ipc/register.js'

let retrieval: RetrievalIndex | undefined
let audio: AudioController | undefined
let quitting = false

app.whenReady().then(async () => {
  app.setAppUserModelId('com.presenterai.desktop')
  const store = new SettingsStore(); await store.initialize()
  const secrets = new SecretStore()
  const capture = new CaptureProtection(store)
  const windows = new WindowManager(store, capture); windows.create()
  retrieval = new RetrievalIndex(store); retrieval.initialize()
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
