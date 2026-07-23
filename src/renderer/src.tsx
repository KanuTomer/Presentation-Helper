import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AiErrorInfo, AnswerFormat, ApiKeyStatus, AppSettings, AppStatus, AssistantResponse, DocumentInfo,
  TranscriptionDraft, UsageLedger
} from '../shared/contracts'
import { LISTENING_CONSENT_VERSION } from '../shared/contracts'
import './style.css'
import { AiErrorPanel } from './aiError'
import { DocumentsView } from './documents'
import { ToggleListenButton, OperationBanner, StageTimingSummary } from './operationUi'
import { ResponseCard } from './responseCard'
import { LiquidGlassLayer } from './liquidGlass'
import { answerFormatAfterSubmission, ClickThroughBanner, CopilotQuickControls } from './quickControls'
import { ApprovedVocabularyEditor } from './vocabularyEditor'
import { StatusRefreshGuard } from './statusRefresh'
import { ShortcutSettingsPanel } from './shortcutRecorder'
import { canInsertTranscriptDirectly, mergeTranscriptDraft, TranscriptDraftNotice } from './transcriptDraft'
import {
  ListeningConsentPanel, PrivacyDisclosure, RetentionControls, SessionBudgetPanel, TransmissionPreviewPanel, UsageEstimatePanel
} from './privacyControls'

type View = 'copilot' | 'documents' | 'settings' | 'privacy' | 'capture'

export const blankStatus: AppStatus = {
  operation: 'idle', operationTimings: {}, listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
  helperState: 'missing', audioDevices: [], shortcutWarnings: [], capture: { requested: false, electronReported: false, verifiedResults: [] },
  clickThrough: { enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: false },
  privacyConsent: { requiredVersion: LISTENING_CONSENT_VERSION, satisfied: false },
  sessionBudget: {
    sessionId: 'loading', startedAt: new Date(0).toISOString(), capUsd: 0.25,
    actualUsd: 0, heldUsd: 0, remainingUsd: 0.25, pricingVersion: 'loading', blocked: false
  }
}

