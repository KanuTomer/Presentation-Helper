import { app, clipboard, dialog, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { channels } from '../../shared/channels.js'
import {
  documentImportResultSchema, documentInspectionPageSchema, documentSearchHitsSchema, transcriptionDraftSchema,
  type AppSettings, type AppStatus, type CaptureTestInput,
  type DeleteAllLocalDataResult, type DocumentInspectionPage, type DocumentSearchHit,
  type OutboundTransmissionPreview
} from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'
import type { SecretStore } from '../settings/secrets.js'
import type { RetrievalIndex } from '../retrieval/index.js'
import type { AiService } from '../ai/service.js'
import { TypedAnswerController } from '../ai/typedAnswerController.js'
import type { AudioController } from '../audio/controller.js'
import { operationError } from '../operations/coordinator.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { CaptureProtection } from '../windows/captureProtection.js'
import { parseDocumentId, parseDocumentInspectionRequest, parseDocumentSearchQuery } from './documentValidation.js'
import { parseSettingsPatch, validateSettingsMutation } from '../settings/validation.js'
import type { TransmissionPreviewGate } from '../privacy/transmissionPreview.js'
import { LocalDataDeletionService } from '../settings/dataDeletion.js'
import { ShortcutSettingsTransaction } from '../settings/shortcutTransaction.js'
import { scheduleRelaunchAfterDeletion } from './relaunchAfterDeletion.js'
import { parseAnswerFormat, parseClipboardCode } from './interactionValidation.js'

interface Services {
  store: SettingsStore
  secrets: SecretStore
  retrieval: RetrievalIndex
  ai: AiService
  audio: AudioController
  windows: WindowManager
  capture: CaptureProtection
  transmissionPreview: TransmissionPreviewGate
}
export interface RegisteredIpcServices { deletion: LocalDataDeletionService }

function validate(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (!(url.startsWith('file:') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) throw new Error('Blocked IPC request from an untrusted frame.')
}

export function registerIpc(services: Services): RegisteredIpcServices {
  const { store, secrets, retrieval, ai, audio, windows, capture, transmissionPreview } = services
  const handle = <T extends unknown[]>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown) => ipcMain.handle(channel, (event, ...args) => { validate(event); return fn(event, ...(args as T)) })
  const status = (): AppStatus => {
    const { escapeWarning, ...operationStatus } = audio.operations.snapshot()
    return {
      ...operationStatus, capture: capture.status(windows.window), listening: audio.listening,
      audioSource: audio.activeEndpoint?.name ?? audio.devices.find((device) => device.id === store.settings.selectedAudioEndpointId)?.name ?? 'Windows default output (WASAPI loopback)',
      temporaryAudioExists: Boolean(audio.temporaryAudio), helperAvailable: audio.helper.available, helperState: audio.helper.state,
      helperError: audio.helper.lastError ?? audio.warning, audioDevices: audio.devices, selectedAudioEndpointId: store.settings.selectedAudioEndpointId,
      lastCapture: audio.lastCapture, activeAudioEndpoint: audio.activeEndpoint,
      shortcutWarnings: [...windows.shortcutWarnings, ...(escapeWarning ? [escapeWarning] : [])],
      privacyConsent: store.privacyConsent,
      sessionBudget: store.sessionBudgetStatus,
      ...(transmissionPreview.current ? { outboundPreview: transmissionPreview.current } : {}),
      ...(store.recoveryWarning ? { settingsRecoveryWarning: store.recoveryWarning } : {})
    }
  }
  const broadcast = (): void => windows.window?.webContents.send(channels.status, status())
  audio.onState = broadcast
  audio.onTranscriptDraft = (draft) => windows.window?.webContents.send(channels.transcriptDraft, transcriptionDraftSchema.parse(draft))
  audio.onError = (error) => windows.window?.webContents.send(channels.appError, error)
  const deletion = new LocalDataDeletionService(() => audio.operations.acquireMaintenance(), {
    session: async () => { ai.clearSession(); await store.startNewSession() },
    documents: () => retrieval.clearAll(),
    usage: () => store.clearUsage(),
    compatibility: () => store.clearCaptureResults(),
    consent: () => store.clearListeningConsent(),
    apiKey: () => secrets.deleteKey(),
    temporaryAudio: () => audio.clearOwnedTemporaryAudioForMaintenance(),
    settings: async () => {
      const defaults = await store.resetSettings()
      await store.clearWindowBounds()
      await store.dismissRecoveryWarning()
      if (!windows.applyShortcutSet(defaults.askShortcut, defaults.hideShortcut, defaults)) {
        throw new Error('Default application shortcuts could not be registered. Restart PresenterAI and retry deletion.')
      }
      if (audio.helper.available) {
        await audio.configureShortcut(defaults.listenShortcut)
      }
      windows.setGlassTint(defaults.glassTint)
      windows.setClickThrough(defaults.clickThrough)
    }
  })
  const shortcutTransaction = new ShortcutSettingsTransaction(
    windows,
    (accelerator) => audio.configureShortcut(accelerator)
  )
  const typedAnswers = new TypedAnswerController(ai, audio.operations, transmissionPreview)

  handle(channels.getStatus, () => status())
  handle(channels.getSettings, () => store.settings)
  handle<[unknown]>(channels.updateSettings, async (_event, value) => {
    const patch = parseSettingsPatch(value)
    const previous = store.settings
    validateSettingsMutation(previous, patch, audio.operations.isBusy)
    const next = { ...previous, ...patch }
    const shortcutsChanged = ['askShortcut', 'hideShortcut', 'listenShortcut']
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key))
    const settings = shortcutsChanged
      ? await shortcutTransaction.apply({
          previous,
          next,
          commit: () => store.updateSettings(patch),
          rollbackPersistence: () => store.updateSettings(previous)
        })
      : await store.updateSettings(patch)
    windows.setGlassTint(settings.glassTint)
    windows.setClickThrough(settings.clickThrough)
    if (Object.prototype.hasOwnProperty.call(patch, 'selectedAudioEndpointId')) {
      try { await audio.refreshDevices() }
      catch (error) {
        audio.warning = `The setting was saved, but audio devices could not be refreshed: ${(error as Error).message}`
      }
    }
    broadcast()
    return settings
  })
  handle(channels.getApiKeyStatus, () => secrets.status())
  handle<[string]>(channels.saveApiKey, (_event, key) => secrets.saveKey(key))
  handle(channels.deleteApiKey, () => secrets.deleteKey())
  handle(channels.testApiKey, () => ai.testKey())
  handle<[unknown, unknown]>(channels.ask, (_event, question, requestedFormat) => {
    if (typeof question !== 'string') throw new Error('Invalid question.')
    return typedAnswers.ask(question, parseAnswerFormat(requestedFormat))
  })
  handle(channels.cancel, () => audio.cancel())
  handle(channels.clearSession, () => { ai.clearSession() })
  handle(channels.startNewSession, async () => {
    ensureIdle(audio)
    ai.clearSession()
    const budget = await store.startNewSession()
    broadcast()
    return budget
  })
  handle(channels.getUsage, () => store.usageLedger)
  handle(channels.clearUsage, async () => { ensureIdle(audio); await store.clearUsage(); broadcast() })
  handle(channels.clearCaptureResults, async () => { ensureIdle(audio); await store.clearCaptureResults(); broadcast() })
  handle<[unknown]>(channels.acceptListeningConsent, async (_event, version) => {
    if (!Number.isInteger(version) || version !== store.privacyConsent.requiredVersion) {
      throw new Error('The listening disclosure version is not current.')
    }
    const result = await store.acceptListeningConsent(version as number)
    broadcast()
    return result
  })
  handle<[unknown, unknown]>(channels.acknowledgeTransmissionPreview, (_event, operationId, stage) => {
    if (!validOperationId(operationId) || (stage !== 'transcription' && stage !== 'response')) {
      throw new Error('Invalid transmission-preview acknowledgement.')
    }
    transmissionPreview.acknowledge(operationId, stage as OutboundTransmissionPreview['stage'])
  })
  handle(channels.dismissSettingsRecoveryWarning, async () => { await store.dismissRecoveryWarning(); broadcast() })
  handle(channels.listDocuments, () => retrieval.listDocuments())
  handle(channels.selectDocuments, async () => {
    const result = await dialog.showOpenDialog(windows.window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Presentation documents', extensions: ['pptx', 'pdf', 'md', 'markdown', 'txt'] }] })
    if (result.canceled) return { documents: retrieval.listDocuments(), outcomes: [] }
    return documentImportResultSchema.parse(await retrieval.addFiles(result.filePaths))
  })
  handle<[unknown]>(channels.removeDocument, (_event, id) => retrieval.remove(parseDocumentId(id)))
  handle(channels.clearAllDocuments, async () => { ensureIdle(audio); await retrieval.clearAll(); broadcast() })
  handle<[unknown]>(channels.searchDocuments, async (_event, query): Promise<DocumentSearchHit[]> => {
    const normalized = parseDocumentSearchQuery(query)
    return documentSearchHitsSchema.parse(await retrieval.searchDocuments(normalized))
  })
  handle<[unknown]>(channels.inspectDocument, async (_event, request): Promise<DocumentInspectionPage> => {
    const parsed = parseDocumentInspectionRequest(request)
    const page = await retrieval.inspectDocument(parsed.documentId, parsed.offset, parsed.limit)
    return documentInspectionPageSchema.parse(page)
  })
  handle<[boolean]>(channels.clickThrough, async (_event, enabled) => { windows.setClickThrough(enabled); await store.updateSettings({ clickThrough: enabled }) })
  handle<[number]>(channels.glassTint, async (_event, value) => { windows.setGlassTint(value); await store.updateSettings({ glassTint: value }) })
  handle(channels.showSettings, () => windows.openSettings())
  handle(channels.toggleListening, () => audio.toggleListening())
  handle<[unknown]>(channels.copyCode, (_event, value) => {
    clipboard.writeText(parseClipboardCode(value))
  })
  handle(channels.refreshAudioDevices, () => audio.refreshDevices(true))
  handle<[string]>(channels.ackListeningIndicator, (_event, operationId) => {
    if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 128) throw new Error('Invalid operation identifier.')
    audio.acknowledgeListeningIndicator(operationId)
  })
  handle<[string]>(channels.ackAnswerVisible, (_event, operationId) => {
    if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 128) throw new Error('Invalid operation identifier.')
    audio.acknowledgeAnswerVisible(operationId)
  })
  handle<[string]>(channels.ackTranscriptVisible, (_event, operationId) => {
    if (!validOperationId(operationId)) throw new Error('Invalid operation identifier.')
    audio.acknowledgeTranscriptVisible(operationId)
  })
  handle<[boolean]>(channels.setCaptureProtection, (_event, enabled) => {
    if (!windows.window) throw new Error('Overlay window is unavailable.')
    capture.setEnabled(windows.window, enabled); broadcast()
  })
  handle<[CaptureTestInput]>(channels.saveCaptureResult, async (_event, input) => {
    const gpu = await app.getGPUInfo('basic') as { gpuDevice?: Array<{ deviceString?: string }> }
    const result = {
      ...input, id: randomUUID(), testedAt: new Date().toISOString(),
      environment: {
        windowsBuild: process.getSystemVersion(), presenterVersion: app.getVersion(), electronVersion: process.versions.electron,
        gpu: gpu.gpuDevice?.[0]?.deviceString ?? 'Unknown', monitorCount: screen.getAllDisplays().length
      }
    }
    await store.addCaptureResult(result); broadcast(); return result
  })
  handle<[string]>(channels.removeCaptureResult, async (_event, id) => { await store.removeCaptureResult(id); broadcast() })
  handle<[unknown]>(channels.deleteAllLocalData, async (_event, confirmation): Promise<DeleteAllLocalDataResult> => {
    const outcome = await deletion.deleteAll(confirmation)
    broadcast()
    scheduleRelaunchAfterDeletion(outcome, app)
    return outcome
  })
  return { deletion }
}

function ensureIdle(audio: AudioController): void {
  if (audio.operations.isBusy) {
    throw operationError('busy', 'Finish or cancel the active PresenterAI operation before clearing local data.', false)
  }
}

function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}
