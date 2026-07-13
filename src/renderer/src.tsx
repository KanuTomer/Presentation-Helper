import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppSettings, AppStatus, AssistantResponse, DocumentInfo, UsageSummary } from '../shared/contracts'
import './style.css'

type View = 'copilot' | 'documents' | 'settings' | 'privacy' | 'capture'

const blankStatus: AppStatus = {
  operation: 'idle', listening: false, audioSource: 'System output (WASAPI loopback)', temporaryAudioExists: false, helperAvailable: false,
  shortcutWarnings: [], capture: { requested: false, electronReported: false, verifiedResults: [] }
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
  const [hasKey, setHasKey] = useState(false)
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

  const ask = async (): Promise<void> => {
    setError(''); setResponse(undefined)
    try { setResponse(await window.presenter.ask(question)); void refresh() } catch (value) { setError((value as Error).message) }
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

    {status.listening && <div className="listening-banner"><span className="pulse" /> LISTENING TO SYSTEM OUTPUT <button onClick={() => window.presenter.cancel()}>Cancel</button></div>}
    {status.operation !== 'idle' && !status.listening && <div className="progress-banner">{status.operation.toUpperCase()}… <button onClick={() => window.presenter.cancel()}>Esc / Cancel</button></div>}

    <nav className="tabs no-drag">
      {(['copilot', 'documents', 'settings', 'privacy'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
    </nav>

    <section className="content no-drag">
      {view === 'copilot' && <Copilot question={question} setQuestion={setQuestion} input={input} ask={ask} response={response} error={error} hasKey={hasKey} helperAvailable={status.helperAvailable} listening={status.listening} />}
      {view === 'documents' && <Documents documents={documents} onChange={refresh} />}
      {view === 'settings' && settings && <Settings settings={settings} hasKey={hasKey} onChange={refresh} setError={setError} />}
      {view === 'privacy' && <Privacy status={status} documents={documents} usage={usage} />}
      {view === 'capture' && <CaptureStatus status={status} />}
    </section>
    <footer><span>Audio defaults OFF</span><span>Ctrl+Shift+I restores interaction</span></footer>
  </main>
}

function Copilot(props: { question: string; setQuestion(v: string): void; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; response?: AssistantResponse; error: string; hasKey: boolean; helperAvailable: boolean; listening: boolean }) {
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void props.ask() }} />
      <div className="actions"><button className="primary" disabled={!props.hasKey || !props.question.trim()} onClick={() => void props.ask()}>Ask AI <kbd>Ctrl↵</kbd></button>
        <button disabled={!props.helperAvailable} onMouseDown={() => window.presenter.startListening()} onMouseUp={() => window.presenter.stopListening()} title={props.helperAvailable ? 'Hold while the reviewer speaks' : 'Build the Windows helper first'}>◉ Hold to listen</button></div>
    </div>
    {props.error && <Notice tone="danger">{props.error}</Notice>}
    {props.response ? <ResponseCard response={props.response} /> : <div className="empty"><div className="wave">∿</div><h2>Ready when you are</h2><p>Type a question or hold Ctrl + Shift + Space while a reviewer speaks.</p></div>}
  </div>
}

function ResponseCard({ response }: { response: AssistantResponse }) {
  return <article className="response-card">
    <span className="category">{response.category}</span>
    <h3>SAY</h3><p className="say">{response.say}</p>
    <h3>KEY POINTS</h3><ul>{response.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul>
    <h3>IF CHALLENGED</h3><p>{response.ifChallenged}</p>
    {response.warning && <div className="warning-box"><strong>WARNING</strong><p>{response.warning}</p></div>}
    {response.evidence.length > 0 && <details><summary>{response.evidence.length} evidence source(s)</summary>{response.evidence.map((item) => <p key={item.chunkId}>{item.documentName} · {item.location}</p>)}</details>}
  </article>
}

function Documents({ documents, onChange }: { documents: DocumentInfo[]; onChange(): Promise<void> }) {
  const add = async () => { await window.presenter.selectDocuments(); await onChange() }
  return <div className="stack"><div className="section-heading"><div><h2>Local documents</h2><p>Only retrieved excerpts are sent to OpenAI.</p></div><button className="primary" onClick={() => void add()}>Add files</button></div>
    {documents.length === 0 ? <Notice>No documents indexed. Add PPTX, PDF, Markdown, or text files.</Notice> : documents.map((doc) => <div className="document" key={doc.id}><div><strong>{doc.name}</strong><small>{doc.kind.toUpperCase()} · {doc.chunkCount} chunks</small></div><button onClick={async () => { await window.presenter.removeDocument(doc.id); await onChange() }}>Remove</button></div>)}</div>
}

function Settings({ settings, hasKey, onChange, setError }: { settings: AppSettings; hasKey: boolean; onChange(): Promise<void>; setError(v: string): void }) {
  const [key, setKey] = useState(''); const [message, setMessage] = useState('')
  const update = async (patch: Partial<AppSettings>) => { await window.presenter.updateSettings(patch); await onChange() }
  return <div className="stack"><h2>Settings</h2>
    <fieldset><legend>OpenAI API key</legend><p>{hasKey ? 'A DPAPI-encrypted key is stored for this Windows user.' : 'No API key is stored.'}</p><input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" /><div className="actions"><button className="primary" onClick={async () => { try { await window.presenter.saveApiKey(key); setKey(''); setMessage('Key saved.'); await onChange() } catch (e) { setError((e as Error).message) } }}>Save key</button><button disabled={!hasKey} onClick={async () => setMessage((await window.presenter.testApiKey()).message)}>Test</button><button disabled={!hasKey} onClick={async () => { await window.presenter.deleteApiKey(); await onChange() }}>Delete</button></div>{message && <small>{message}</small>}</fieldset>
    <fieldset><legend>Answer model</legend><select value={settings.modelMode} onChange={(e) => void update({ modelMode: e.target.value as AppSettings['modelMode'] })}><option value="normal">Normal · {settings.normalModel}</option><option value="strong">Strong · {settings.strongModel}</option></select></fieldset>
    <fieldset><legend>Overlay</legend><label>Opacity <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(e) => void update({ opacity: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={settings.clickThrough} onChange={(e) => void update({ clickThrough: e.target.checked })} /> Click-through mode</label></fieldset>
    <fieldset><legend>Project summary</legend><textarea value={settings.projectSummary} onChange={(e) => void update({ projectSummary: e.target.value })} placeholder="Optional user-authored facts that may be sent with each request." /></fieldset>
    <fieldset><legend>Shortcuts</legend><label>Ask <input value={settings.askShortcut} onChange={(e) => void update({ askShortcut: e.target.value })} /></label><label>Hide/show <input value={settings.hideShortcut} onChange={(e) => void update({ hideShortcut: e.target.value })} /></label><label>Hold-to-listen <input value={settings.listenShortcut} onChange={(e) => void update({ listenShortcut: e.target.value })} /></label><p className="muted">Emergency interaction restore: Ctrl+Shift+I.</p></fieldset>
  </div>
}

function Privacy({ status, documents, usage }: { status: AppStatus; documents: DocumentInfo[]; usage?: UsageSummary }) {
  return <div className="stack"><h2>Privacy & usage</h2><Notice tone="warning">Live AI assistance may be prohibited in interviews, examinations, or graded assessments. Check the applicable rules and obtain consent where required.</Notice>
    <div className="info-grid"><Info label="Listening" value={status.listening ? 'ACTIVE' : 'OFF'} /><Info label="Audio source" value={status.audioSource} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Exists during current operation' : 'None'} /><Info label="Local documents" value={`${documents.length} indexed`} /></div>
    <h3>Sent to OpenAI only when requested</h3><ul><li>The typed question or bounded reviewer-audio segment</li><li>Up to five locally retrieved document chunks</li><li>Up to five recent question/response summaries</li><li>Your optional project summary</li></ul>
    <p>No analytics or telemetry are implemented. Responses use <code>store:false</code>, but OpenAI API retention policies may still apply.</p>
    {usage && <div className="usage"><strong>Local session estimate</strong><span>${usage.estimatedUsd.toFixed(4)} USD</span><small>{usage.inputTokens + usage.outputTokens} text tokens · {usage.audioMinutes.toFixed(2)} audio minutes</small></div>}
    <button onClick={() => window.presenter.clearSession()}>Clear rolling conversation context</button></div>
}

function CaptureStatus({ status }: { status: AppStatus }) {
  return <div className="stack capture-test"><h2>Capture protection</h2><div className="info-grid"><Info label="Requested" value={status.capture.requested ? 'Yes' : 'No'} /><Info label="Electron reported" value={status.capture.electronReported ? 'Enabled' : 'Not enabled'} /><Info label="Windows affinity" value={status.capture.windowsAffinity ?? 'Unknown'} /><Info label="Verified paths" value={String(status.capture.verifiedResults.length)} /></div>
    <Notice tone="warning">This requests exclusion from supported Windows capture paths. It is not a security guarantee and must be tested for each sharing or recording method.</Notice>
    <div className="test-pattern"><span>CAPTURE TEST</span></div>
    <h3>Required manual matrix</h3><ul><li>Google Meet: entire screen, Chrome window, Chrome tab</li><li>Windows Snipping Tool</li><li>OBS Display Capture and Window Capture</li></ul></div>
}

function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' | 'danger' }) { return <div className={`notice ${tone}`}>{children}</div> }
function Info({ label, value }: { label: string; value: string }) { return <div className="info"><small>{label}</small><strong>{value}</strong></div> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
