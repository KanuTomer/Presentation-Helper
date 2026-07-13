import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiErrorInfo, AppSettings, AppStatus, AssistantResponse, DocumentInfo, UsageSummary } from '../shared/contracts'
import './style.css'
import { AiErrorPanel } from './aiError'
import { DocumentsView } from './documents'
import { ResponseCard } from './responseCard'

type View = 'copilot' | 'documents' | 'settings' | 'privacy' | 'capture'

const blankStatus: AppStatus = {
  operation: 'idle', listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
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
  const [error, setError] = useState('')
  const [aiError, setAiError] = useState<AiErrorInfo>()
  const [hasKey, setHasKey] = useState(false)
  const [recordingMs, setRecordingMs] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)

  const refresh = async (): Promise<void> => {
    const [nextStatus, nextSettings, docs, key, nextUsage] = await Promise.all([
      window.presenter.getStatus(), window.presenter.getSettings(), window.presenter.listDocuments(), window.presenter.hasApiKey(), window.presenter.getUsage()
    ])
    setStatus(nextStatus); setSettings(nextSettings); setDocuments(docs); setHasKey(key); setUsage(nextUsage)
  }
  useEffect(() => {
    void refresh()
    const cleanups = [
      window.presenter.onStatus(setStatus),
      window.presenter.onFocusAsk(() => { setView('copilot'); setTimeout(() => input.current?.focus(), 0) }),
      window.presenter.onOpenSettings(() => setView('settings')),
      window.presenter.onResponse((value) => { setResponse(value); setView('copilot'); void refresh() }),
      window.presenter.onError(setError)
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [])
  useEffect(() => {
    if (!status.listening) { setRecordingMs(0); return }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setRecordingMs(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [status.listening])

  const ask = async (): Promise<void> => {
    setError(''); setAiError(undefined); setResponse(undefined)
    try {
      const result = await window.presenter.ask(question)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
  }

  return <main className={`shell ${status.listening ? 'is-listening' : ''}`}>
    <header className="titlebar drag-region">
      <div className="brand"><span className="brand-mark">P</span><div><strong>PresenterAI</strong><small>local-first copilot</small></div></div>
      <div className="status-row no-drag">
        <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />
        <button className="icon-button" onClick={() => setView('capture')} title="Capture protection status">{status.capture.electronReported ? 'Protected*' : 'Unverified'}</button>
        <button className="icon-button" onClick={() => setView('settings')} title="Settings">⚙</button>
      </div>
    </header>

    {status.listening && <div className="listening-banner"><span className="pulse" /> LISTENING TO SYSTEM OUTPUT · {(recordingMs / 1000).toFixed(1)}s <button onClick={() => window.presenter.cancel()}>Cancel</button></div>}
    {status.operation !== 'idle' && !status.listening && <div className="progress-banner">{status.operation.toUpperCase()}… <button onClick={() => window.presenter.cancel()}>Esc / Cancel</button></div>}

    <nav className="tabs no-drag">
      {(['copilot', 'documents', 'settings', 'privacy'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
    </nav>

    <section className="content no-drag">
      {view === 'copilot' && <Copilot question={question} setQuestion={setQuestion} input={input} ask={ask} response={response} error={error} aiError={aiError} openSettings={() => setView('settings')} hasKey={hasKey} helperAvailable={status.helperAvailable} listening={status.listening} />}
      {view === 'documents' && <DocumentsView documents={documents} onChange={refresh} />}
      {view === 'settings' && settings && <Settings settings={settings} status={status} recordingMs={recordingMs} hasKey={hasKey} onChange={refresh} setError={setError} />}
      {view === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} />}
      {view === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
    </section>
    <footer><span>Audio defaults OFF</span><span>Ctrl+Shift+I restores interaction</span></footer>
  </main>
}

function Copilot(props: { question: string; setQuestion(v: string): void; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; response?: AssistantResponse; error: string; aiError?: AiErrorInfo; openSettings(): void; hasKey: boolean; helperAvailable: boolean; listening: boolean }) {
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void props.ask() }} />
      <div className="actions"><button className="primary" disabled={!props.hasKey || !props.question.trim()} onClick={() => void props.ask()}>Ask AI <kbd>Ctrl↵</kbd></button>
        <button disabled={!props.helperAvailable} onMouseDown={() => window.presenter.startListening()} onMouseUp={() => window.presenter.stopListening()} title={props.helperAvailable ? 'Hold while the reviewer speaks' : 'Build the Windows helper first'}>◉ Hold to listen</button></div>
    </div>
    {props.error && <Notice tone="danger">{props.error}</Notice>}
    {props.aiError && <AiErrorPanel error={props.aiError} onRetry={props.ask} onOpenSettings={props.openSettings} />}
    {props.response ? <ResponseCard response={props.response} /> : <div className="empty"><div className="wave">∿</div><h2>Ready when you are</h2><p>Type a question or hold Ctrl + Shift + Space while a reviewer speaks.</p></div>}
  </div>
}

function Settings({ settings, status, recordingMs, hasKey, onChange, setError }: { settings: AppSettings; status: AppStatus; recordingMs: number; hasKey: boolean; onChange(): Promise<void>; setError(v: string): void }) {
  const [key, setKey] = useState(''); const [message, setMessage] = useState('')
  const update = async (patch: Partial<AppSettings>) => { await window.presenter.updateSettings(patch); await onChange() }
  return <div className="stack"><h2>Settings</h2>
    <fieldset><legend>OpenAI API key</legend><p>{hasKey ? 'A DPAPI-encrypted key is stored for this Windows user.' : 'No API key is stored.'}</p><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" /><div className="actions"><button className="primary" onClick={async () => { try { await window.presenter.saveApiKey(key); setKey(''); setMessage('Key saved.'); await onChange() } catch (e) { setError((e as Error).message) } }}>Save key</button><button disabled={!hasKey} onClick={async () => setMessage((await window.presenter.testApiKey()).message)}>Test</button><button disabled={!hasKey} onClick={async () => { await window.presenter.deleteApiKey(); await onChange() }}>Delete</button></div>{message && <small>{message}</small>}</fieldset>
    <fieldset><legend>Answer model</legend><select value={settings.modelMode} onChange={(e) => void update({ modelMode: e.target.value as AppSettings['modelMode'] })}><option value="normal">Normal · {settings.normalModel}</option><option value="strong">Strong · {settings.strongModel}</option></select></fieldset>
    <fieldset><legend>System audio</legend><div className="helper-health"><span className={`health-dot ${status.helperState}`} /><strong>{status.helperState}</strong></div>{status.listening && <p>Recording: {(recordingMs / 1000).toFixed(1)} seconds</p>}{status.helperError && <p className="muted">{status.helperError}</p>}<label>Output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label><button onClick={async () => { await window.presenter.refreshAudioDevices(); await onChange() }}>Refresh devices</button></fieldset>
    <fieldset><legend>Overlay</legend><label>Opacity <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(e) => void update({ opacity: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={settings.clickThrough} onChange={(e) => void update({ clickThrough: e.target.checked })} /> Click-through mode</label></fieldset>
    <fieldset><legend>Project summary</legend><textarea value={settings.projectSummary} onChange={(e) => void update({ projectSummary: e.target.value })} placeholder="Optional user-authored facts that may be sent with each request." /></fieldset>
    <fieldset><legend>Shortcuts</legend><label>Ask <input value={settings.askShortcut} onChange={(e) => void update({ askShortcut: e.target.value })} /></label><label>Hide/show <input value={settings.hideShortcut} onChange={(e) => void update({ hideShortcut: e.target.value })} /></label><label>Hold-to-listen <input value={settings.listenShortcut} onChange={(e) => void update({ listenShortcut: e.target.value })} /></label><p className="muted">Emergency interaction restore: Ctrl+Shift+I.</p></fieldset>
  </div>
}

function Privacy({ status, recordingMs, documents, usage }: { status: AppStatus; recordingMs: number; documents: DocumentInfo[]; usage?: UsageSummary }) {
  return <div className="stack"><h2>Privacy & usage</h2><Notice tone="warning">Live AI assistance may be prohibited in interviews, examinations, or graded assessments. Check the applicable rules and obtain consent where required.</Notice>
    <div className="info-grid"><Info label="Listening" value={status.listening ? `ACTIVE · ${(recordingMs / 1000).toFixed(1)}s` : 'OFF'} /><Info label="Audio source" value={status.audioSource} /><Info label="Audio helper" value={status.helperState} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Exists during current operation' : 'None'} /><Info label="Last capture" value={status.lastCapture ? `${(status.lastCapture.durationMs / 1000).toFixed(1)}s · ${status.lastCapture.sampleRate} Hz mono` : 'None this session'} /><Info label="Local documents" value={`${documents.length} indexed`} /></div>
    <h3>Sent to OpenAI only when requested</h3><ul><li>The typed question or bounded reviewer-audio segment</li><li>Up to five locally retrieved document chunks</li><li>Up to five recent question/response summaries</li><li>Your optional project summary</li></ul>
    <p>No analytics or telemetry are implemented. Responses use <code>store:false</code>, but OpenAI API retention policies may still apply.</p>
    {usage && <div className="usage"><strong>Local session estimate</strong><span>${usage.estimatedUsd.toFixed(4)} USD</span><small>{usage.inputTokens + usage.outputTokens} text tokens · {usage.audioMinutes.toFixed(2)} audio minutes</small></div>}
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

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
