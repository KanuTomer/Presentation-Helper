import React, { useEffect, useRef, useState } from 'react'
import type { ApiKeyStatus, AppSettings, AppStatus, DocumentInfo, UsageLedger } from '../shared/contracts'
import { MODEL_REGISTRY } from '../shared/models'
import { handleContentScrollKey, Info, isBusy, Notice, useAppState, useRecordingMs } from './appState'
import { DocumentsView } from './documents'
import { StageTimingSummary } from './operationUi'
import {
  ListeningConsentPanel, PrivacyDisclosure, RetentionControls, SessionBudgetPanel, UsageEstimatePanel
} from './privacyControls'
import { ShortcutSettingsPanel } from './shortcutRecorder'
import { ApprovedVocabularyEditor } from './vocabularyEditor'

type Section = 'settings' | 'documents' | 'audio' | 'shortcuts' | 'appearance' | 'privacy' | 'capture'

const SECTIONS: Array<[Section, string, string]> = [
  ['settings', 'Get started', 'Your API key and answer quality'],
  ['documents', 'Documents', 'Files the copilot can quote'],
  ['audio', 'Listening', 'Audio device and vocabulary'],
  ['shortcuts', 'Shortcuts', 'Keys that work from anywhere'],
  ['appearance', 'Appearance', 'Presenter glass and text size'],
  ['privacy', 'Privacy & data', 'Usage, what is sent, and deletion'],
  ['capture', 'Capture test', 'Check what recordings can see']
]

