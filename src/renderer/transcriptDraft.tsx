import React from 'react'
import type { TranscriptionDraft } from '../shared/contracts'

export interface ComposerCaptureSnapshot {
  operationId: string
  text: string
  revision: number
}

export function canInsertTranscriptDirectly(
  snapshot: ComposerCaptureSnapshot | undefined,
  draftOperationId: string,
  currentText: string,
  currentRevision: number
): boolean {
  return Boolean(
    snapshot && snapshot.operationId === draftOperationId && snapshot.text.length === 0 &&
    currentText.length === 0 && snapshot.revision === currentRevision
  )
}

export function mergeTranscriptDraft(current: string, transcript: string, choice: 'replace' | 'append'): string {
  if (choice === 'replace') return transcript
  return `${current}${current.trim() ? '\n\n' : ''}${transcript}`
}

export function TranscriptDraftNotice({
  draft,
  conflict,
  onResolve
}: {
  draft: TranscriptionDraft
  conflict: boolean
  onResolve(choice: 'replace' | 'append' | 'discard'): void
}): React.JSX.Element {
  return <section className={`transcript-draft ${conflict ? 'conflict' : ''}`} role="status" aria-live="polite">
    <div><strong>{conflict ? 'A transcript is ready' : 'Transcript inserted — review before sending'}</strong><small>{(draft.durationMs / 1_000).toFixed(1)}s from {draft.endpointName}</small></div>
    {conflict
      ? <><p className="transcript-preview" aria-label="Recognized transcript">{draft.text}</p><div className="actions"><button type="button" className="primary" onClick={() => onResolve('replace')}>Replace</button><button type="button" onClick={() => onResolve('append')}>Append</button><button type="button" onClick={() => onResolve('discard')}>Discard</button></div></>
      : <button type="button" onClick={() => onResolve('discard')}>Dismiss</button>}
  </section>
}
