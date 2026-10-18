import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AiErrorInfo, AnswerFormat, AppStatus, AssistantResponse, TranscriptionDraft } from '../shared/contracts'
import { handleContentScrollKey, isBusy, Notice, useAppState, useRecordingMs } from './appState'
import { AiErrorPanel } from './aiError'
import { LiquidGlass } from './liquidGlass'
import { OperationBanner, ToggleListenButton } from './operationUi'
import { TransmissionPreviewPanel } from './privacyControls'
import { answerFormatAfterSubmission, ClickThroughBanner, CopilotQuickControls } from './quickControls'
import { ResponseCard } from './responseCard'
import { SnapshotButton } from './snapshot'
import { canInsertTranscriptDirectly, mergeTranscriptDraft, TranscriptDraftNotice } from './transcriptDraft'
import { SetupReturnConfirmation, usePresenterSizing } from './workspace'

type SetupSection = 'settings' | 'privacy' | 'documents' | 'capture'

/** The protected, always-on-top glass window used while presenting. */
export function PresenterApp(): React.JSX.Element {
  const { status, setStatus, apiKeyStatus, refresh } = useAppState()
  const [question, setQuestion] = useState('')
  const [answerFormat, setAnswerFormat] = useState<AnswerFormat>('code')
  const [response, setResponse] = useState<AssistantResponse>()
  const [transcriptDraft, setTranscriptDraft] = useState<{ draft: TranscriptionDraft; conflict: boolean }>()
  const [aiError, setAiError] = useState<AiErrorInfo>()
  const [folded, setFolded] = useState(false)
  const recordingMs = useRecordingMs(status)
  const shellRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const questionRef = useRef('')
  const composerRevision = useRef(0)
  const captureComposer = useRef<{ operationId: string; text: string; revision: number } | undefined>(undefined)
  const lastSubmittedFormat = useRef<AnswerFormat>('code')
  const workspace = status.workspace ?? { mode: 'presenter' as const }
  const confirming = Boolean(workspace.setupRequest)
  usePresenterSizing(shellRef, contentRef, true)
  useEffect(() => { setFolded(false) }, [response])
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
    setQuestion(''); setTranscriptDraft(undefined); setResponse(undefined); setAiError(undefined)
    setAnswerFormat(answerFormatAfterSubmission())
  }, [status.sessionUsage.sessionId])
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

  const ask = async (formatOverride?: AnswerFormat): Promise<void> => {
    if (transcriptDraft?.conflict) {
      setAiError({ code: 'invalid_transcript', message: 'Choose Replace, Append, or Discard for the pending transcript before submitting.', retryable: false })
      return
    }
    setAiError(undefined); setResponse(undefined); setTranscriptDraft(undefined)
    const requestedFormat = formatOverride ?? answerFormat
    lastSubmittedFormat.current = requestedFormat
    // Presenter is a one-request override; Code stays the visible default.
    setAnswerFormat(answerFormatAfterSubmission())
    try {
      const result = await window.presenter.ask(question, requestedFormat)
      if (result.ok) setResponse(result.response); else setAiError(result.error)
      void refresh()
    } catch (value) { setAiError({ code: 'unknown', message: (value as Error).message || 'Request failed.', retryable: false }) }
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
  const openSetup = (section: SetupSection = 'settings'): void => {
    void window.presenter.requestSetup(section).catch((error) => showAiError({ code: 'unknown', message: (error as Error).message, retryable: false }))
  }
  const appearance = status.appearance ?? { glassHaze: 0.5, liveGlass: true }
  return <main ref={shellRef} className={`shell presenter ${status.listening ? 'is-listening' : ''}`}>
    <LiquidGlass haze={appearance.glassHaze} enabled={appearance.liveGlass} />
    {status.outboundPreview && <TransmissionPreviewPanel
      preview={status.outboundPreview}
      onRendered={(operationId, stage) => window.presenter.acknowledgeTransmissionPreview(operationId, stage)}
      onCancel={() => window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) })}
      onError={(message) => showAiError({ code: 'privacy_preview_unavailable', message, retryable: true })}
    />}
    <header className="titlebar drag-region" inert={confirming}>
      <div className="brand"><span className="brand-mark">P</span><strong>PresenterAI</strong></div>
      <div className="status-row no-drag">
        <span className={`privacy-dot ${status.capture.electronReported ? 'protected' : 'warning'}`} />
        <span className="capture-label">{status.capture.electronReported ? 'Hidden from capture*' : 'Protection unavailable'}</span>
        {response && <button aria-expanded={!folded} aria-controls="presenter-answer" onClick={() => setFolded(!folded)}>{folded ? 'Show answer' : 'Fold answer'}</button>}
        <button onClick={() => openSetup()}>← Setup</button>
      </div>
    </header>
    <OperationBanner status={status} elapsedMs={recordingMs} onError={showAiError} onCancel={() => { void window.presenter.cancel().then((result) => { if (!result.ok) showAiError(result.error) }) }} />
    <ClickThroughBanner status={status.clickThrough} />
    <SetupReturnConfirmation workspace={workspace} busy={isBusy(status)} onError={(message) => showAiError({ code: 'unknown', message, retryable: false })} />
    <section className="content no-drag" tabIndex={0} aria-label="copilot content" onKeyDown={handleContentScrollKey} inert={confirming}>
      <div ref={contentRef} className="workspace-content">
        {workspace.error && <Notice tone="danger">{workspace.error}</Notice>}
        <Copilot folded={folded} onSnapshotResponse={(value) => { setResponse(value); setAiError(undefined); void refresh() }} question={question} setQuestion={setQuestionFromUser} transcriptDraft={transcriptDraft} resolveTranscript={(choice) => {
          if (!transcriptDraft) return
          if (choice !== 'discard') setQuestionFromUser(mergeTranscriptDraft(questionRef.current, transcriptDraft.draft.text, choice))
          setTranscriptDraft(undefined); setTimeout(() => input.current?.focus(), 0)
        }} answerFormat={answerFormat} setAnswerFormat={setAnswerFormat} onSetClickThrough={setClickThrough} input={input} ask={() => ask()} retry={() => ask(lastSubmittedFormat.current)} response={response} aiError={aiError ?? status.operationError} openSettings={() => openSetup()} openPrivacy={() => openSetup('privacy')} hasKey={apiKeyStatus.configured} status={status} onAudioError={showAiError} />
      </div>
    </section>
  </main>
}

function Copilot(props: { folded: boolean; onSnapshotResponse(response: AssistantResponse): void; question: string; setQuestion(v: string): void; transcriptDraft?: { draft: TranscriptionDraft; conflict: boolean }; resolveTranscript(choice: 'replace' | 'append' | 'discard'): void; answerFormat: AnswerFormat; setAnswerFormat(v: AnswerFormat): void; onSetClickThrough(enabled: boolean): Promise<void>; input: React.RefObject<HTMLTextAreaElement | null>; ask(): void; retry(): void; response?: AssistantResponse; aiError?: AiErrorInfo; openSettings(): void; openPrivacy(): void; hasKey: boolean; status: AppStatus; onAudioError(error: AiErrorInfo): void }) {
  const busy = isBusy(props.status)
  const canSubmit = props.hasKey && Boolean(props.question.trim()) && !busy && !props.transcriptDraft?.conflict
  const retryIsSafe = props.status.operationKind !== 'audio' && !['busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout', 'transcript_display_unavailable'].includes(props.aiError?.code ?? '')
  return <div className="stack">
    {!props.hasKey && <Notice tone="warning">Add your OpenAI API key in Setup before asking a question.</Notice>}
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
