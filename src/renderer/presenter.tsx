import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AiErrorInfo, AnswerFormat, AppStatus, AssistantResponse, ScreenshotAttachment, TranscriptionDraft } from '../shared/contracts'
import { handleContentScrollKey, isBusy, Notice, useAppState, useRecordingMs } from './appState'
import { AiErrorPanel } from './aiError'
import { LiquidGlass } from './liquidGlass'
import { OperationBanner, ToggleListenButton } from './operationUi'
import { TransmissionPreviewPanel } from './privacyControls'
import { answerFormatAfterSubmission, ClickThroughBanner, CopilotQuickControls } from './quickControls'
import { ResponseCard } from './responseCard'
import { ScreenshotChip, SnapshotButton } from './snapshot'
import { canInsertTranscriptDirectly, mergeTranscriptDraft, TranscriptDraftNotice } from './transcriptDraft'
import { SetupReturnConfirmation, usePresenterSizing } from './workspace'
import { presenterKeys, type PresenterCommand } from '../shared/presenterShortcuts'

/** Audio and display failures need a new capture, not a resend of the same request. */
function retryAllowed(status: AppStatus, error?: AiErrorInfo): boolean {
  return status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout', 'transcript_display_unavailable'].includes(error?.code ?? '')
}

function codeBlocksOf(response?: AssistantResponse): Array<{ code: string }> {
  if (!response) return []
  return response.responseStyle === 'presenter' ? response.codeBlocks ?? [] : response.codeBlocks
}

type SetupSection = 'settings' | 'privacy' | 'documents' | 'capture'