const blankApiKeyStatus: ApiKeyStatus = { configured: false, masked: false, protection: 'unavailable' }

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('copilot')
  const [status, setStatus] = useState(blankStatus)
  const [settings, setSettings] = useState<AppSettings>()
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [usage, setUsage] = useState<UsageLedger>()
  const [question, setQuestion] = useState('')
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('code')
  const [response, setResponse] = useState<AssistantResponse>()
  const [transcriptDraft, setTranscriptDraft] = useState<{ draft: TranscriptionDraft; conflict: boolean }>()
  const [aiError, setAiError] = useState<AiErrorInfo>()
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>(blankApiKeyStatus)
  const [recordingMs, setRecordingMs] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const questionRef = useRef('')
  const composerRevision = useRef(0)
  const captureComposer = useRef<{ operationId: string; text: string; revision: number } | undefined>(undefined)
  const refreshGuard = useRef(new StatusRefreshGuard())
  const neonSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSubmittedFormat = useRef<AnswerFormat>('code')
  const showAiError = useCallback((value: AiErrorInfo) => { setAiError(value); setView('copilot') }, [])
  const setQuestionFromUser = useCallback((value: string) => {
    composerRevision.current += 1
    questionRef.current = value
    setQuestion(value)
  }, [])
  const clearRendererSession = useCallback(() => {
    captureComposer.current = undefined
    composerRevision.current += 1
    questionRef.current = ''
    setQuestion('')
    setTranscriptDraft(undefined)
    setResponse(undefined)
    setAiError(undefined)
    setAnswerFormat(answerFormatAfterSubmission())
  }, [])

  const refresh = async (): Promise<void> => {
    const ticket = refreshGuard.current.begin()
    const [nextStatus, nextSettings, docs, keyStatus, nextUsage] = await Promise.all([
      window.presenter.getStatus(), window.presenter.getSettings(), window.presenter.listDocuments(), window.presenter.getApiKeyStatus(), window.presenter.getUsage()
    ])
    if (!refreshGuard.current.acceptsResources(ticket)) return
    if (refreshGuard.current.acceptsStatus(ticket)) setStatus(nextStatus)
    setSettings(nextSettings); setDocuments(docs); setApiKeyStatus(keyStatus); setUsage(nextUsage)
  }
  useEffect(() => {
    void refresh()
    const cleanups = [
      window.presenter.onStatus((value) => { refreshGuard.current.observeStatus(); setStatus(value) }),
      window.presenter.onFocusAsk(() => { setView('copilot'); setTimeout(() => input.current?.focus(), 0) }),
      window.presenter.onOpenSettings(() => setView('settings')),
      window.presenter.onOpenPrivacy(() => setView('privacy')),
      window.presenter.onTranscriptDraft((draft) => {
        const snapshot = captureComposer.current
        const canInsert = canInsertTranscriptDirectly(snapshot, draft.operationId, questionRef.current, composerRevision.current)
        if (canInsert) {
          questionRef.current = draft.text
          setQuestion(draft.text)
        }
        setTranscriptDraft({ draft, conflict: !canInsert })
        setAiError(undefined); setView('copilot'); setTimeout(() => input.current?.focus(), 0)
      }),
      window.presenter.onError(showAiError)
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [])
  useEffect(() => () => {
    if (neonSaveTimer.current) clearTimeout(neonSaveTimer.current)
  }, [])
  useEffect(() => { questionRef.current = question }, [question])
  useEffect(() => {
    if (status.operationKind !== 'audio' || !status.operationId || !['starting_capture', 'listening'].includes(status.operation)) return
    if (captureComposer.current?.operationId === status.operationId) return
    captureComposer.current = { operationId: status.operationId, text: questionRef.current, revision: composerRevision.current }
  }, [status.operation, status.operationId, status.operationKind])
  useEffect(() => {
    if (!transcriptDraft) return
    const operationId = transcriptDraft.draft.operationId
    let paintedFrame = 0
    const renderedFrame = window.requestAnimationFrame(() => {
      paintedFrame = window.requestAnimationFrame(() => {
        void window.presenter.ackTranscriptVisible(operationId).catch(() => {
          showAiError({ code: 'transcript_display_unavailable', message: 'PresenterAI could not confirm that the transcript became visible.', retryable: true })
        })
      })
    })
    return () => { window.cancelAnimationFrame(renderedFrame); if (paintedFrame) window.cancelAnimationFrame(paintedFrame) }
  }, [transcriptDraft?.draft.operationId, showAiError])
  useEffect(() => {
    if (status.operation !== 'listening') { setRecordingMs(0); return }
    const parsedStart = status.stageStartedAt ? Date.parse(status.stageStartedAt) : Number.NaN
    const startedAt = Number.isFinite(parsedStart) ? parsedStart : Date.now()
    setRecordingMs(Math.max(0, Date.now() - startedAt))
    const timer = window.setInterval(() => setRecordingMs(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [status.operation, status.stageStartedAt])
  useEffect(() => {
    if (status.operationKind === 'audio' && (status.operation === 'starting_capture' || status.operation === 'listening')) {
      setAiError(undefined)
    }
  }, [status.operation, status.operationId, status.operationKind])

  const ask = async (formatOverride?: AnswerFormat): Promise<void> => {
    if (transcriptDraft?.conflict) {
      setAiError({ code: 'invalid_transcript', message: 'Choose Replace, Append, or Discard for the pending transcript before submitting.', retryable: false })
      return
    }
    setAiError(undefined); setResponse(undefined)
    setTranscriptDraft(undefined)
    const requestedFormat = formatOverride ?? answerFormat
    lastSubmittedFormat.current = requestedFormat
    // Presenter is an explicit one-request override. Code remains the visible
    // default throughout generation and after every submission.
    setAnswerFormat(answerFormatAfterSubmission())
    try {
      const result = await window.presenter.ask(question, requestedFormat)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
  }

  const updateNeonIntensity = (neonIntensity: number): void => {
    const bounded = Math.max(0, Math.min(1, neonIntensity))
    setSettings((current) => current ? { ...current, neonIntensity: bounded } : current)
    if (neonSaveTimer.current) clearTimeout(neonSaveTimer.current)
    neonSaveTimer.current = setTimeout(() => {
      void window.presenter.updateSettings({ neonIntensity: bounded }).catch((error) => {
        showAiError({ code: 'unknown', message: (error as Error).message || 'The neon intensity could not be saved.', retryable: false })
        void refresh()
      })
    }, 120)
  }

  const setClickThrough = async (enabled: boolean): Promise<void> => {
    try {
      const clickThrough = await window.presenter.setClickThrough(enabled)
      setStatus((current) => ({ ...current, clickThrough }))
    } catch (error) {
      showAiError({ code: 'unknown', message: (error as Error).message || 'Click-through could not be changed safely.', retryable: false })
      throw error
    }
  }

  const neonIntensity = settings?.neonIntensity ?? 0.65
  return <main
    className={`shell ${status.listening ? 'is-listening' : ''}`}
    style={{ '--neon-intensity': neonIntensity } as React.CSSProperties}
  >
    <LiquidGlassLayer neonIntensity={neonIntensity} />
    {status.outboundPreview && <TransmissionPreviewPanel
      preview={status.outboundPreview}
      onRendered={(operationId, stage) => window.presenter.acknowledgeTransmissionPreview(operationId, stage)}
      onCancel={() => window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) })}
      onError={(message) => showAiError({ code: 'privacy_preview_unavailable', message, retryable: true })}
    />}
    <header className="titlebar drag-region">
      <div className="brand"><span className="brand-mark">P</span><div><strong>PresenterAI</strong><small>local-first copilot</small></div></div>
      <div className="status-row no-drag">
        <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />
        <button className="icon-button" onClick={() => setView('capture')} title="Capture protection status">{status.capture.electronReported ? 'Electron: on*' : 'Unverified'}</button>
      </div>
    </header>

    <OperationBanner status={status} elapsedMs={recordingMs} onError={showAiError} onCancel={() => { void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }) }} />
    <ClickThroughBanner status={status.clickThrough} />

    <nav className="tabs no-drag">
      {(['copilot', 'documents', 'settings', 'privacy'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
    </nav>

    <section className="content no-drag" tabIndex={0} aria-label={`${view} content`} onKeyDown={handleContentScrollKey}>
      {status.settingsRecoveryWarning && <Notice tone="warning"><strong>Settings were recovered safely.</strong> The prior file was {status.settingsRecoveryWarning.code.replaceAll('_', ' ')}. <button onClick={async () => { await window.presenter.dismissSettingsRecoveryWarning(); await refresh() }}>Dismiss</button></Notice>}
      {view === 'copilot' && <Copilot question={question} setQuestion={setQuestionFromUser} transcriptDraft={transcriptDraft} resolveTranscript={(choice) => {
        if (!transcriptDraft) return
        if (choice !== 'discard') setQuestionFromUser(mergeTranscriptDraft(questionRef.current, transcriptDraft.draft.text, choice))
        setTranscriptDraft(undefined); setTimeout(() => input.current?.focus(), 0)
      }} answerFormat={answerFormat} setAnswerFormat={setAnswerFormat} neonIntensity={neonIntensity} onNeonIntensityChange={updateNeonIntensity} onSetClickThrough={setClickThrough} input={input} ask={() => ask()} retry={() => ask(lastSubmittedFormat.current)} response={response} aiError={aiError ?? status.operationError} openSettings={() => setView('settings')} openPrivacy={() => setView('privacy')} hasKey={apiKeyStatus.configured} status={status} onAudioError={showAiError} />}
      {view === 'documents' && <DocumentsView documents={documents} onChange={refresh} />}
      {view === 'settings' && settings && <Settings settings={settings} status={status} recordingMs={recordingMs} apiKeyStatus={apiKeyStatus} onChange={refresh} />}
      {view === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} settings={settings} onNewSession={async () => {
        await window.presenter.startNewSession()
        clearRendererSession()
        await refresh()
      }} onDeleteAllSuccess={clearRendererSession} onChange={refresh} />}
      {view === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
    </section>
    <footer><span>Audio defaults OFF</span><span>Ctrl+Shift+I restores interaction</span></footer>
  </main>
}

function Copilot(props: { question: string; setQuestion(v: string): void; transcriptDraft?: { draft: TranscriptionDraft; conflict: boolean }; resolveTranscript(choice: 'replace' | 'append' | 'discard'): void; answerFormat: AnswerFormat; setAnswerFormat(v: AnswerFormat): void; neonIntensity: number; onNeonIntensityChange(value: number): void; onSetClickThrough(enabled: boolean): Promise<void>; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; retry(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; openPrivacy(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void }) {
  const busy = props.status.operation !== 'idle' && props.status.operation !== 'error'
  const canSubmit = props.hasKey && Boolean(props.question.trim()) && !busy && !props.transcriptDraft?.conflict
  const retryIsSafe = props.status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout', 'transcript_display_unavailable'].includes(props.aiError?.code ?? '')
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <CopilotQuickControls
      answerFormat={props.answerFormat}
      neonIntensity={props.neonIntensity}
      clickThrough={props.status.clickThrough}
      answerStyleDisabled={busy}
      onAnswerFormatChange={props.setAnswerFormat}
      onNeonIntensityChange={props.onNeonIntensityChange}
      onSetClickThrough={props.onSetClickThrough}
    />
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSubmit) void props.ask() } }} />
      {props.transcriptDraft && <TranscriptDraftNotice draft={props.transcriptDraft.draft} conflict={props.transcriptDraft.conflict} onResolve={props.resolveTranscript} />}
      <div className="composer-toolbar">
        <span className="submission-hint">{props.answerFormat === 'code' ? 'Developer response' : 'Presenter response · one request'}</span>
        <div className="actions"><button className="primary" disabled={!canSubmit} title={busy ? 'Another operation is active.' : props.transcriptDraft?.conflict ? 'Resolve the pending transcript first.' : undefined} onClick={() => void props.ask()}>{props.answerFormat === 'code' ? 'Generate code' : 'Ask presenter'} <kbd>Ctrl↵</kbd></button>
          <ToggleListenButton status={props.status} onError={props.onAudioError} /></div>
      </div>
    </div>
    {props.aiError && <AiErrorPanel error={props.aiError} allowRetry={retryIsSafe} onRetry={props.retry} onOpenSettings={props.openSettings} onOpenPrivacy={props.openPrivacy} />}
    {props.response ? <ResponseCard response={props.response} onCopyCode={(code) => window.presenter.copyCode(code)} /> : <div className="empty"><div className="wave">∿</div><h2>Ready when you are</h2><p>Type a question, or toggle system-audio listening. After transcription, review the draft and press Ctrl + Enter.</p></div>}
  </div>
}

function Settings({ settings, status, recordingMs, apiKeyStatus, onChange }: { settings: AppSettings; status: AppStatus; recordingMs: number; apiKeyStatus: ApiKeyStatus; onChange(): Promise<void> }) {
  const keyInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState(''); const [failure, setFailure] = useState('')
  const update = async (patch: Partial<AppSettings>) => {
    setFailure('')
    try { await window.presenter.updateSettings(patch); await onChange() }
    catch (error) { setFailure((error as Error).message || 'The setting could not be saved.') }
  }
  const busy = status.operation !== 'idle' && status.operation !== 'error'
  return <div className="stack"><h2>Settings</h2>
    {failure && <Notice tone="danger">{failure}</Notice>}
    <fieldset><legend>OpenAI API key</legend><p>{apiKeyStatus.configured ? 'A masked, DPAPI-encrypted key is stored for this Windows user.' : 'No API key is stored.'}</p>{apiKeyStatus.updatedAt && <small>Last replaced {new Date(apiKeyStatus.updatedAt).toLocaleString()}</small>}<p className="muted">Protection: {apiKeyStatus.protection === 'windows-dpapi' ? 'Windows DPAPI' : 'secure storage unavailable'}. DPAPI primarily protects against other Windows users, not every process already running as you.</p><input ref={keyInput} type="password" autoComplete="off" placeholder="sk-…" /><div className="actions"><button className="primary" onClick={async () => { const value = keyInput.current?.value.trim() ?? ''; if (keyInput.current) keyInput.current.value = ''; try { await window.presenter.saveApiKey(value); setMessage('Key saved.'); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be saved.') } }}>Save key</button><button disabled={!apiKeyStatus.configured} onClick={async () => { try { setMessage((await window.presenter.testApiKey()).message) } catch (e) { setFailure((e as Error).message || 'The API key could not be tested.') } }}>Test</button><button disabled={!apiKeyStatus.configured} onClick={async () => { try { await window.presenter.deleteApiKey(); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be deleted.') } }}>Delete</button></div>{message && <small>{message}</small>}</fieldset>
    <fieldset><legend>Answer model</legend><select value={settings.modelMode} onChange={(e) => void update({ modelMode: e.target.value as AppSettings['modelMode'] })}><option value="normal">Normal · {settings.normalModel}</option><option value="strong">Strong · {settings.strongModel}</option></select></fieldset>
    <fieldset><legend>System audio output</legend><p className="muted">PresenterAI captures all sound played through the selected Windows output device. It does not listen to the microphone.</p><div className="helper-health"><span className={`health-dot ${status.helperState}`} /><strong>{status.helperState}</strong></div>{status.operation === 'listening' && <p>Recording: {(recordingMs / 1000).toFixed(1)} seconds</p>}<Info label="Active capture endpoint" value={status.activeAudioEndpoint?.name ?? 'None — listening is off'} />{status.helperError && <Notice tone={status.helperState === 'failed' ? 'danger' : 'warning'}>{status.helperError}</Notice>}{status.helperState === 'missing' && <p className="muted">Reinstall PresenterAI or run the packaged build so the Windows helper is available.</p>}{status.helperState === 'failed' && <p className="muted">An unsigned helper may have been blocked by Windows Smart App Control or App Control. PresenterAI never disables that protection. Retry after using a trusted-signed build or an authorized development environment.</p>}<label>Preferred output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label><button onClick={async () => { setFailure(''); try { await window.presenter.refreshAudioDevices(); await onChange() } catch (e) { setFailure((e as Error).message || 'The Windows audio helper could not be retried.') } }}>{status.helperState === 'failed' ? 'Retry helper' : 'Refresh devices'}</button>{status.shortcutWarnings.map((warning) => <Notice tone="warning" key={warning}>{warning}</Notice>)}</fieldset>
    <ApprovedVocabularyEditor terms={settings.approvedVocabulary} onChange={(approvedVocabulary) => update({ approvedVocabulary })} />
    <fieldset><legend>Project summary</legend><textarea value={settings.projectSummary} onChange={(e) => void update({ projectSummary: e.target.value })} placeholder="Optional user-authored facts that may be sent with each request." /></fieldset>
    <ShortcutSettingsPanel askShortcut={settings.askShortcut} hideShortcut={settings.hideShortcut} listenShortcut={settings.listenShortcut} disabled={busy} onChange={update} />
    <fieldset><legend>Session spending limit</legend><label>Maximum USD per session<input type="number" min="0.01" max="100" step="0.01" value={settings.sessionBudgetUsd} onChange={(event) => void update({ sessionBudgetUsd: Number(event.target.value) })} /></label><p className="muted">Default: $0.25. PresenterAI reserves a conservative maximum before each request. This limits only requests sent by PresenterAI; it is not an OpenAI account-level billing limit.</p></fieldset>
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} transcriptRenderLatencyMs={status.transcriptRenderLatencyMs} />
  </div>
}

