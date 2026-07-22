import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AiErrorInfo, AnswerFormat, ApiKeyStatus, AppSettings, AppStatus, AssistantResponse, DocumentInfo, UsageLedger
} from '../shared/contracts'
import { LISTENING_CONSENT_VERSION } from '../shared/contracts'
import './style.css'
import { AiErrorPanel } from './aiError'
import { DocumentsView } from './documents'
import { AnswerRenderAcknowledger, ToggleListenButton, OperationBanner, StageTimingSummary } from './operationUi'
import { ResponseCard } from './responseCard'
import { ApprovedVocabularyEditor } from './vocabularyEditor'
import { StatusRefreshGuard } from './statusRefresh'
import { ShortcutSettingsPanel } from './shortcutRecorder'
import {
  ListeningConsentPanel, PrivacyDisclosure, RetentionControls, TransmissionPreviewPanel, UsageEstimatePanel
} from './privacyControls'

type View = 'copilot' | 'documents' | 'settings' | 'privacy' | 'capture'

const blankStatus: AppStatus = {
  operation: 'idle', operationTimings: {}, listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
  helperState: 'missing', audioDevices: [], shortcutWarnings: [], capture: { requested: false, electronReported: false, verifiedResults: [] },
  privacyConsent: { requiredVersion: LISTENING_CONSENT_VERSION, satisfied: false }
}

