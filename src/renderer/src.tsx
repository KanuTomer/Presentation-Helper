import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SetupReturnConfirmation, usePresenterSizing, useWorkspaceAcknowledgement } from './workspace'
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
import { SnapshotButton } from './snapshot'
import { MODEL_REGISTRY } from '../shared/models'
import { QuietGlassLayer } from './quietGlass'
import { answerFormatAfterSubmission, ClickThroughBanner, CopilotQuickControls } from './quickControls'
import { ApprovedVocabularyEditor } from './vocabularyEditor'
import { StatusRefreshGuard } from './statusRefresh'
import { ShortcutSettingsPanel } from './shortcutRecorder'
import { canInsertTranscriptDirectly, mergeTranscriptDraft, TranscriptDraftNotice } from './transcriptDraft'
import {
  ListeningConsentPanel, PrivacyDisclosure, RetentionControls, SessionBudgetPanel, TransmissionPreviewPanel, UsageEstimatePanel
} from './privacyControls'

type View = 'copilot' | 'documents' | 'settings' | 'audio' | 'appearance' | 'privacy' | 'capture'

export const blankStatus: AppStatus = {
  workspace: { mode: 'setup', transition: 'idle' },
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

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('settings')
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
  const [folded, setFolded] = useState(false)
  const shellRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const workspace = status.workspace ?? { mode: 'setup' as const, transition: 'idle' as const }
  const presenterMode = workspace.mode === 'presenter'
  const busy = status.operation !== 'idle' && status.operation !== 'error'
  usePresenterSizing(shellRef, contentRef, presenterMode)
  useEffect(() => { setFolded(false) }, [response])
  useWorkspaceAcknowledgement(workspace.transitionId, setAiError)
  useEffect(() => {
    if (!presenterMode && workspace.setupRequest) setView(workspace.setupRequest)
  }, [presenterMode, workspace.setupRequest])
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
        showAiError({ code: 'unknown', message: (error as Error).message || 'The accent intensity could not be saved.', retryable: false })
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
  const openSetup = (section: 'settings' | 'privacy' | 'documents' | 'capture' = 'settings'): void => {
    if (presenterMode) void window.presenter.requestSetup(section).catch((error) => showAiError({ code: 'unknown', message: (error as Error).message, retryable: false }))
    else setView(section)
  }
  return <main
    ref={shellRef}
    className={`shell workspace-${workspace.mode} ${status.listening ? 'is-listening' : ''}`}
    style={{ '--neon-intensity': neonIntensity } as React.CSSProperties}
  >
      <QuietGlassLayer />
    {status.outboundPreview && <TransmissionPreviewPanel
      preview={status.outboundPreview}
      onRendered={(operationId, stage) => window.presenter.acknowledgeTransmissionPreview(operationId, stage)}
      onCancel={() => window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) })}
      onError={(message) => showAiError({ code: 'privacy_preview_unavailable', message, retryable: true })}
    />}
    <header className="titlebar drag-region" inert={presenterMode && Boolean(workspace.setupRequest)}>
      <div className="brand"><span className="brand-mark">P</span><div><strong>PresenterAI</strong>{!presenterMode && <small>Prepare your session</small>}</div></div>
      <div className="status-row no-drag">
        <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />
        {presenterMode ? <><span className="capture-label">{status.capture.electronReported ? 'Protection requested · unverified*' : 'Protection unavailable'}</span><button onClick={() => openSetup()}>← Setup</button>{response && <button aria-expanded={!folded} aria-controls="presenter-answer" onClick={() => setFolded(!folded)}>{folded ? 'Show answer' : 'Fold answer'}</button>}</> : <button className="icon-button" onClick={() => setView('capture')}>Capture compatibility</button>}
      </div>
    </header>

    <OperationBanner status={status} elapsedMs={recordingMs} onError={showAiError} onCancel={() => { void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }) }} />
    <ClickThroughBanner status={status.clickThrough} />

    {!presenterMode && <nav className="tabs setup-tabs no-drag" aria-label="Setup sections">
      {([['settings', 'Session & models'], ['documents', 'Documents & context'], ['audio', 'Audio & shortcuts'], ['appearance', 'Appearance'], ['privacy', 'Privacy & data']] as Array<[View, string]>).map(([item, label]) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{label}</button>)}
    </nav>}
    {presenterMode && <SetupReturnConfirmation workspace={workspace} busy={busy} onError={(message) => showAiError({ code: 'unknown', message, retryable: false })} />}

    <section className="content no-drag" tabIndex={0} aria-label={`${presenterMode ? 'copilot' : view} content`} onKeyDown={handleContentScrollKey} inert={presenterMode && Boolean(workspace.setupRequest)}>
      <div ref={contentRef} className="workspace-content">
      {workspace.error && <Notice tone="danger">{workspace.error}</Notice>}
      {status.settingsRecoveryWarning && <Notice tone="warning"><strong>Settings were recovered safely.</strong> The prior file was {status.settingsRecoveryWarning.code.replaceAll('_', ' ')}. <button onClick={async () => { await window.presenter.dismissSettingsRecoveryWarning(); await refresh() }}>Dismiss</button></Notice>}
      {presenterMode && <Copilot folded={folded} onSnapshotResponse={(value) => { setResponse(value); setAiError(undefined); void refresh() }} question={question} setQuestion={setQuestionFromUser} transcriptDraft={transcriptDraft} resolveTranscript={(choice) => {
        if (!transcriptDraft) return
        if (choice !== 'discard') setQuestionFromUser(mergeTranscriptDraft(questionRef.current, transcriptDraft.draft.text, choice))
        setTranscriptDraft(undefined); setTimeout(() => input.current?.focus(), 0)
      }} answerFormat={answerFormat} setAnswerFormat={setAnswerFormat} onSetClickThrough={setClickThrough} input={input} ask={() => ask()} retry={() => ask(lastSubmittedFormat.current)} response={response} aiError={aiError ?? status.operationError} openSettings={() => openSetup()} openPrivacy={() => openSetup('privacy')} hasKey={apiKeyStatus.configured} status={status} onAudioError={showAiError} />}
      {!presenterMode && view === 'documents' && <><DocumentsView documents={documents} onChange={refresh} /><fieldset><legend>Project summary</legend><textarea value={settings?.projectSummary ?? ''} onChange={(event) => { void window.presenter.updateSettings({ projectSummary: event.target.value }).then(() => refresh()) }} placeholder="Optional user-authored project background" /></fieldset></>}
      {!presenterMode && ['settings', 'audio', 'appearance'].includes(view) && settings && <Settings group={view as 'settings' | 'audio' | 'appearance'} settings={settings} status={status} recordingMs={recordingMs} apiKeyStatus={apiKeyStatus} onNeonIntensityChange={updateNeonIntensity} onChange={refresh} />}
      {!presenterMode && view === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} settings={settings} onNewSession={async () => {
        await window.presenter.startNewSession()
        clearRendererSession()
        await refresh()
      }} onDeleteAllSuccess={clearRendererSession} onChange={refresh} />}
      {!presenterMode && view === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
      </div>
    </section>
    {!presenterMode && <footer className="setup-footer"><span>Listening off · Setup may appear in recordings</span><button className="primary" disabled={!settings || busy || workspace.transition !== 'idle'} onClick={() => void window.presenter.enterPresenterMode().catch((error) => setAiError({ code: 'unknown', message: (error as Error).message, retryable: false }))}>Enter presenter mode →</button></footer>}
  </main>
}