/** The protected, always-on-top glass window used while presenting. */
export function PresenterApp(): React.JSX.Element {
  const { status, setStatus, apiKeyStatus, refresh } = useAppState()
  const [question, setQuestion] = useState('')
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('code')
  const [response, setResponse] = useState<AssistantResponse>()
  const [transcriptDraft, setTranscriptDraft] = useState<{ draft: TranscriptionDraft; conflict: boolean }>()
  const [aiError, setAiError] = useState<AiErrorInfo>()
  // Folding belongs to one answer, so a new answer always starts unfolded.
  const [foldedAnswer, setFoldedAnswer] = useState<AssistantResponse>()
  const [attachment, setAttachment] = useState<ScreenshotAttachment>()
  const [attaching, setAttaching] = useState(false)
  const [flash, setFlash] = useState<PresenterCommand>()
  const copyIndex = useRef(0)
  const recordingMs = useRecordingMs(status)
  const shellRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const questionRef = useRef('')
  const composerRevision = useRef(0)
  const captureComposer = useRef<{ operationId: string; text: string; revision: number } | undefined>(undefined)
  const lastSubmission = useRef<{ format: AnswerFormat; screenshot: boolean }>({ format: 'code', screenshot: false })
  const submitting = useRef(false)
  const workspace = status.workspace ?? { mode: 'presenter' as const }
  const confirming = Boolean(workspace.setupRequest)
  usePresenterSizing(shellRef, contentRef, true)
  const folded = Boolean(response) && foldedAnswer === response
  const toggleFold = (): void => setFoldedAnswer((current) => current === response ? undefined : response)
  useEffect(() => { copyIndex.current = 0 }, [response])
  const showAiError = useCallback((value: AiErrorInfo) => setAiError(value), [])
  const setQuestionFromUser = useCallback((value: string) => {
    composerRevision.current += 1
    questionRef.current = value
    setQuestion(value)
  }, [])

  useEffect(() => {
    const cleanups = [
      window.presenter.onFocusAsk(() => setTimeout(() => input.current?.focus(), 0)),
      window.presenter.onTranscriptDraft((draft) => {
        const canInsert = canInsertTranscriptDirectly(captureComposer.current, draft.operationId, questionRef.current, composerRevision.current)
        if (canInsert) { questionRef.current = draft.text; setQuestion(draft.text) }
        setTranscriptDraft({ draft, conflict: !canInsert })
        setAiError(undefined); setTimeout(() => input.current?.focus(), 0)
      }),
      window.presenter.onError(showAiError)
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [showAiError])
  useEffect(() => { questionRef.current = question }, [question])
  // New Session runs from Setup; a new session id clears this window's draft and answer.
  const sessionId = useRef(status.sessionUsage.sessionId)
  useEffect(() => {
    const previous = sessionId.current
    sessionId.current = status.sessionUsage.sessionId
    if (previous === 'loading' || previous === status.sessionUsage.sessionId) return
    captureComposer.current = undefined
    composerRevision.current += 1
    questionRef.current = ''
    setQuestion(''); setTranscriptDraft(undefined); setResponse(undefined); setAiError(undefined); setAttachment(undefined)
    setAnswerFormat(answerFormatAfterSubmission())
  }, [status.sessionUsage.sessionId])
  // Returning to Setup discards the screenshot in the main process.
  useEffect(() => { if (workspace.mode !== 'presenter') setAttachment(undefined) }, [workspace.mode])
  // An attached screenshot expires in the main process; drop the chip with it.
  useEffect(() => {
    if (!attachment) return
    const timer = setTimeout(() => setAttachment(undefined), Math.max(0, Date.parse(attachment.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [attachment])
  const toggleAttachment = async (): Promise<void> => {
    if (attachment) { setAttachment(undefined); void window.presenter.discardScreenshot().catch(() => undefined); return }
    setAttaching(true); setAiError(undefined)
    try { setAttachment(await window.presenter.attachScreenshot()); setTimeout(() => input.current?.focus(), 0) }
    catch { showAiError({ code: 'unknown', message: 'The screen could not be captured. Try again.', retryable: false }) }
    finally { setAttaching(false) }
  }
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
    if (status.operationKind === 'audio' && (status.operation === 'starting_capture' || status.operation === 'listening')) setAiError(undefined)
  }, [status.operation, status.operationId, status.operationKind])

  /** Sends the composer, or with `retry` resends the last submission (recapturing its screenshot). */
  const ask = async (retry = false): Promise<void> => {
    // Main reports busy only after a round trip, so a quick second press must stop here.
    if (submitting.current) return
    if (transcriptDraft?.conflict) {
      setAiError({ code: 'invalid_transcript', message: 'Choose Replace, Append, or Discard for the pending transcript before submitting.', retryable: false })
      return
    }
    submitting.current = true
    setAiError(undefined); setResponse(undefined); setTranscriptDraft(undefined)
    const submission = retry ? lastSubmission.current : { format: answerFormat, screenshot: Boolean(attachment) }
    lastSubmission.current = submission
    // Presenter is a one-request override; Code stays the visible default.
    setAnswerFormat(answerFormatAfterSubmission())
    let screenshotId = retry ? undefined : attachment?.id
    setAttachment(undefined)
    try {
      // The first screenshot is cleared once its request ends, so a retry takes a new one.
      if (submission.screenshot && !screenshotId) screenshotId = (await window.presenter.attachScreenshot()).id
      const result = screenshotId ? await window.presenter.askAboutScreen(question, screenshotId) : await window.presenter.ask(question, submission.format)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
    finally { submitting.current = false }
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
  const resolveTranscript = (choice: 'replace' | 'append' | 'discard'): void => {
    if (!transcriptDraft) return
    if (choice !== 'discard') setQuestionFromUser(mergeTranscriptDraft(questionRef.current, transcriptDraft.draft.text, choice))
    setTranscriptDraft(undefined); setTimeout(() => input.current?.focus(), 0)
  }
  // Global shortcuts (registered by main only while presenting) run the same
  // actions as the buttons, and only when the button itself would be enabled.
  const runCommand = useRef<(command: PresenterCommand) => void>(() => undefined)
  runCommand.current = (command) => {
    if (confirming) return
    const busy = isBusy(status)
    const shownError = aiError ?? status.operationError
    const ran = ((): boolean => {
      switch (command) {
        case 'send':
          if (!apiKeyStatus.configured || busy || submitting.current || transcriptDraft?.conflict || !(question.trim() || attachment)) return false
          void ask(); return true
        case 'snapshot': if (busy || attaching) return false; void toggleAttachment(); return true
        case 'format': if (busy) return false; setAnswerFormat((format) => format === 'code' ? 'presenter' : 'code'); return true
        case 'fold': if (!response) return false; toggleFold(); return true
        case 'copy': {
          const blocks = codeBlocksOf(response)
          if (!blocks.length || folded) return false
          void window.presenter.copyCode(blocks[copyIndex.current++ % blocks.length]!.code)
          return true
        }
        case 'retry':
          if (busy || !shownError?.retryable || !retryAllowed(status, shownError)) return false
          void ask(true); return true
        case 'cancel':
          if (!busy) return false
          void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }); return true
        case 'transcript-replace': case 'transcript-append':
          if (!transcriptDraft?.conflict) return false
          resolveTranscript(command === 'transcript-replace' ? 'replace' : 'append'); return true
        case 'transcript-discard': if (!transcriptDraft) return false; resolveTranscript('discard'); return true
      }
    })()
    if (ran) { setFlash(undefined); requestAnimationFrame(() => setFlash(command)) }
  }
  useEffect(() => window.presenter.onPresenterCommand((command) => runCommand.current(command)), [])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(undefined), 300)
    return () => clearTimeout(timer)
  }, [flash])
  const openSetup = (section: SetupSection = 'settings'): void => {
    void window.presenter.requestSetup(section).catch((error) => showAiError({ code: 'unknown', message: (error as Error).message, retryable: false }))
  }
  const appearance = status.appearance ?? { glassHaze: 0.5, liveGlass: true }
  return <main ref={shellRef} className={`shell presenter ${status.listening ? 'is-listening' : ''}`} data-flash={flash}>
    <LiquidGlass haze={appearance.glassHaze} enabled={appearance.liveGlass} active={workspace.mode === 'presenter'} />
    <header className="titlebar drag-region" inert={confirming}>
      <div className="brand"><span className="brand-mark">P</span><strong>PresenterAI</strong></div>
      <div className="status-row no-drag">
        <span className="capture-label" title="Windows was asked to hide this window from screen capture. Test each recording app.">
          <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />{status.capture.electronReported ? 'Hidden' : 'Visible to capture'}
        </span>
        {response && <button className="fold-button" aria-expanded={!folded} aria-controls="presenter-answer" title={presenterKeys('fold')} onClick={toggleFold}>{folded ? 'Show answer' : 'Fold answer'}</button>}
        <button onClick={() => openSetup()}>← Setup</button>
      </div>
    </header>
    <ClickThroughBanner status={status.clickThrough} />
    <SetupReturnConfirmation workspace={workspace} busy={isBusy(status)} onError={(message) => showAiError({ code: 'unknown', message, retryable: false })} />
    <section className="content no-drag" tabIndex={0} aria-label="copilot content" onKeyDown={handleContentScrollKey} inert={confirming}>
      <div ref={contentRef} className="workspace-content">
        {workspace.error && <Notice tone="danger">{workspace.error}</Notice>}
        {status.shortcutWarnings.length > 0 && <Notice tone="warning">{status.shortcutWarnings.join(' ')}</Notice>}
        <Copilot folded={folded} onSnapshotResponse={(value) => { setResponse(value); setAiError(undefined); void refresh() }} question={question} setQuestion={setQuestionFromUser} transcriptDraft={transcriptDraft} resolveTranscript={resolveTranscript} answerFormat={answerFormat} setAnswerFormat={setAnswerFormat} onSetClickThrough={setClickThrough} input={input} ask={() => ask()} retry={() => ask(true)} response={response} aiError={aiError ?? status.operationError} openSettings={() => openSetup()} openPrivacy={() => openSetup('privacy')} hasKey={apiKeyStatus.configured} status={status} onAudioError={showAiError} attachment={attachment} attaching={attaching} onToggleAttachment={() => void toggleAttachment()} composerStatus={<>
          {status.outboundPreview && <TransmissionPreviewPanel
            preview={status.outboundPreview}
            onRendered={(operationId, stage) => window.presenter.acknowledgeTransmissionPreview(operationId, stage)}
            onCancel={() => window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) })}
            onError={(message) => showAiError({ code: 'privacy_preview_unavailable', message, retryable: true })}
          />}
          {!status.outboundPreview && <OperationBanner status={status} elapsedMs={recordingMs} onError={showAiError} onCancel={() => { void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }) }} />}
        </>} />
      </div>
    </section>
  </main>
}

