import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels.js'
import type { PresenterAPI } from '../shared/contracts.js'
import { parseTranscriptDraft } from './transcriptValidation.js'

const api: PresenterAPI = {
  getStatus: () => ipcRenderer.invoke(channels.getStatus),
  getSettings: () => ipcRenderer.invoke(channels.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(channels.updateSettings, patch),
  getApiKeyStatus: () => ipcRenderer.invoke(channels.getApiKeyStatus),
  saveApiKey: (key) => ipcRenderer.invoke(channels.saveApiKey, key),
  deleteApiKey: () => ipcRenderer.invoke(channels.deleteApiKey),
  testApiKey: () => ipcRenderer.invoke(channels.testApiKey),
  ask: (question, answerFormat = 'auto') => ipcRenderer.invoke(channels.ask, question, answerFormat),
  cancel: () => ipcRenderer.invoke(channels.cancel),
  selectDocuments: () => ipcRenderer.invoke(channels.selectDocuments),
  listDocuments: () => ipcRenderer.invoke(channels.listDocuments),
  removeDocument: (id) => ipcRenderer.invoke(channels.removeDocument, id),
  searchDocuments: (query) => ipcRenderer.invoke(channels.searchDocuments, query),
  inspectDocument: (documentId, offset = 0, limit = 50) => ipcRenderer.invoke(channels.inspectDocument, { documentId, offset, limit }),
  clearSession: () => ipcRenderer.invoke(channels.clearSession),
  startNewSession: () => ipcRenderer.invoke(channels.startNewSession),
  getUsage: () => ipcRenderer.invoke(channels.getUsage),
  clearUsage: () => ipcRenderer.invoke(channels.clearUsage),
  clearCaptureResults: () => ipcRenderer.invoke(channels.clearCaptureResults),
  clearAllDocuments: () => ipcRenderer.invoke(channels.clearAllDocuments),
  acceptListeningConsent: (version) => ipcRenderer.invoke(channels.acceptListeningConsent, version),
  acknowledgeTransmissionPreview: (operationId, stage) => ipcRenderer.invoke(channels.acknowledgeTransmissionPreview, operationId, stage),
  deleteAllLocalData: (confirmation) => ipcRenderer.invoke(channels.deleteAllLocalData, confirmation),
  dismissSettingsRecoveryWarning: () => ipcRenderer.invoke(channels.dismissSettingsRecoveryWarning),
  setClickThrough: (enabled) => ipcRenderer.invoke(channels.clickThrough, enabled),
  setGlassTint: (value) => ipcRenderer.invoke(channels.glassTint, value),
  showSettings: () => ipcRenderer.invoke(channels.showSettings),
  toggleListening: () => ipcRenderer.invoke(channels.toggleListening),
  copyCode: (code) => ipcRenderer.invoke(channels.copyCode, code),
  ackListeningIndicator: (operationId) => ipcRenderer.invoke(channels.ackListeningIndicator, operationId),
  ackAnswerVisible: (operationId) => ipcRenderer.invoke(channels.ackAnswerVisible, operationId),
  ackTranscriptVisible: (operationId) => ipcRenderer.invoke(channels.ackTranscriptVisible, operationId),
  refreshAudioDevices: () => ipcRenderer.invoke(channels.refreshAudioDevices),
  setCaptureProtection: (enabled) => ipcRenderer.invoke(channels.setCaptureProtection, enabled),
  saveCaptureResult: (result) => ipcRenderer.invoke(channels.saveCaptureResult, result),
  removeCaptureResult: (id) => ipcRenderer.invoke(channels.removeCaptureResult, id),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value)
    ipcRenderer.on(channels.status, listener)
    return () => ipcRenderer.removeListener(channels.status, listener)
  },
  onFocusAsk: (callback) => { const listener = () => callback(); ipcRenderer.on(channels.focusAsk, listener); return () => ipcRenderer.removeListener(channels.focusAsk, listener) },
  onOpenSettings: (callback) => { const listener = () => callback(); ipcRenderer.on(channels.openSettings, listener); return () => ipcRenderer.removeListener(channels.openSettings, listener) }
  ,onOpenPrivacy: (callback) => { const listener = () => callback(); ipcRenderer.on(channels.openPrivacy, listener); return () => ipcRenderer.removeListener(channels.openPrivacy, listener) }
  ,onTranscriptDraft: (callback) => { const listener = (_event: Electron.IpcRendererEvent, draft: unknown) => { const parsed = parseTranscriptDraft(draft); if (parsed) callback(parsed) }; ipcRenderer.on(channels.transcriptDraft, listener); return () => ipcRenderer.removeListener(channels.transcriptDraft, listener) }
  ,onError: (callback) => { const listener = (_event: Electron.IpcRendererEvent, error: Parameters<typeof callback>[0]) => callback(error); ipcRenderer.on(channels.appError, listener); return () => ipcRenderer.removeListener(channels.appError, listener) }
}

contextBridge.exposeInMainWorld('presenter', api)