function Privacy({ status, recordingMs, documents, usage, settings, onNewSession, onDeleteAllSuccess, onChange }: { status: AppStatus; recordingMs: number; documents: DocumentInfo[]; usage?: UsageLedger; settings?: AppSettings; onNewSession(): Promise<void>; onDeleteAllSuccess(): void; onChange(): Promise<void> }) {
  const busy = status.operation !== 'idle' && status.operation !== 'error'
  const refreshAfter = async (action: () => Promise<unknown>): Promise<void> => { await action(); await onChange() }
  const usageView = usage ? {
    estimatedUsd: usage.summary.estimatedUsd,
    pricingVersion: usage.summary.pricingVersion,
    requestCount: usage.recent.length + usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0),
    unpricedRequestCount: usage.recent.filter((record) => !record.priced).length + usage.rollups.reduce((total, rollup) => total + rollup.unpricedRequestCount, 0),
    rolledUpRequestCount: usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0)
  } : undefined
  return <div className="stack"><h2>Privacy & usage</h2><Notice tone="warning">Live AI assistance may be prohibited in interviews, examinations, or graded assessments. Check the applicable rules and obtain consent where required.</Notice>
    <ListeningConsentPanel consent={status.privacyConsent} disabled={busy} onAccept={async (version) => { await window.presenter.acceptListeningConsent(version); await onChange() }} />
    <div className="info-grid"><Info label="Listening" value={status.operation === 'listening' ? `ACTIVE · ${(recordingMs / 1000).toFixed(1)}s` : 'OFF'} /><Info label="Active audio endpoint" value={status.activeAudioEndpoint?.name ?? 'None'} /><Info label="Preferred audio source" value={status.audioSource} /><Info label="Audio helper" value={status.helperState} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Exists during capture/transcription only' : 'None'} /><Info label="Last capture" value={status.lastCapture ? `${(status.lastCapture.durationMs / 1000).toFixed(1)}s · ${status.lastCapture.sampleRate} Hz mono · ${status.lastCapture.endpointName}` : 'None this session'} /><Info label="Last answer render" value={status.answerRenderConfirmed === undefined ? 'Not measured' : status.answerRenderConfirmed ? 'Confirmed visible' : 'Not confirmed'} /><Info label="Approved vocabulary" value={`${settings?.approvedVocabulary.length ?? 0} terms`} /><Info label="Local documents" value={`${documents.length} indexed`} /></div>
    <PrivacyDisclosure />
    <SessionBudgetPanel budget={status.sessionBudget} disabled={busy} onNewSession={onNewSession} />
    {usageView && <UsageEstimatePanel usage={usageView} />}
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} transcriptRenderLatencyMs={status.transcriptRenderLatencyMs} />
    <RetentionControls busy={busy} onDeleteAllSuccess={onDeleteAllSuccess} actions={{
      clearSession: () => refreshAfter(() => window.presenter.clearSession()),
      clearUsage: () => refreshAfter(() => window.presenter.clearUsage()),
      clearCompatibility: () => refreshAfter(() => window.presenter.clearCaptureResults()),
      clearDocuments: () => refreshAfter(() => window.presenter.clearAllDocuments()),
      deleteApiKey: () => refreshAfter(() => window.presenter.deleteApiKey()),
      deleteAllData: () => window.presenter.deleteAllLocalData('DELETE ALL')
    }} />
  </div>
}

