import React, { useEffect, useRef } from 'react'
import type { AiErrorInfo, AppStatus, OperationState, OperationTimings } from '../shared/contracts'

const stageLabels: Record<Exclude<OperationState, 'idle' | 'error' | 'listening'>, string> = {
  starting_capture: 'STARTING SYSTEM AUDIO',
  finalizing: 'FINALIZING RECORDING',
  transcribing: 'TRANSCRIBING',
  retrieving: 'RETRIEVING EVIDENCE',
  generating: 'GENERATING RESPONSE',
  cancelling: 'CANCELLING'
}

const timingLabels: Array<[keyof OperationTimings, string]> = [
  ['captureStartMs', 'Capture start'],
  ['listeningMs', 'Listening'],
  ['finalizationMs', 'Finalization'],
  ['transcriptionMs', 'Transcription'],
  ['retrievalMs', 'Retrieval'],
  ['generationMs', 'Generation'],
  ['stopToAnswerMs', 'Stop to answer'],
  ['totalMs', 'Total']
]

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`
}

export function OperationBanner({
  status,
  elapsedMs,
  onCancel,
  onError
}: {
  status: AppStatus
  elapsedMs: number
  onCancel(): void
  onError(error: AiErrorInfo): void
}): React.JSX.Element | null {
  const acknowledged = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (status.operation !== 'listening' || !status.operationId || acknowledged.current === status.operationId) return
    const operationId = status.operationId
    let paintedFrame = 0
    const renderedFrame = window.requestAnimationFrame(() => {
      // A second animation frame occurs after the first frame containing the
      // red banner has been submitted for paint. A single rAF would only prove
      // that React committed the DOM, not that the user could see it.
      paintedFrame = window.requestAnimationFrame(() => {
        acknowledged.current = operationId
        void window.presenter.ackListeningIndicator(operationId).catch(() => {
          onError({ code: 'unknown', message: 'Could not record the listening-indicator timing.', retryable: false })
        })
      })
    })
    return () => {
      window.cancelAnimationFrame(renderedFrame)
      if (paintedFrame) window.cancelAnimationFrame(paintedFrame)
    }
  }, [status.operation, status.operationId, onError])

  if (status.operation === 'idle' || status.operation === 'error') return null
  const listening = status.operation === 'listening'
  const endpoint = status.activeAudioEndpoint?.name ?? status.audioSource
  const label = status.operation === 'listening'
    ? `LISTENING · ${endpoint} · ${(elapsedMs / 1_000).toFixed(1)}s`
    : stageLabels[status.operation]

  return <div
    className={listening ? 'listening-banner' : `progress-banner stage-${status.operation}`}
    role="status"
    aria-live={listening ? 'assertive' : 'polite'}
    data-operation={status.operation}
  >
    {listening && <span className="pulse" aria-hidden="true" />}
    <span>{label}</span>
    <button onClick={onCancel}>Esc / Cancel</button>
  </div>
}

export function AnswerRenderAcknowledger({
  operationId,
  onAcknowledged,
  onError
}: {
  operationId: string
  onAcknowledged(operationId: string): void
  onError(error: AiErrorInfo): void
}): null {
  useEffect(() => {
    let paintedFrame = 0
    const renderedFrame = window.requestAnimationFrame(() => {
      paintedFrame = window.requestAnimationFrame(() => {
        void window.presenter.ackAnswerVisible(operationId).then(() => onAcknowledged(operationId)).catch(() => {
          onError({ code: 'unknown', message: 'Could not confirm that the generated answer became visible.', retryable: false })
        })
      })
    })
    return () => {
      window.cancelAnimationFrame(renderedFrame)
      if (paintedFrame) window.cancelAnimationFrame(paintedFrame)
    }
  }, [operationId, onAcknowledged, onError])
  return null
}

export function StageTimingSummary({ timings, indicatorLatencyMs }: { timings: OperationTimings; indicatorLatencyMs?: number }): React.JSX.Element | null {
  const rows: Array<{ key: string; label: string; value: number }> = timingLabels.flatMap(([key, label]) => {
    const value = timings[key]
    return value === undefined ? [] : [{ key, label, value }]
  })
  if (indicatorLatencyMs !== undefined) rows.splice(1, 0, { key: 'indicatorLatencyMs', label: 'Listening indicator', value: indicatorLatencyMs })
  if (rows.length === 0) return null

  return <section className="stage-timings" aria-label="Last operation timings">
    <h3>LAST OPERATION TIMINGS</h3>
    <dl>{rows.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{formatDuration(row.value)}</dd></div>)}</dl>
  </section>
}

export function ToggleListenButton({ status, onError }: { status: AppStatus; onError(error: AiErrorInfo): void }): React.JSX.Element {
  const activeAudio = status.operationKind === 'audio' && ['starting_capture', 'listening'].includes(status.operation)
  const availableToStart = status.operation === 'idle' || status.operation === 'error'
  const blocked = !status.helperAvailable || (!availableToStart && !activeAudio)
  const title = !status.helperAvailable
    ? 'The Windows audio helper is unavailable. Open Settings for recovery details.'
    : blocked
      ? 'Another operation is active.'
      : activeAudio ? 'Stop system-audio capture and answer' : 'Start capturing the selected Windows system-output device'

  return <button
    disabled={blocked}
    aria-pressed={activeAudio}
    title={title}
    onClick={() => {
      if (blocked) return
      void window.presenter.toggleListening().then((result) => {
        if (!result.ok) onError(result.error)
      }).catch(() => {
        onError({ code: 'helper_unavailable', message: 'The Windows system-audio helper could not toggle capture.', retryable: true })
      })
    }}
  >{activeAudio ? '■ Stop & answer' : '◉ Start listening'}</button>
}
