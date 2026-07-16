import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiErrorInfo, AppSettings, AppStatus, AssistantResponse, DocumentInfo, UsageSummary } from '../shared/contracts'
import './style.css'
import { AiErrorPanel } from './aiError'
import { DocumentsView } from './documents'
import { AnswerRenderAcknowledger, HoldToListenButton, OperationBanner, StageTimingSummary } from './operationUi'
import { ResponseCard } from './responseCard'
import { ApprovedVocabularyEditor } from './vocabularyEditor'
import { StatusRefreshGuard } from './statusRefresh'

type View = 'copilot' | 'documents' | 'settings' | 'privacy' | 'capture'

const blankStatus: AppStatus = {
  operation: 'idle', operationTimings: {}, listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
  helperState: 'missing', audioDevices: [], shortcutWarnings: [], capture: { requested: false, electronReported: false, verifiedResults: [] }
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>('copilot')
  const [status, setStatus] = useState(blankStatus)
  const [settings, setSettings] = useState<AppSettings>()
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [usage, setUsage] = useState<UsageSummary>()
  const [question, setQuestion] = useState('')
  const [response, setResponse] = useState<AssistantResponse>()
  const [pendingAnswerOperationId, setPendingAnswerOperationId] = useState<string>()
  const [aiError, setAiError] = useState<AiErrorInfo>()
  const [hasKey, setHasKey] = useState(false)
  const [recordingMs, setRecordingMs] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const refreshGuard = useRef(new StatusRefreshGuard())
  const showAiError = useCallback((value: AiErrorInfo) => { setAiError(value); setView('copilot') }, [])
  const clearAcknowledgedAnswer = useCallback((operationId: string) => {
    setPendingAnswerOperationId((current) => current === operationId ? undefined : current)
  }, [])

  const refresh = async (): Promise<void> => {
    const ticket = refreshGuard.current.begin()
    const [nextStatus, nextSettings, docs, key, nextUsage] = await Promise.all([
      window.presenter.getStatus(), window.presenter.getSettings(), window.presenter.listDocuments(), window.presenter.hasApiKey(), window.presenter.getUsage()
    ])
    if (!refreshGuard.current.acceptsResources(ticket)) return
    if (refreshGuard.current.acceptsStatus(ticket)) setStatus(nextStatus)
    setSettings(nextSettings); setDocuments(docs); setHasKey(key); setUsage(nextUsage)
  }
  useEffect(() => {
    void refresh()
    const cleanups = [
      window.presenter.onStatus((value) => { refreshGuard.current.observeStatus(); setStatus(value) }),
      window.presenter.onFocusAsk(() => { setView('copilot'); setTimeout(() => input.current?.focus(), 0) }),
      window.presenter.onOpenSettings(() => setView('settings')),
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

  const ask = async (): Promise<void> => {
    setAiError(undefined); setResponse(undefined)
    try {
      const result = await window.presenter.ask(question)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
  }

  return <main className={`shell ${status.listening ? 'is-listening' : ''}`}>
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
      {view === 'copilot' && <Copilot question={question} setQuestion={setQuestion} input={input} ask={ask} response={response} aiError={aiError ?? status.operationError} openSettings={() => setView('settings')} hasKey={hasKey} status={status} onAudioError={showAiError} />}
      {view === 'documents' && <DocumentsView documents={documents} onChange={refresh} />}
      {view === 'settings' && settings && <Settings settings={settings} status={status} recordingMs={recordingMs} hasKey={hasKey} onChange={refresh} />}
      {view === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} settings={settings} />}
      {view === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
    </section>
    <footer><span>Audio defaults OFF</span><span>Ctrl+Shift+I restores interaction</span></footer>
  </main>
}

function Copilot(props: { question: string; setQuestion(v: string): void; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void }) {
  const busy = props.status.operation !== 'idle' && props.status.operation !== 'error'
  const retryIsSafe = props.status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout'].includes(props.aiError?.code ?? '')
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void props.ask() }} />
      <div className="actions"><button className="primary" disabled={!props.hasKey || !props.question.trim() || busy} title={busy ? 'Another operation is active.' : undefined} onClick={() => void props.ask()}>Ask AI <kbd>Ctrl↵</kbd></button>
        <HoldToListenButton status={props.status} onError={props.onAudioError} /></div>
    </div>
    {props.aiError && <AiErrorPanel error={props.aiError} allowRetry={retryIsSafe} onRetry={props.ask} onOpenSettings={props.openSettings} />}
    {props.response ? <ResponseCard response={props.response} /> : <div className="empty"><div className="wave">∿</div><h2>Ready when you are</h2><p>Type a question or hold Ctrl + Shift + Space while a reviewer speaks.</p></div>}
  </div>
}

function Settings({ settings, status, recordingMs, hasKey, onChange }: { settings: AppSettings; status: AppStatus; recordingMs: number; hasKey: boolean; onChange(): Promise<void> }) {
  const [key, setKey] = useState(''); const [message, setMessage] = useState(''); const [failure, setFailure] = useState('')
  const update = async (patch: Partial<AppSettings>) => {
    setFailure('')
    try { await window.presenter.updateSettings(patch); await onChange() }
    catch (error) { setFailure((error as Error).message || 'The setting could not be saved.') }
  }
  return <div className="stack"><h2>Settings</h2>
    {failure && <Notice tone="danger">{failure}</Notice>}
    <fieldset><legend>OpenAI API key</legend><p>{hasKey ? 'A DPAPI-encrypted key is stored for this Windows user.' : 'No API key is stored.'}</p><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" /><div className="actions"><button className="primary" onClick={async () => { try { await window.presenter.saveApiKey(key); setKey(''); setMessage('Key saved.'); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be saved.') } }}>Save key</button><button disabled={!hasKey} onClick={async () => { try { setMessage((await window.presenter.testApiKey()).message) } catch (e) { setFailure((e as Error).message || 'The API key could not be tested.') } }}>Test</button><button disabled={!hasKey} onClick={async () => { try { await window.presenter.deleteApiKey(); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be deleted.') } }}>Delete</button></div>{message && <small>{message}</small>}</fieldset>
    <fieldset><legend>Answer model</legend><select value={settings.modelMode} onChange={(e) => void update({ modelMode: e.target.value as AppSettings['modelMode'] })}><option value="normal">Normal · {settings.normalModel}</option><option value="strong">Strong · {settings.strongModel}</option></select></fieldset>
    <fieldset><legend>System audio</legend><div className="helper-health"><span className={`health-dot ${status.helperState}`} /><strong>{status.helperState}</strong></div>{status.operation === 'listening' && <p>Recording: {(recordingMs / 1000).toFixed(1)} seconds</p>}<Info label="Active capture endpoint" value={status.activeAudioEndpoint?.name ?? 'None — listening is off'} />{status.helperError && <Notice tone={status.helperState === 'failed' ? 'danger' : 'warning'}>{status.helperError}</Notice>}{status.helperState === 'missing' && <p className="muted">Reinstall PresenterAI or run the packaged build so the Windows helper is available.</p>}{status.helperState === 'failed' && <p className="muted">Refresh devices after correcting the setup. A second helper crash requires restarting PresenterAI.</p>}<label>Preferred output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label><button onClick={async () => { setFailure(''); try { await window.presenter.refreshAudioDevices(); await onChange() } catch (e) { setFailure((e as Error).message || 'Audio devices could not be refreshed.') } }}>Refresh devices</button>{status.shortcutWarnings.map((warning) => <Notice tone="warning" key={warning}>{warning}</Notice>)}</fieldset>
    <ApprovedVocabularyEditor terms={settings.approvedVocabulary} onChange={(approvedVocabulary) => update({ approvedVocabulary })} />
    <fieldset><legend>Overlay</legend><label>Opacity <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(e) => void update({ opacity: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={settings.clickThrough} onChange={(e) => void update({ clickThrough: e.target.checked })} /> Click-through mode</label></fieldset>
    <fieldset><legend>Project summary</legend><textarea value={settings.projectSummary} onChange={(e) => void update({ projectSummary: e.target.value })} placeholder="Optional user-authored facts that may be sent with each request." /></fieldset>
    <fieldset><legend>Shortcuts</legend>
      <ShortcutInput label="Ask" value={settings.askShortcut} onCommit={(askShortcut) => update({ askShortcut })} />
      <ShortcutInput label="Hide/show" value={settings.hideShortcut} onCommit={(hideShortcut) => update({ hideShortcut })} />
      <ShortcutInput label="Hold-to-listen" value={settings.listenShortcut} onCommit={(listenShortcut) => update({ listenShortcut })} />
      <p className="muted">Use at least one modifier plus Space, A–Z, 0–9, or F1–F24. Emergency interaction restore: Ctrl+Shift+I.</p>
    </fieldset>
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} />
  </div>
}

function Privacy({ status, recordingMs, documents, usage, settings }: { status: AppStatus; recordingMs: number; documents: DocumentInfo[]; usage?: UsageSummary; settings?: AppSettings }) {
  return <div className="stack"><h2>Privacy & usage</h2><Notice tone="warning">Live AI assistance may be prohibited in interviews, examinations, or graded assessments. Check the applicable rules and obtain consent where required.</Notice>
    <div className="info-grid"><Info label="Listening" value={status.operation === 'listening' ? `ACTIVE · ${(recordingMs / 1000).toFixed(1)}s` : 'OFF'} /><Info label="Active audio endpoint" value={status.activeAudioEndpoint?.name ?? 'None'} /><Info label="Preferred audio source" value={status.audioSource} /><Info label="Audio helper" value={status.helperState} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Exists during capture/transcription only' : 'None'} /><Info label="Last capture" value={status.lastCapture ? `${(status.lastCapture.durationMs / 1000).toFixed(1)}s · ${status.lastCapture.sampleRate} Hz mono · ${status.lastCapture.endpointName}` : 'None this session'} /><Info label="Last answer render" value={status.answerRenderConfirmed === undefined ? 'Not measured' : status.answerRenderConfirmed ? 'Confirmed visible' : 'Not confirmed'} /><Info label="Approved vocabulary" value={`${settings?.approvedVocabulary.length ?? 0} terms`} /><Info label="Local documents" value={`${documents.length} indexed`} /></div>
    <h3>Sent to OpenAI only when requested</h3><ul><li>The typed question or bounded reviewer-audio segment</li><li>Approved vocabulary and bounded document-title hints during transcription</li><li>Up to five locally retrieved document chunks</li><li>Up to five recent question/response summaries</li><li>Your optional project summary</li></ul>
    <p>Bounded audio is deleted when transcription reaches a terminal state, before retrieval or response generation. OpenAI's published endpoint table currently lists no application-state or abuse-monitoring retention for transcription. Responses use <code>store:false</code>, but ordinary API abuse-monitoring retention may still apply. PresenterAI implements no analytics or telemetry.</p>
    {usage && <div className="usage"><strong>Local session estimate</strong><span>${usage.estimatedUsd.toFixed(4)} USD</span><small>{usage.inputTokens + usage.outputTokens} response tokens · {usage.transcriptionInputTokens + usage.transcriptionOutputTokens} transcription tokens ({usage.transcriptionAudioTokens} audio input) · {usage.audioMinutes.toFixed(2)} audio minutes</small><small>Pricing metadata: {usage.pricingVersion}</small></div>}
    <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} />
    <button onClick={() => window.presenter.clearSession()}>Clear rolling conversation context</button></div>
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

function ShortcutInput({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): Promise<void> | void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className="shortcut-setting"><label>{label}<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label><button disabled={draft === value} onClick={() => void onCommit(draft)}>Apply</button></div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