function handleContentScrollKey(event: React.KeyboardEvent<HTMLElement>): void {
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

function CaptureStatus({ status, onChange }: { status: AppStatus; onChange(): Promise<void> }) {
  const [path, setPath] = useState('Google Meet — entire screen'); const [captureAppVersion, setCaptureAppVersion] = useState('')
  const [controlResult, setControlResult] = useState<'overlay-visible' | 'overlay-absent' | 'overlay-black' | 'unsupported' | 'untested'>('untested')
  const [protectedResult, setProtectedResult] = useState<typeof controlResult>('untested'); const [notes, setNotes] = useState('')
  const outcomes = ['untested', 'overlay-visible', 'overlay-absent', 'overlay-black', 'unsupported'] as const
  return <div className="stack capture-test"><h2>Capture protection</h2><div className="info-grid"><Info label="Requested" value={status.capture.requested ? 'Yes' : 'No'} /><Info label="Electron reported" value={status.capture.electronReported ? 'Enabled' : 'Not enabled'} /><Info label="Verified paths" value={String(status.capture.verifiedResults.filter((result) => result.controlResult !== 'untested' && result.protectedResult !== 'untested').length)} /></div>
    <Notice tone="warning">This requests exclusion from supported Windows capture paths. It is not a security guarantee and must be tested for each sharing or recording method.</Notice>
    <div className="test-pattern"><span>CAPTURE TEST</span></div>
    <div className="actions"><button className={!status.capture.electronReported ? 'primary' : ''} onClick={async () => { await window.presenter.setCaptureProtection(false); await onChange() }}>Protection OFF control</button><button className={status.capture.electronReported ? 'primary' : ''} onClick={async () => { await window.presenter.setCaptureProtection(true); await onChange() }}>Protection ON</button></div>
    <fieldset><legend>Record test result</legend><label>Capture path<select value={path} onChange={(e) => setPath(e.target.value)}>{['Google Meet — entire screen','Google Meet — Chrome window','Google Meet — Chrome tab','Windows Snipping Tool','OBS Display Capture','OBS Window Capture — Chrome','OBS Window Capture — PresenterAI'].map((value) => <option key={value}>{value}</option>)}</select></label><label>Capture app/version<input value={captureAppVersion} onChange={(e) => setCaptureAppVersion(e.target.value)} placeholder="Chrome 148 / OBS 32…" /></label><label>Protection OFF control<select value={controlResult} onChange={(e) => setControlResult(e.target.value as typeof controlResult)}>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Protection ON result<select value={protectedResult} onChange={(e) => setProtectedResult(e.target.value as typeof protectedResult)}>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label><button className="primary" disabled={!captureAppVersion.trim() || controlResult === 'untested' || protectedResult === 'untested'} onClick={async () => { await window.presenter.saveCaptureResult({ path, captureAppVersion, controlResult, protectedResult, notes }); await window.presenter.setCaptureProtection(true); setNotes(''); await onChange() }}>Save compatibility result</button></fieldset>
    {status.capture.verifiedResults.map((result) => <div className="document" key={result.id}><div><strong>{result.path}</strong><small>OFF: {result.controlResult} · ON: {result.protectedResult}</small><small>{result.captureAppVersion} · Windows {result.environment.windowsBuild}</small></div><button onClick={async () => { await window.presenter.removeCaptureResult(result.id); await onChange() }}>Remove</button></div>)}
    <h3>Required manual matrix</h3><ul><li>Google Meet: entire screen, Chrome window, Chrome tab</li><li>Windows Snipping Tool</li><li>OBS Display Capture and Window Capture</li></ul></div>
}

function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' | 'danger' }) { return <div className={`notice ${tone}`}>{children}</div> }
function Info({ label, value }: { label: string; value: string }) { return <div className="info"><small>{label}</small><strong>{value}</strong></div> }

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>)