/** The ordinary, opaque preparation window. It may appear in recordings. */
export function SetupApp(): React.JSX.Element {
  const { status, settings, setSettings, documents, usage, apiKeyStatus, refresh } = useAppState()
  const [section, setSection] = useState<Section>('settings')
  const [error, setError] = useState('')
  const recordingMs = useRecordingMs(status)
  const busy = isBusy(status)
  const workspace = status.workspace ?? { mode: 'setup' as const }
  useEffect(() => {
    if (workspace.mode === 'setup' && workspace.setupRequest) setSection(workspace.setupRequest)
  }, [workspace.mode, workspace.setupRequest])
  useEffect(() => {
    const cleanups = [
      window.presenter.onOpenSettings(() => setSection('settings')),
      window.presenter.onOpenPrivacy(() => setSection('privacy')),
      window.presenter.onError((value) => { if ((status.workspace?.mode ?? 'setup') === 'setup') setError(value.message) })
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [status.workspace?.mode])
  const enterPresenter = (): void => {
    setError('')
    void window.presenter.enterPresenterMode().catch((value) => setError((value as Error).message))
  }
  const title = SECTIONS.find(([item]) => item === section)
  return <div className="setup">
    <nav className="setup-nav" aria-label="Setup sections">
      <div className="brand"><span className="brand-mark">P</span><div><strong>PresenterAI</strong><small>Prepare your session</small></div></div>
      <ul>{SECTIONS.map(([item, label]) => <li key={item}><button className={section === item ? 'active' : ''} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>{label}</button></li>)}</ul>
      <div className="setup-launch">
        <button className="primary" disabled={!settings || busy} onClick={enterPresenter}>Enter presenter mode →</button>
        <small>The presenter is hidden from screen capture. This Setup window is not.</small>
      </div>
    </nav>
    <main className="setup-main" tabIndex={0} aria-label={`${title?.[1] ?? 'Setup'} content`} onKeyDown={handleContentScrollKey}>
      <header className="setup-header"><h1>{title?.[1]}</h1><p className="muted">{title?.[2]}</p></header>
      <div className="stack">
        {(error || workspace.error) && <Notice tone="danger">{error || workspace.error}</Notice>}
        {status.settingsRecoveryWarning && <Notice tone="warning"><strong>Settings were recovered safely.</strong> The prior file was {status.settingsRecoveryWarning.code.replaceAll('_', ' ')}. <button onClick={async () => { await window.presenter.dismissSettingsRecoveryWarning(); await refresh() }}>Dismiss</button></Notice>}
        {section === 'documents' && <><DocumentsView documents={documents} onChange={refresh} /><fieldset><legend>Project background</legend><textarea value={settings?.projectSummary ?? ''} onChange={(event) => { void window.presenter.updateSettings({ projectSummary: event.target.value }).then(() => refresh()) }} placeholder="Optional: a few lines about your project, sent with each question" /></fieldset></>}
        {section === 'settings' && settings && <SessionSettings settings={settings} apiKeyStatus={apiKeyStatus} onChange={refresh} />}
        {section === 'audio' && settings && <AudioSettings settings={settings} status={status} recordingMs={recordingMs} onChange={refresh} onOpenPrivacy={() => setSection('privacy')} />}
        {section === 'shortcuts' && settings && <ShortcutSettingsPanel askShortcut={settings.askShortcut} hideShortcut={settings.hideShortcut} listenShortcut={settings.listenShortcut} disabled={busy} onChange={async (patch) => { await window.presenter.updateSettings(patch); await refresh() }} registrations={status.shortcutRegistrations} onRetry={async () => { await window.presenter.retryShortcuts(); await refresh() }} />}
        {section === 'appearance' && settings && <AppearanceSettings settings={settings} setSettings={setSettings} onError={setError} onPreview={enterPresenter} />}
        {section === 'privacy' && <Privacy status={status} recordingMs={recordingMs} documents={documents} usage={usage} settings={settings} onChange={refresh} />}
        {section === 'capture' && <CaptureStatus status={status} onChange={refresh} />}
      </div>
    </main>
  </div>
}

function useSettingsUpdate(onChange: () => Promise<void>): { failure: string; update(patch: Partial<AppSettings>): Promise<void> } {
  const [failure, setFailure] = useState('')
  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    setFailure('')
    try { await window.presenter.updateSettings(patch); await onChange() }
    catch (error) { setFailure((error as Error).message || 'The setting could not be saved.') }
  }
  return { failure, update }
}

function SessionSettings({ settings, apiKeyStatus, onChange }: { settings: AppSettings; apiKeyStatus: ApiKeyStatus; onChange(): Promise<void> }) {
  const keyInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState('')
  const { failure, update } = useSettingsUpdate(onChange)
  const [keyFailure, setKeyFailure] = useState('')
  const run = async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
    setKeyFailure(''); setMessage('')
    try { await action() } catch (error) { setKeyFailure((error as Error).message || fallback) }
  }
  const save = () => run(async () => { const value = keyInput.current?.value.trim() ?? ''; if (keyInput.current) keyInput.current.value = ''; await window.presenter.saveApiKey(value); setMessage('Key saved.'); await onChange() }, 'The API key could not be saved.')
  const savedOn = apiKeyStatus.updatedAt ? ` · ${new Date(apiKeyStatus.updatedAt).toLocaleDateString()}` : ''
  return <>
    {(failure || keyFailure) && <Notice tone="danger">{failure || keyFailure}</Notice>}
    <fieldset><legend>OpenAI API key</legend>
      <p className={apiKeyStatus.configured ? '' : 'muted'}>{apiKeyStatus.configured ? `Key saved and encrypted${savedOn}.` : 'No key yet. Paste one to start asking questions.'}</p>
      <div className="actions key-row">
        <input ref={keyInput} type="password" autoComplete="off" aria-label="API key" placeholder={apiKeyStatus.configured ? 'Paste a new key to replace it' : 'sk-…'} onKeyDown={(event) => { if (event.key === 'Enter') void save() }} />
        <button className="primary" onClick={() => void save()}>Save</button>
        <button disabled={!apiKeyStatus.configured} onClick={() => run(async () => setMessage((await window.presenter.testApiKey()).message), 'The API key could not be tested.')}>Test</button>
        <button disabled={!apiKeyStatus.configured} onClick={() => run(async () => { await window.presenter.deleteApiKey(); await onChange() }, 'The API key could not be deleted.')}>Delete</button>
      </div>
      {message && <small role="status">{message}</small>}
    </fieldset>
    <fieldset><legend>Answer quality</legend>
      <div className="segmented" role="radiogroup" aria-label="Answer quality">
        {(['normal', 'strong'] as const).map((mode) => <button key={mode} role="radio" aria-checked={settings.modelMode === mode} className={settings.modelMode === mode ? 'active' : ''} onClick={() => void update({ modelMode: mode })}>
          <strong>{mode === 'normal' ? 'Normal' : 'Strong'}</strong><small>{mode === 'normal' ? `Faster and cheaper · ${settings.normalModel}` : `More careful · ${settings.strongModel}`}</small>
        </button>)}
      </div>
      <details><summary>Models and reasoning</summary>
        {(['normal', 'strong'] as const).map((mode) => <div className="field-pair" key={mode}>
          <label>{mode === 'normal' ? 'Normal model' : 'Strong model'}<select value={mode === 'normal' ? settings.normalModel : settings.strongModel} onChange={(event) => void update(mode === 'normal' ? { normalModel: event.target.value } : { strongModel: event.target.value })}>{MODEL_REGISTRY.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <label>{mode === 'normal' ? 'Normal reasoning' : 'Strong reasoning'}<select value={(mode === 'normal' ? settings.normalReasoning : settings.strongReasoning) ?? 'medium'} onChange={(event) => void update(mode === 'normal' ? { normalReasoning: event.target.value as 'low' | 'medium' | 'high' } : { strongReasoning: event.target.value as 'low' | 'medium' | 'high' })}>{['low', 'medium', 'high'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        </div>)}
        <small>Reasoning and output tokens are billed. There is no spending cap in the app.</small>
      </details>
    </fieldset>
  </>
}

function AudioSettings({ settings, status, recordingMs, onChange, onOpenPrivacy }: { settings: AppSettings; status: AppStatus; recordingMs: number; onChange(): Promise<void>; onOpenPrivacy(): void }) {
  const { failure, update } = useSettingsUpdate(onChange)
  const [retryFailure, setRetryFailure] = useState('')
  const helperHelp: Partial<Record<AppStatus['helperState'], string>> = {
    missing: 'The audio helper is missing. Reinstall PresenterAI.',
    failed: 'Windows may have blocked the unsigned audio helper (Smart App Control). Use a trusted build, then retry.'
  }
  const help = helperHelp[status.helperState]
  return <>
    {(failure || retryFailure) && <Notice tone="danger">{failure || retryFailure}</Notice>}
    {!status.privacyConsent.satisfied && <Notice tone="warning">Listening needs a one-time acknowledgement. <button onClick={onOpenPrivacy}>Review in Privacy & data</button></Notice>}
    <fieldset><legend>Audio source</legend>
      <p className="muted">PresenterAI hears what your PC plays, never the microphone.</p>
      <label>Output device<select value={settings.selectedAudioEndpointId ?? ''} disabled={!status.helperAvailable} onChange={(e) => void update({ selectedAudioEndpointId: e.target.value || undefined })}><option value="">Windows default output</option>{status.audioDevices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.isDefault ? ' (default)' : ''}</option>)}</select></label>
      <div className="actions">
        <span className="helper-health"><span className={`health-dot ${status.helperState}`} />Audio helper: {status.helperState}{status.operation === 'listening' ? ` · recording ${(recordingMs / 1000).toFixed(1)}s` : ''}</span>
        <button onClick={async () => { setRetryFailure(''); try { await window.presenter.refreshAudioDevices(); await onChange() } catch (e) { setRetryFailure((e as Error).message || 'The Windows audio helper could not be retried.') } }}>{status.helperState === 'failed' ? 'Retry helper' : 'Refresh devices'}</button>
      </div>
      {(status.helperError || help) && <Notice tone={status.helperState === 'failed' ? 'danger' : 'warning'}>{[status.helperError, help].filter(Boolean).join(' ')}</Notice>}
    </fieldset>
    <ApprovedVocabularyEditor terms={settings.approvedVocabulary} onChange={(approvedVocabulary) => update({ approvedVocabulary })} />
  </>
}

function AppearanceSettings({ settings, setSettings, onError, onPreview }: { settings: AppSettings; setSettings: React.Dispatch<React.SetStateAction<AppSettings | undefined>>; onError(message: string): void; onPreview(): void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // Sliders update locally at once and persist after a short pause.
  const change = (patch: Partial<AppSettings>, debounce = true): void => {
    setSettings((current) => current ? { ...current, ...patch } : current)
    clearTimeout(timer.current)
    const save = (): void => { void window.presenter.updateSettings(patch).catch((error) => onError((error as Error).message || 'The appearance could not be saved.')) }
    if (debounce) timer.current = setTimeout(save, 120); else save()
  }
  return <>
    <fieldset className="appearance"><legend>Presenter glass</legend>
      <label className="slider">
        <span>Haze <output>{Math.round(settings.glassHaze * 100)}%</output></span>
        <input type="range" aria-label="Glass haze" min="0" max="1" step="0.01" value={settings.glassHaze} onChange={(event) => change({ glassHaze: Number(event.target.value) })} />
        <span className="slider-scale"><small>Clear glass</small><small>Frosted and dark</small></span>
      </label>
      <label className="toggle"><input type="checkbox" checked={settings.liveGlass} onChange={(event) => change({ liveGlass: event.target.checked }, false)} />Live glass backdrop</label>
      <p className="muted">Live glass reads the screen behind the presenter to draw an adjustable blur. Frames stay on this PC's GPU and are never saved or sent. Turned off, the presenter uses Windows' built-in acrylic blur instead: lighter on older or low-power PCs, with a fixed blur strength; Haze then sets only its tint.</p>
    </fieldset>
    <fieldset className="appearance"><legend>Text size</legend>
      <label className="slider">
        <span>Size <output>{Math.round(settings.fontScale * 100)}%</output></span>
        <input type="range" aria-label="Text size" min="0.85" max="1.3" step="0.05" value={settings.fontScale} onChange={(event) => change({ fontScale: Number(event.target.value) })} />
        <span className="slider-scale"><small>A−</small><small>A+</small></span>
      </label>
      <p className="muted">Applies to both windows.</p>
    </fieldset>
    <div className="actions"><button className="primary" onClick={onPreview}>Preview in presenter mode →</button></div>
  </>
}

function Privacy({ status, recordingMs, documents, usage, settings, onChange }: { status: AppStatus; recordingMs: number; documents: DocumentInfo[]; usage?: UsageLedger; settings?: AppSettings; onChange(): Promise<void> }) {
  const busy = isBusy(status)
  const refreshAfter = async (action: () => Promise<unknown>): Promise<void> => { await action(); await onChange() }
  const usageView = usage ? {
    estimatedUsd: usage.summary.estimatedUsd,
    pricingVersion: usage.summary.pricingVersion,
    requestCount: usage.recent.length + usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0),
    unpricedRequestCount: usage.recent.filter((record) => !record.priced).length + usage.rollups.reduce((total, rollup) => total + rollup.unpricedRequestCount, 0),
    rolledUpRequestCount: usage.rollups.reduce((total, rollup) => total + rollup.requestCount, 0)
  } : undefined
  return <>
    <ListeningConsentPanel consent={status.privacyConsent} disabled={busy} onAccept={async (version) => { await window.presenter.acceptListeningConsent(version); await onChange() }} />
    <SessionBudgetPanel budget={status.sessionUsage} disabled={busy} onNewSession={async () => { await window.presenter.startNewSession(); await onChange() }} />
    {usageView && <UsageEstimatePanel usage={usageView} />}
    <PrivacyDisclosure />
    <RetentionControls busy={busy} onDeleteAllSuccess={() => undefined} actions={{
      clearSession: () => refreshAfter(() => window.presenter.clearSession()),
      clearUsage: () => refreshAfter(() => window.presenter.clearUsage()),
      clearCompatibility: () => refreshAfter(() => window.presenter.clearCaptureResults()),
      clearDocuments: () => refreshAfter(() => window.presenter.clearAllDocuments()),
      deleteApiKey: () => refreshAfter(() => window.presenter.deleteApiKey()),
      deleteAllData: () => window.presenter.deleteAllLocalData('DELETE ALL')
    }} />
    <details className="diagnostics"><summary>Status and diagnostics</summary>
      <div className="info-grid"><Info label="Listening" value={status.operation === 'listening' ? `ACTIVE · ${(recordingMs / 1000).toFixed(1)}s` : 'OFF'} /><Info label="Audio source" value={status.activeAudioEndpoint?.name ?? status.audioSource} /><Info label="Audio helper" value={status.helperState} /><Info label="Temporary audio" value={status.temporaryAudioExists ? 'Present until transcription ends' : 'None'} /><Info label="Last capture" value={status.lastCapture ? `${(status.lastCapture.durationMs / 1000).toFixed(1)}s · ${status.lastCapture.endpointName}` : 'None this session'} /><Info label="Last answer shown" value={status.answerRenderConfirmed === undefined ? 'Not measured' : status.answerRenderConfirmed ? 'Confirmed' : 'Not confirmed'} /><Info label="Vocabulary" value={`${settings?.approvedVocabulary.length ?? 0} terms`} /><Info label="Documents" value={`${documents.length} indexed`} /></div>
      <StageTimingSummary timings={status.operationTimings} indicatorLatencyMs={status.indicatorLatencyMs} transcriptRenderLatencyMs={status.transcriptRenderLatencyMs} />
    </details>
  </>
}

function CaptureStatus({ status, onChange }: { status: AppStatus; onChange(): Promise<void> }) {
  const [path, setPath] = useState('Google Meet — entire screen'); const [captureAppVersion, setCaptureAppVersion] = useState('')
  const [controlResult, setControlResult] = useState<'overlay-visible' | 'overlay-absent' | 'overlay-black' | 'unsupported' | 'untested'>('untested')
  const [protectedResult, setProtectedResult] = useState<typeof controlResult>('untested'); const [notes, setNotes] = useState('')
  const outcomes = ['untested', 'overlay-visible', 'overlay-absent', 'overlay-black', 'unsupported'] as const
  return <div className="stack capture-test"><div className="info-grid"><Info label="Requested" value={status.capture.requested ? 'Yes' : 'No'} /><Info label="Electron reported" value={status.capture.electronReported ? 'Enabled' : 'Not enabled'} /><Info label="Verified paths" value={String(status.capture.verifiedResults.filter((result) => result.controlResult !== 'untested' && result.protectedResult !== 'untested').length)} /></div>
    <Notice tone="warning">Hiding from capture isn't guaranteed; test each app you share or record with. These buttons protect this Setup window for the test. The presenter is always protected.</Notice>
    <div className="test-pattern"><span>CAPTURE TEST</span></div>
    <div className="actions"><button className={!status.capture.electronReported ? 'primary' : ''} onClick={async () => { await window.presenter.setCaptureProtection(false); await onChange() }}>Protection OFF control</button><button className={status.capture.electronReported ? 'primary' : ''} onClick={async () => { await window.presenter.setCaptureProtection(true); await onChange() }}>Protection ON</button></div>
    <fieldset><legend>Record test result</legend><label>Capture path<select value={path} onChange={(e) => setPath(e.target.value)}>{['Google Meet — entire screen','Google Meet — Chrome window','Google Meet — Chrome tab','Windows Snipping Tool','OBS Display Capture','OBS Window Capture — Chrome','OBS Window Capture — PresenterAI'].map((value) => <option key={value}>{value}</option>)}</select></label><label>Capture app/version<input value={captureAppVersion} onChange={(e) => setCaptureAppVersion(e.target.value)} placeholder="Chrome 148 / OBS 32…" /></label><label>Protection OFF control<select value={controlResult} onChange={(e) => setControlResult(e.target.value as typeof controlResult)}>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Protection ON result<select value={protectedResult} onChange={(e) => setProtectedResult(e.target.value as typeof protectedResult)}>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label><button className="primary" disabled={!captureAppVersion.trim() || controlResult === 'untested' || protectedResult === 'untested'} onClick={async () => { await window.presenter.saveCaptureResult({ path, captureAppVersion, controlResult, protectedResult, notes }); await window.presenter.setCaptureProtection(false); setNotes(''); await onChange() }}>Save compatibility result</button></fieldset>
    {status.capture.verifiedResults.map((result) => <div className="document" key={result.id}><div><strong>{result.path}</strong><small>OFF: {result.controlResult} · ON: {result.protectedResult}</small><small>{result.captureAppVersion} · Windows {result.environment.windowsBuild}</small></div><button onClick={async () => { await window.presenter.removeCaptureResult(result.id); await onChange() }}>Remove</button></div>)}
    <h3>Required manual matrix</h3><ul><li>Google Meet: entire screen, Chrome window, Chrome tab</li><li>Windows Snipping Tool</li><li>OBS Display Capture and Window Capture</li></ul></div>
}
