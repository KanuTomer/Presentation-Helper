import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels.js'
import type { PresenterAPI } from '../shared/contracts.js'

const api: PresenterAPI = {
  getStatus: () => ipcRenderer.invoke(channels.getStatus),
  getSettings: () => ipcRenderer.invoke(channels.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(channels.updateSettings, patch),
  hasApiKey: () => ipcRenderer.invoke(channels.hasApiKey),
  saveApiKey: (key) => ipcRenderer.invoke(channels.saveApiKey, key),
  deleteApiKey: () => ipcRenderer.invoke(channels.deleteApiKey),
  testApiKey: () => ipcRenderer.invoke(channels.testApiKey),
  ask: (question) => ipcRenderer.invoke(channels.ask, question),
  cancel: () => ipcRenderer.invoke(channels.cancel),
  selectDocuments: () => ipcRenderer.invoke(channels.selectDocuments),
  listDocuments: () => ipcRenderer.invoke(channels.listDocuments),
  removeDocument: (id) => ipcRenderer.invoke(channels.removeDocument, id),
  clearSession: () => ipcRenderer.invoke(channels.clearSession),
  getUsage: () => ipcRenderer.invoke(channels.getUsage),
  setClickThrough: (enabled) => ipcRenderer.invoke(channels.clickThrough, enabled),
  setOpacity: (value) => ipcRenderer.invoke(channels.opacity, value),
  showSettings: () => ipcRenderer.invoke(channels.showSettings),
  startListening: () => ipcRenderer.invoke(channels.startListening),
  stopListening: () => ipcRenderer.invoke(channels.stopListening),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value)
    ipcRenderer.on(channels.status, listener)
    return () => ipcRenderer.removeListener(channels.status, listener)
  },
  onFocusAsk: (callback) => { const listener = () => callback(); ipcRenderer.on(channels.focusAsk, listener); return () => ipcRenderer.removeListener(channels.focusAsk, listener) },
  onOpenSettings: (callback) => { const listener = () => callback(); ipcRenderer.on(channels.openSettings, listener); return () => ipcRenderer.removeListener(channels.openSettings, listener) }
  ,onResponse: (callback) => { const listener = (_event: Electron.IpcRendererEvent, response: Parameters<typeof callback>[0]) => callback(response); ipcRenderer.on(channels.audioResponse, listener); return () => ipcRenderer.removeListener(channels.audioResponse, listener) }
  ,onError: (callback) => { const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message); ipcRenderer.on(channels.appError, listener); return () => ipcRenderer.removeListener(channels.appError, listener) }
}

contextBridge.exposeInMainWorld('presenter', api)