function Copilot(props: { folded: boolean; onSnapshotResponse(response: AssistantResponse): void; question: string; setQuestion(v: string): void; transcriptDraft?: { draft: TranscriptionDraft; conflict: boolean }; resolveTranscript(choice: 'replace' | 'append' | 'discard'): void; answerFormat: AnswerFormat; setAnswerFormat(v: AnswerFormat): void; onSetClickThrough(enabled: boolean): Promise<void>; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; retry(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; openPrivacy(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void; attachment?: ScreenshotAttachment; attaching: boolean; onToggleAttachment(): void; composerStatus: React.ReactNode }) {
  const busy = isBusy(props.status)
  const canSubmit = props.hasKey && (Boolean(props.question.trim()) || Boolean(props.attachment)) && !busy && !props.transcriptDraft?.conflict
  const retryIsSafe = retryAllowed(props.status, props.aiError)
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Setup before asking a question.</Notice>}
    <div className="question-box">
      <textarea ref={props.input} value={props.question} onChange={(event) => props.setQuestion(event.target.value)} placeholder={props.attachment ? 'Ask about the screenshot, or just press Send…' : 'Ask a question…'} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSubmit) void props.ask() } }} />
      {/* Overlays the bottom of the text box, so status never changes the layout. */}
      <div className="composer-overlay">
        {props.attachment && <ScreenshotChip onRemove={props.onToggleAttachment} disabled={busy} />}
        <div className="composer-status">{props.composerStatus}</div>
      </div>
      {props.transcriptDraft && <TranscriptDraftNotice draft={props.transcriptDraft.draft} conflict={props.transcriptDraft.conflict} onResolve={props.resolveTranscript} />}
      <CopilotQuickControls
        answerFormat={props.answerFormat}
        clickThrough={props.status.clickThrough}
        answerStyleDisabled={busy}
        onAnswerFormatChange={props.setAnswerFormat}
        onSetClickThrough={props.onSetClickThrough}
      >
        <button className="primary composer-send" disabled={!canSubmit} title={busy ? 'Another operation is active.' : props.transcriptDraft?.conflict ? 'Resolve the pending transcript first.' : `Send (${presenterKeys('send')}, or Ctrl+Enter while typing)`} onClick={() => void props.ask()}>{props.answerFormat === 'code' ? 'Generate code' : 'Ask presenter'} <kbd>Ctrl+Alt+↵</kbd></button>
        <ToggleListenButton status={props.status} onError={props.onAudioError} />
        <SnapshotButton attached={Boolean(props.attachment)} pending={props.attaching} disabled={busy} onToggle={props.onToggleAttachment} />
      </CopilotQuickControls>
    </div>
    {props.aiError && <AiErrorPanel error={props.aiError} allowRetry={retryIsSafe} onRetry={props.retry} onOpenSettings={props.openSettings} onOpenPrivacy={props.openPrivacy} />}
    {props.response && !props.folded && <div id="presenter-answer"><ResponseCard response={props.response} onCopyCode={(code) => window.presenter.copyCode(code)} /></div>}
  </div>
}