const blankApiKeyStatus: ApiKeyStatus = { configured: false, masked: false, protection: 'unavailable' }

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('copilot')
  const [status, setStatus] = useState(blankStatus)
  const [settings, setSettings] = useState<AppSettings>()
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [usage, setUsage] = useState<UsageLedger>()
  const [question, setQuestion] = useState('')
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('auto')
  const [response, setResponse] = useState<AssistantResponse>()
  const [pendingAnswerOperationId, setPendingAnswerOperationId] = useState<string>()
  const [aiError, setAiError] = useState<AiErrorInfo>()
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>(blankApiKeyStatus)
  const [recordingMs, setRecordingMs] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const refreshGuard = useRef(new StatusRefreshGuard())
  const showAiError = useCallback((value: AiErrorInfo) => { setAiError(value); setView('copilot') }, [])
  const clearAcknowledgedAnswer = useCallback((operationId: string) => {
    setPendingAnswerOperationId((current) => current === operationId ? undefined : current)
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
      window.presenter.onResponse((value, operationId) => {
        setAiError(undefined); setResponse(value); setPendingAnswerOperationId(operationId); setView('copilot'); void refresh()
      }),
      window.presenter.onError(showAiError)
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [])
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

  const ask = async (): Promise<void> => {
    setAiError(undefined); setResponse(undefined)
    const requestedFormat = answerFormat
    setAnswerFormat('auto')
    try {
      const result = await window.presenter.ask(question, requestedFormat)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
  }

  return <main className={`shell ${status.listening ? 'is-listening' : ''}`}>
    {status.outboundPreview && <TransmissionPreviewPanel
      preview={status.outboundPreview}
      onRendered={(operationId, stage) => window.presenter.acknowledgeTransmissionPreview(operationId, stage)}
      onCancel={() => window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) })}
      onError={(message) => showAiError({ code: 'privacy_preview_unavailable', message, retryable: true })}
    />}
    {response && pendingAnswerOperationId && <AnswerRenderAcknowledger
      operationId={pendingAnswerOperationId}
      onAcknowledged={clearAcknowledgedAnswer}
      onError={showAiError}
    />}
    <header className="titlebar drag-region">
      <div className="brand"><span className="brand-mark">P</span><div><strong>PresenterAI</strong><small>local-first copilot</small></div></div>
      <div className="status-row no-drag">
        <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />
        <button className="icon-button" onClick={() => setView('capture')} title="Capture protection status">{status.capture.electronReported ? 'Electron: on*' : 'Unverified'}</button>
        <button className="icon-button" onClick={() => setView('settings')} title="Settings">⚙</button>
      </div>
    </header>

    <OperationBanner status={status} elapsedMs={recordingMs} onError={showAiError} onCancel={() => { void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }) }} />

    <nav className="tabs no-drag">
      {(['copilot', 'documents', 'settings', 'privacy'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
    </nav>

    <section className="content no-drag">
      {status.settingsRecoveryWarning && <Notice tone="warning"><strong>Settings were recovered safely.</strong> The prior file was {status.settingsRecoveryWarning.code.replaceAll('_', ' ')}. <button onClick={async () => { await window.presenter.dismissSettingsRecoveryWarning(); await refresh() }}>Dismiss</button></Notice>}
      {view === 'copilot' && <Copilot question={question} setQuestion={setQuestion} answerFormat={answerFormat} setAnswerFormat={setAnswerFormat} input={input} ask={ask} response={response} aiError={aiError ?? status.operationError} openSettings={() => setView('settings')} openPrivacy={() => setView('privacy')} hasKey={apiKeyStatus.configured} status={status} onAudioError={showAiError} />}
      {view === 'documents' && <DocumentsView documents={documents} onChange={refresh} />}
      {view === 'settings' && settings && <Settings settings={settings} status={status} recordingMs={recordingMs} apiKeyStatus={apiKeyStatus} onChange={refresh} />}
      {view === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} settings={settings} onChange={refresh} />}
      {view === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
    </section>
    <footer><span>Audio defaults OFF</span><span>Ctrl+Shift+I restores interaction</span></footer>
  </main>
}

function Copilot(props: { question: string; setQuestion(v: string): void; answerFormat: AnswerFormat; setAnswerFormat(v: AnswerFormat): void; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; openPrivacy(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void }) {
  const busy = props.status.operation !== 'idle' && props.status.operation !== 'error'
  const retryIsSafe = props.status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout'].includes(props.aiError?.code ?? '')
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void props.ask() }} />
      <div className="composer-toolbar">
        <div className="answer-format" role="group" aria-label="Answer format">
          <button type="button" className={props.answerFormat === 'auto' ? 'active' : ''} aria-pressed={props.answerFormat === 'auto'} onClick={() => props.setAnswerFormat('auto')}>Auto</button>
          <button type="button" className={props.answerFormat === 'code' ? 'active' : ''} aria-pressed={props.answerFormat === 'code'} onClick={() => props.setAnswerFormat('code')}>&lt;/&gt; Code</button>
        </div>
        <div className="actions"><button className="primary" disabled={!props.hasKey || !props.question.trim() || busy} title={busy ? 'Another operation is active.' : undefined} onClick={() => void props.ask()}>Ask AI <kbd>Ctrl↵</kbd></button>
          <ToggleListenButton status={props.status} onError={props.onAudioError} /></div>
      </div>
    </div>
    {props.aiError && <AiErrorPanel error={props.aiError} allowRetry={retryIsSafe} onRetry={props.ask} onOpenSettings={props.openSettings} onOpenPrivacy={props.openPrivacy} />}
    {props.response ? <ResponseCard response={props.response} onCopyCode={(code) => window.presenter.copyCode(code)} /> : <div className="empty"><div className="wave">∿</div><h2>Ready when you are</h2><p>Type a question, or press Ctrl + Shift + Space once to start system-audio listening and again to stop.</p></div>}
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
    <fieldset><legend>System audio output</legend><p className="muted">PresenterAI captures all sound played through the selected Windows output device. It does not listen to the microphone.</p><div className="helper-health"><span className={`health-dot ${status.helperState}`} /><strong>{status.helperState}</strong></div>{status.operation === 'listening' && <p>Recording: {(recordingMs / 1000).toFixed(1)} seconds</p>}<Info label="Active capture endpoint" value={status.activeAudioEndpoint?.name ?? 'None — listening is off'} />{status.helperError && <Notice tone={status.helperState === 'failed' ? 'danger' : 'warning'}>{status.helperError}</Notice>}{status.helperState === 'missing' && <p className="muted">Reinstall PresenterAI or run the packaged build so the Windows helper is available.</p>}{status.helperState === 'failed' && <p className="muted">Refresh devices after correcting the setup. A second helper crash requires restarting PresenterAI.</p>}<label>Preferred output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label><button onClick={async () => { setFailure(''); try { await window.presenter.refreshAudioDevices(); await onChange() } catch (e) { setFailure((e as Error).message || 'Audio devices could not be refreshed.') } }}>Refresh devices</button>{status.shortcutWarnings.map((warning) => <Notice tone="warning" key={warning}>{warning}</Notice>)}</fieldset>
    <ApprovedVocabularyEditor terms={settings.approvedVocabulary} onChange={(approvedVocabulary) => update({ approvedVocabulary })} />
    <fieldset><legend>Overlay</legend><label>Glass opacity <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(e) => void update({ opacity: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={settings.clickThrough} onChange={(e) => void update({ clickThrough: e.target.checked })} /> Click-through mode</label></fieldset>
    <fieldset><legend>Project summary</legend><textarea value={settings.projectSummary} onChange={(e) => void update({ projectSummary: e.target.value })} placeholder="Optional user-authored facts that may be sent with each request." /></fieldset>
    <ShortcutSettingsPanel askShortcut={settings.askShortcut} hideShortcut={settings.hideShortcut} listenShortcut={settings.listenShortcut} disabled={busy} onChange={update} />
    <fieldset><legend>Approximate INR display</legend><label>INR per USD<input type="number" min="1" max="1000" step="0.01" value={settings.inrPerUsd ?? ''} placeholder="Optional" onChange={(event) => void update({ inrPerUsd: event.target.value ? Number(event.target.value) : undefined })} /></label><p className="muted">Set this manually. PresenterAI never looks up exchange rates, and the result is not billing reconciliation.</p></fieldset>
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} />
  </div>
}

function Privacy({ status, recordingMs, documents, usage, settings, onChange }: { status: AppStatus; recordingMs: number; documents: DocumentInfo[]; usage?: UsageLedger; settings?: AppSettings; onChange(): Promise<void> }) {
  const busy = status.operation !== 'idle' && status.operation !== 'error'
  const refreshAfter = async (action: () => Promise<unknown>): Promise<void> => { await action(); await onChange() }
  const usageView = usage ? {
    estimatedUsd: usage.summary.estimatedUsd,
    pricingVersion: usage.summary.pricingVersion,
    requestCount: usage.recent.length + usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0),
    unpricedRequestCount: usage.recent.filter((record) => !record.priced).length + usage.rollups.reduce((total, rollup) => total + rollup.unpricedRequestCount, 0),
    ...(settings?.inrPerUsd === undefined ? {} : { inrPerUsd: settings.inrPerUsd }),
    rolledUpRequestCount: usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0)
  } : undefined
  return <div className="stack"><h2>Privacy & usage</h2><Notice tone="warning">Live AI assistance may be prohibited in interviews, examinations, or graded assessments. Check the applicable rules and obtain consent where required.</Notice>
    <ListeningConsentPanel consent={status.privacyConsent} disabled={busy} onAccept={async (version) => { await window.presenter.acceptListeningConsent(version); await onChange() }} />
    <div className="info-grid"><Info label="Listening" value={status.operation === 'listening' ? `ACTIVE · ${(recordingMs / 1000).toFixed(1)}s` : 'OFF'} /><Info label="Active audio endpoint" value={status.activeAudioEndpoint?.name ?? 'None'} /><Info label="Preferred audio source" value={status.audioSource} /><Info label="Audio helper" value={status.helperState} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Exists during capture/transcription only' : 'None'} /><Info label="Last capture" value={status.lastCapture ? `${(status.lastCapture.durationMs / 1000).toFixed(1)}s · ${status.lastCapture.sampleRate} Hz mono · ${status.lastCapture.endpointName}` : 'None this session'} /><Info label="Last answer render" value={status.answerRenderConfirmed === undefined ? 'Not measured' : status.answerRenderConfirmed ? 'Confirmed visible' : 'Not confirmed'} /><Info label="Approved vocabulary" value={`${settings?.approvedVocabulary.length ?? 0} terms`} /><Info label="Local documents" value={`${documents.length} indexed`} /></div>
    <PrivacyDisclosure />
    {usageView && <UsageEstimatePanel usage={usageView} />}
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} />
    <RetentionControls busy={busy} actions={{
      clearSession: () => refreshAfter(() => window.presenter.clearSession()),
      clearUsage: () => refreshAfter(() => window.presenter.clearUsage()),
      clearCompatibility: () => refreshAfter(() => window.presenter.clearCaptureResults()),
      clearDocuments: () => refreshAfter(() => window.presenter.clearAllDocuments()),
      deleteApiKey: () => refreshAfter(() => window.presenter.deleteApiKey()),
      deleteAllData: () => window.presenter.deleteAllLocalData('DELETE ALL')
    }} />
  </div>
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

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
