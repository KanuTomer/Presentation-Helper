import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiKeyStatus, AppSettings, AppStatus, DocumentInfo, UsageLedger } from '../shared/contracts'
import { LISTENING_CONSENT_VERSION } from '../shared/contracts'
import { StatusRefreshGuard } from './statusRefresh'

export const blankStatus: AppStatus = {
  workspace: { mode: 'setup' },
  operation: 'idle', operationTimings: {}, listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
  helperState: 'missing', audioDevices: [], shortcutWarnings: [], shortcutRegistrations: [], capture: { requested: false, electronReported: false, verifiedResults: [] },
  clickThrough: { enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: false },
  privacyConsent: { requiredVersion: LISTENING_CONSENT_VERSION, satisfied: false },
  sessionUsage: {
    sessionId: 'loading', startedAt: new Date(0).toISOString(),
    actualUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, unpricedRequests: 0, pricingVersion: 'loading'
  }
}

const blankApiKeyStatus: ApiKeyStatus = { configured: false, masked: false, protection: 'unavailable' }

export interface AppState {
  status: AppStatus
  setStatus: React.Dispatch<React.SetStateAction<AppStatus>>
  settings?: AppSettings
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | undefined>>
  documents: DocumentInfo[]
  usage?: UsageLedger
  apiKeyStatus: ApiKeyStatus
  refresh(): Promise<void>
}

/** Main-process state shared by the Setup and presenter windows. */
export function useAppState(): AppState {
  const [status, setStatus] = useState(blankStatus)
  const [settings, setSettings] = useState<AppSettings>()
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [usage, setUsage] = useState<UsageLedger>()
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>(blankApiKeyStatus)
  const guard = useRef(new StatusRefreshGuard())
  const refresh = useCallback(async (): Promise<void> => {
    const ticket = guard.current.begin()
    const [nextStatus, nextSettings, docs, keyStatus, nextUsage] = await Promise.all([
      window.presenter.getStatus(), window.presenter.getSettings(), window.presenter.listDocuments(), window.presenter.getApiKeyStatus(), window.presenter.getUsage()
    ])
    if (!guard.current.acceptsResources(ticket)) return
    if (guard.current.acceptsStatus(ticket)) setStatus(nextStatus)
    setSettings(nextSettings); setDocuments(docs); setApiKeyStatus(keyStatus); setUsage(nextUsage)
  }, [])
  useEffect(() => {
    void refresh()
    return window.presenter.onStatus((value) => { guard.current.observeStatus(); setStatus(value) })
  }, [refresh])
  return { status, setStatus, settings, setSettings, documents, usage, apiKeyStatus, refresh }
}

/** Elapsed listening time, ticking while capture is active. */
export function useRecordingMs(status: AppStatus): number {
  const [recordingMs, setRecordingMs] = useState(0)
  useEffect(() => {
    if (status.operation !== 'listening') { setRecordingMs(0); return }
    const parsedStart = status.stageStartedAt ? Date.parse(status.stageStartedAt) : Number.NaN
    const startedAt = Number.isFinite(parsedStart) ? parsedStart : Date.now()
    setRecordingMs(Math.max(0, Date.now() - startedAt))
    const timer = window.setInterval(() => setRecordingMs(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [status.operation, status.stageStartedAt])
  return recordingMs
}

export function isBusy(status: AppStatus): boolean { return status.operation !== 'idle' && status.operation !== 'error' }

export function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' | 'danger' }): React.JSX.Element {
  return <div className={`notice ${tone}`}>{children}</div>
}
export function Info({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="info"><small>{label}</small><strong>{value}</strong></div>
}

export function handleContentScrollKey(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return
  const viewport = event.currentTarget
  const page = Math.max(1, Math.floor(viewport.clientHeight * 0.85))
  if (event.key === 'Home') viewport.scrollTop = 0
  else if (event.key === 'End') viewport.scrollTop = viewport.scrollHeight
  else if (event.key === 'PageDown') viewport.scrollTop += page
  else if (event.key === 'PageUp') viewport.scrollTop -= page
  else return
  event.preventDefault()
}
