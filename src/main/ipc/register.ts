import { dialog, globalShortcut, ipcMain } from 'electron'
import { channels } from '../../shared/channels.js'
import type { AppSettings, AppStatus } from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'
import type { SecretStore } from '../settings/secrets.js'
import type { RetrievalIndex } from '../retrieval/index.js'
import type { AiService } from '../ai/service.js'
import type { AudioController } from '../audio/controller.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { CaptureProtection } from '../windows/captureProtection.js'

interface Services { store: SettingsStore; secrets: SecretStore; retrieval: RetrievalIndex; ai: AiService; audio: AudioController; windows: WindowManager; capture: CaptureProtection }

function validate(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (!(url.startsWith('file:') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) throw new Error('Blocked IPC request from an untrusted frame.')
}

export function registerIpc(services: Services): void {
  const { store, secrets, retrieval, ai, audio, windows, capture } = services
  const handle = <T extends unknown[]>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown) => ipcMain.handle(channel, (event, ...args) => { validate(event); return fn(event, ...(args as T)) })
  const status = (): AppStatus => ({
    operation: audio.operation, capture: capture.status(windows.window), listening: audio.listening, audioSource: 'System output (WASAPI loopback)',
    temporaryAudioExists: Boolean(audio.temporaryAudio), helperAvailable: audio.helper.available, shortcutWarnings: windows.shortcutWarnings
  })
  const broadcast = (): void => windows.window?.webContents.send(channels.status, status())
  audio.onState = broadcast
  audio.onResponse = (response) => windows.window?.webContents.send(channels.audioResponse, response)
  audio.onError = (message) => windows.window?.webContents.send(channels.appError, message)

  handle(channels.getStatus, () => status())
  handle(channels.getSettings, () => store.settings)
  handle<[Partial<AppSettings>]>(channels.updateSettings, async (_event, patch) => {
    const previous = store.settings
    const settings = await store.updateSettings(patch)
    windows.setOpacity(settings.opacity); windows.setClickThrough(settings.clickThrough)
    const electronShortcutsChanged = patch.askShortcut !== undefined || patch.hideShortcut !== undefined
    if (electronShortcutsChanged && !windows.registerShortcuts()) {
      const warning = windows.shortcutWarnings[0]
      await store.updateSettings({ askShortcut: previous.askShortcut, hideShortcut: previous.hideShortcut }); windows.registerShortcuts()
      throw new Error(warning ?? 'The shortcut could not be registered.')
    }
    if (patch.listenShortcut !== undefined) {
      try { await audio.configureShortcut(settings.listenShortcut) }
      catch (error) { await store.updateSettings({ listenShortcut: previous.listenShortcut }); await audio.configureShortcut(previous.listenShortcut); throw error }
    }
    broadcast(); return store.settings
  })
  handle(channels.hasApiKey, () => secrets.hasKey())
  handle<[string]>(channels.saveApiKey, (_event, key) => secrets.saveKey(key))
  handle(channels.deleteApiKey, () => secrets.deleteKey())
  handle(channels.testApiKey, () => ai.testKey())
  handle<[string]>(channels.ask, async (_event, question) => {
    audio.operation = 'retrieving'; broadcast()
    globalShortcut.register('Escape', () => void audio.cancel())
    try { audio.operation = 'generating'; broadcast(); return await ai.ask(question) }
    finally { globalShortcut.unregister('Escape'); audio.operation = 'idle'; broadcast() }
  })
  handle(channels.cancel, () => audio.cancel())
  handle(channels.clearSession, () => { ai.clearSession() })
  handle(channels.getUsage, () => store.usage)
  handle(channels.listDocuments, () => store.documents)
  handle(channels.selectDocuments, async () => {
    const result = await dialog.showOpenDialog(windows.window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Presentation documents', extensions: ['pptx', 'pdf', 'md', 'markdown', 'txt'] }] })
    return result.canceled ? store.documents : retrieval.addFiles(result.filePaths)
  })
  handle<[string]>(channels.removeDocument, (_event, id) => retrieval.remove(id))
  handle<[boolean]>(channels.clickThrough, async (_event, enabled) => { windows.setClickThrough(enabled); await store.updateSettings({ clickThrough: enabled }) })
  handle<[number]>(channels.opacity, async (_event, value) => { windows.setOpacity(value); await store.updateSettings({ opacity: value }) })
  handle(channels.showSettings, () => windows.openSettings())
  handle(channels.startListening, () => audio.startCapture())
  handle(channels.stopListening, () => audio.stopAndProcess())
}