function Copilot(props: { folded: boolean; onSnapshotResponse(response: AssistantResponse): void; question: string; setQuestion(v: string): void; transcriptDraft?: { draft: TranscriptionDraft; conflict: boolean }; resolveTranscript(choice: 'replace' | 'append' | 'discard'): void; answerFormat: AnswerFormat; setAnswerFormat(v: AnswerFormat): void; onSetClickThrough(enabled: boolean): Promise<void>; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; retry(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; openPrivacy(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void }) {
  const busy = props.status.operation !== 'idle' && props.status.operation !== 'error'
  const canSubmit = props.hasKey && Boolean(props.question.trim()) && !busy && !props.transcriptDraft?.conflict
  const retryIsSafe = props.status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout', 'transcript_display_unavailable'].includes(props.aiError?.code ?? '')
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Settings before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder="Ask a reviewer question…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSubmit) void props.ask() } }} />
      {props.transcriptDraft && <TranscriptDraftNotice draft={props.transcriptDraft.draft} conflict={props.transcriptDraft.conflict} onResolve={props.resolveTranscript} />}
      <CopilotQuickControls
        answerFormat={props.answerFormat}
        clickThrough={props.status.clickThrough}
        answerStyleDisabled={busy}
        onAnswerFormatChange={props.setAnswerFormat}
        onSetClickThrough={props.onSetClickThrough}
      >
        <button className="primary" disabled={!canSubmit} title={busy ? 'Another operation is active.' : props.transcriptDraft?.conflict ? 'Resolve the pending transcript first.' : undefined} onClick={() => void props.ask()}>{props.answerFormat === 'code' ? 'Generate code' : 'Ask presenter'} <kbd>Ctrl↵</kbd></button>
        <ToggleListenButton status={props.status} onError={props.onAudioError} />
        <SnapshotButton disabled={busy} canSend={props.hasKey} onOpenSettings={props.openSettings} sessionId={props.status.sessionUsage.sessionId} onResponse={props.onSnapshotResponse} onError={props.onAudioError} />
      </CopilotQuickControls>
    </div>
    {props.aiError && <AiErrorPanel error={props.aiError} allowRetry={retryIsSafe} onRetry={props.retry} onOpenSettings={props.openSettings} onOpenPrivacy={props.openPrivacy} />}
    {props.response && !props.folded && <div id="presenter-answer"><ResponseCard response={props.response} onCopyCode={(code) => window.presenter.copyCode(code)} /></div>}
  </div>
}

function Settings({ group, settings, status, recordingMs, apiKeyStatus, onNeonIntensityChange, onChange }: { group: 'settings' | 'audio' | 'appearance'; settings: AppSettings; status: AppStatus; recordingMs: number; apiKeyStatus: ApiKeyStatus; onNeonIntensityChange(value: number): void; onChange(): Promise<void> }) {
  const keyInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState(''); const [failure, setFailure] = useState('')
  const update = async (patch: Partial<AppSettings>) => {
    setFailure('')
    try { await window.presenter.updateSettings(patch); await onChange() }
    catch (error) { setFailure((error as Error).message || 'The setting could not be saved.') }
  }
  const busy = status.operation !== 'idle' && status.operation !== 'error'
  return <div className={`stack settings-group group-${group}`}><h2>{group === 'audio' ? 'Audio & shortcuts' : group === 'appearance' ? 'Appearance' : 'Session & models'}</h2>
    {failure && <Notice tone="danger">{failure}</Notice>}
    <fieldset className="appearance-settings" data-group="appearance"><legend>Appearance</legend>
      <label className="neon-control">
        <span>Accent intensity <output>{Math.round(settings.neonIntensity * 100)}%</output></span>
        <input
          aria-label="Accent intensity"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={settings.neonIntensity}
          onChange={(event) => onNeonIntensityChange(Number(event.target.value))}
        />
      </label>
      <p className="muted">Controls static blue-violet rims and button accents only. Text and reading surfaces stay fixed.</p>
    </fieldset>
    <fieldset data-group="settings"><legend>OpenAI API key</legend><p>{apiKeyStatus.configured ? 'A masked, DPAPI-encrypted key is stored for this Windows user.' : 'No API key is stored.'}</p>{apiKeyStatus.updatedAt && <small>Last replaced {new Date(apiKeyStatus.updatedAt).toLocaleString()}</small>}<p className="muted">Protection: {apiKeyStatus.protection === 'windows-dpapi' ? 'Windows DPAPI' : 'secure storage unavailable'}. DPAPI primarily protects against other Windows users, not every process already running as you.</p><input ref={keyInput} type="password" autoComplete="off" placeholder="sk-…" /><div className="actions"><button className="primary" onClick={async () => { const value = keyInput.current?.value.trim() ?? ''; if (keyInput.current) keyInput.current.value = ''; try { await window.presenter.saveApiKey(value); setMessage('Key saved.'); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be saved.') } }}>Save key</button><button disabled={!apiKeyStatus.configured} onClick={async () => { try { setMessage((await window.presenter.testApiKey()).message) } catch (e) { setFailure((e as Error).message || 'The API key could not be tested.') } }}>Test</button><button disabled={!apiKeyStatus.configured} onClick={async () => { try { await window.presenter.deleteApiKey(); await onChange() } catch (e) { setFailure((e as Error).message || 'The API key could not be deleted.') } }}>Delete</button></div>{message && <small>{message}</small>}</fieldset>
    <fieldset data-group="settings"><legend>Answer model</legend><select value={settings.modelMode} onChange={(e) => void update({ modelMode: e.target.value as AppSettings['modelMode'] })}><option value="normal">Normal · {settings.normalModel}</option><option value="strong">Strong · {settings.strongModel}</option></select></fieldset>
    <fieldset data-group="audio"><legend>System audio output</legend><p className="muted">PresenterAI captures all sound played through the selected Windows output device. It does not listen to the microphone.</p><div className="helper-health"><span className={`health-dot ${status.helperState}`} /><strong>{status.helperState}</strong></div>{status.operation === 'listening' && <p>Recording: {(recordingMs / 1000).toFixed(1)} seconds</p>}<Info label="Active capture endpoint" value={status.activeAudioEndpoint?.name ?? 'None — listening is off'} />{status.helperError && <Notice tone={status.helperState === 'failed' ? 'danger' : 'warning'}>{status.helperError}</Notice>}{status.helperState === 'missing' && <p className="muted">Reinstall PresenterAI or run the packaged build so the Windows helper is available.</p>}{status.helperState === 'failed' && <p className="muted">An unsigned helper may have been blocked by Windows Smart App Control or App Control. PresenterAI never disables that protection. Retry after using a trusted-signed build or an authorized development environment.</p>}<label>Preferred output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label><button onClick={async () => { setFailure(''); try { await window.presenter.refreshAudioDevices(); await onChange() } catch (e) { setFailure((e as Error).message || 'The Windows audio helper could not be retried.') } }}>{status.helperState === 'failed' ? 'Retry helper' : 'Refresh devices'}</button>{status.shortcutWarnings.map((warning) => <Notice tone="warning" key={warning}>{warning}</Notice>)}</fieldset>
    <div data-group="audio"><ApprovedVocabularyEditor terms={settings.approvedVocabulary} onChange={(approvedVocabulary) => update({ approvedVocabulary })} /></div>

    <div data-group="audio"><ShortcutSettingsPanel askShortcut={settings.askShortcut} hideShortcut={settings.hideShortcut} listenShortcut={settings.listenShortcut} disabled={busy} onChange={update} registrations={status.shortcutRegistrations} onRetry={async () => { await window.presenter.retryShortcuts(); await onChange() }} /></div>
    <fieldset data-group="settings"><legend>Model and reasoning</legend>{(['normal', 'strong'] as const).map((mode) => <div key={mode}>
      <label>{mode === 'normal' ? 'Normal model' : 'Strong model'}<select value={mode === 'normal' ? settings.normalModel : settings.strongModel} onChange={(event) => void update(mode === 'normal' ? { normalModel: event.target.value } : { strongModel: event.target.value })}>{MODEL_REGISTRY.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
      <label>{mode === 'normal' ? 'Normal reasoning' : 'Strong reasoning'}<select value={(mode === 'normal' ? settings.normalReasoning : settings.strongReasoning) ?? 'medium'} onChange={(event) => void update(mode === 'normal' ? { normalReasoning: event.target.value as 'low' | 'medium' | 'high' } : { strongReasoning: event.target.value as 'low' | 'medium' | 'high' })}>{['low', 'medium', 'high'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
    </div>)}<p className="muted">No application spending cap. Reasoning and output tokens are billable. Models never switch automatically; account-level limits still apply.</p></fieldset>
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
    <SessionBudgetPanel budget={status.sessionUsage} disabled={busy} onNewSession={onNewSession} />
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
