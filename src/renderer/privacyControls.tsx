import React, { useEffect, useRef, useState } from 'react'
import type { SessionUsageStatus } from '../shared/contracts'

export interface PrivacyConsentView {
  requiredVersion: number
  acceptedVersion?: number
  acceptedAt?: string
  satisfied: boolean
}

export interface OutboundTransmissionPreviewView {
  operationId: string
  stage: 'transcription' | 'response'
  audio?: { durationMs: number; bytes: number; endpointName: string }
  screenshot?: boolean
  terminologyHint?: string
  chunks: Array<{
    chunkId: string
    documentName: string
    title?: string
    location: string
    text: string
  }>
  rollingTurnCount: number
  includesProjectSummary: boolean
}

export interface UsageEstimateView {
  estimatedUsd: number
  pricingVersion: string
  requestCount: number
  unpricedRequestCount: number
  rolledUpRequestCount?: number
}

export function ListeningConsentPanel({
  consent,
  disabled = false,
  onAccept
}: {
  consent: PrivacyConsentView
  disabled?: boolean
  onAccept(version: number): Promise<void> | void
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  if (consent.satisfied) {
    return <div className="notice neutral consent-status"><strong>Listening disclosure accepted</strong><small>Version {consent.acceptedVersion}{consent.acceptedAt ? ` · ${new Date(consent.acceptedAt).toLocaleDateString()}` : ''}</small></div>
  }
  const accept = async (): Promise<void> => {
    setPending(true); setError('')
    try { await onAccept(consent.requiredVersion) }
    catch (value) { setError((value as Error).message || 'The acknowledgement could not be saved.') }
    finally { setPending(false) }
  }
  return <fieldset className="listening-consent">
    <legend>Before you use listening</legend>
    <p>Listening records your PC's sound output only while you toggle it on, then shows an editable transcript. Nothing is sent for an answer until you submit it. A red indicator stays visible while recording.</p>
    <p className="muted">Live AI help may break the rules of interviews, exams, or graded work. Check first and get consent where needed.</p>
    <button type="button" className="primary" disabled={disabled || pending} onClick={() => void accept()}>{pending ? 'Saving…' : 'I understand and enable transcript review'}</button>
    {error && <p className="field-error" role="alert">{error}</p>}
  </fieldset>
}

/**
 * Acknowledges the first painted preview frame. The main process owns the
 * two-second fail-closed timeout and rejects stale operation IDs.
 */
export function TransmissionPreviewPanel({
  preview,
  onRendered,
  onCancel,
  onError
}: {
  preview: OutboundTransmissionPreviewView
  onRendered(operationId: string, stage: OutboundTransmissionPreviewView['stage']): Promise<void> | void
  onCancel?(): Promise<void> | void
  onError?(message: string): void
}): React.JSX.Element {
  const acknowledged = useRef('')
  const onRenderedRef = useRef(onRendered)
  const onErrorRef = useRef(onError)
  useEffect(() => { onRenderedRef.current = onRendered }, [onRendered])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => {
    const key = `${preview.operationId}:${preview.stage}`
    if (acknowledged.current === key) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        acknowledged.current = key
        void Promise.resolve(onRenderedRef.current(preview.operationId, preview.stage)).catch((error) => {
          onErrorRef.current?.((error as Error).message || 'PresenterAI could not confirm the transmission preview.')
        })
      })
    })
    return () => { window.cancelAnimationFrame(firstFrame); if (secondFrame) window.cancelAnimationFrame(secondFrame) }
  }, [preview.operationId, preview.stage])

  const parts = preview.audio
    ? [`${(preview.audio.durationMs / 1_000).toFixed(1)}s audio`, `${Math.ceil(preview.audio.bytes / 1_024)} KiB`]
    : [...(preview.screenshot ? ['screenshot'] : []), 'question', `${preview.chunks.length} snippet${preview.chunks.length === 1 ? '' : 's'}`, `${preview.rollingTurnCount} recent turn${preview.rollingTurnCount === 1 ? '' : 's'}`, ...(preview.includesProjectSummary ? ['background'] : [])]
  // One line by default; everything that is sent stays inspectable on demand.
  return <section className="transmission-preview" aria-live="polite" aria-label="OpenAI transmission preview">
    <div className="preview-line">
      <span className="progress-dot" aria-hidden="true" />
      <strong>{preview.stage === 'transcription' ? 'Sending for transcription' : 'Sending'}</strong>
      <span className="muted">{parts.join(' · ')}</span>
      {onCancel && <button type="button" onClick={() => void onCancel()}>Cancel</button>}
    </div>
    {(preview.audio || preview.terminologyHint || preview.chunks.length > 0) && <details className="preview-details"><summary>Details</summary>
      {preview.audio && <p className="muted">From {preview.audio.endpointName}</p>}
      {preview.terminologyHint && <p className="muted">Vocabulary hint: {preview.terminologyHint}</p>}
      {preview.chunks.length > 0 && <div className="preview-chunks">{preview.chunks.map((chunk) => <details key={chunk.chunkId}>
        <summary>{chunk.documentName} · {chunk.title ? `${chunk.title} · ` : ''}{chunk.location}</summary>
        <p>{chunk.text}</p>
      </details>)}</div>}
    </details>}
  </section>
}

export function PrivacyDisclosure(): React.JSX.Element {
  return <section className="privacy-disclosure">
    <h3>What gets sent</h3>
    <ul>
      <li>Only what you send: your question, the document snippets it needs, and audio or a snapshot you chose to send.</li>
      <li>Audio and snapshots are temporary and deleted after use.</li>
      <li>OpenAI doesn't train on API data and may keep abuse-monitoring logs for up to 30 days.</li>
    </ul>
    <details><summary>More detail</summary><ul>
      <li>Transcripts stay an editable draft until you submit them.</li>
      <li>A sent snapshot includes the whole selected monitor, so check it first. Snapshots clear after use, cancel, ten minutes, or New Session.</li>
      <li>Answers use <code>store:false</code>; no conversation history is kept in the cloud.</li>
      <li>Your API key is encrypted with Windows DPAPI. It protects against other Windows users, not other apps running as the same user.</li>
    </ul></details>
  </section>
}

export function UsageEstimatePanel({ usage }: { usage: UsageEstimateView }): React.JSX.Element {
  return <section className="usage">
    <strong>Local usage estimate</strong>
    <span>${usage.estimatedUsd.toFixed(4)} USD</span>
    <small>{usage.requestCount} recent request{usage.requestCount === 1 ? '' : 's'}{usage.rolledUpRequestCount ? ` · ${usage.rolledUpRequestCount} older rolled up` : ''}</small>
    {usage.unpricedRequestCount > 0 && <small className="field-error">{usage.unpricedRequestCount} request{usage.unpricedRequestCount === 1 ? ' is' : 's are'} unpriced because the exact returned model is unknown.</small>}
    <small>Estimate only, not your OpenAI bill · prices {usage.pricingVersion}</small>
  </section>
}

export function SessionBudgetPanel({ budget, disabled, onNewSession }: { budget: SessionUsageStatus; disabled: boolean; onNewSession(): Promise<void> | void }): React.JSX.Element {
  return <section className="usage session-budget" aria-label="Session USD estimates">
    <div className="budget-heading"><strong>Current PresenterAI session</strong><span>${budget.actualUsd.toFixed(4)} estimated</span></div>
    <div className="info-grid"><PreviewInfo label="Input tokens" value={String(budget.inputTokens)} /><PreviewInfo label="Output tokens" value={String(budget.outputTokens)} /><PreviewInfo label="Reasoning tokens (included in output)" value={String(budget.reasoningTokens)} /></div>
    {budget.unpricedRequests > 0 && <p>{budget.unpricedRequests} request(s): Unpriced. Their cost is not included in this estimate.</p>}
    <small>Since {new Date(budget.startedAt).toLocaleString()} · no spending cap · New Session resets these totals.</small>
    <button type="button" disabled={disabled} onClick={() => void onNewSession()}>New Session</button>
  </section>
}

export interface RetentionActions {
  clearSession(): Promise<void>
  clearUsage(): Promise<void>
  clearCompatibility(): Promise<void>
  clearDocuments(): Promise<void>
  deleteApiKey(): Promise<void>
  deleteAllData(): Promise<{
    ok: boolean
    message?: string
    results?: Array<{ scope: string; ok: boolean; message?: string }>
  } | void>
}

export function RetentionControls({ actions, busy = false, onDeleteAllSuccess }: { actions: RetentionActions; busy?: boolean; onDeleteAllSuccess?(): void }): React.JSX.Element {
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')
  const [scopeResults, setScopeResults] = useState<Array<{ scope: string; ok: boolean; message?: string }>>([])

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(label); setMessage('')
    try { await action(); setMessage(`${label} completed.`) }
    catch (error) { setMessage((error as Error).message || `${label} failed.`) }
    finally { setPending('') }
  }
  const controls: Array<[string, () => Promise<void>]> = [
    ['Clear conversation context', actions.clearSession],
    ['Clear usage estimates', actions.clearUsage],
    ['Clear capture compatibility records', actions.clearCompatibility],
    ['Remove all indexed documents', actions.clearDocuments],
    ['Delete API key', actions.deleteApiKey]
  ]
  const deleteAll = async (): Promise<void> => {
    setPending('Delete all local data'); setMessage(''); setScopeResults([])
    try {
      const result = await actions.deleteAllData()
      if (result?.results) setScopeResults(result.results)
      if (result && !result.ok) {
        setMessage(result.message || 'Some local data could not be deleted.')
        return
      }
      onDeleteAllSuccess?.()
      setMessage('Delete all local data completed.')
      setConfirmingAll(false); setConfirmation('')
    } catch (error) {
      setMessage((error as Error).message || 'Delete all local data failed.')
    } finally {
      setPending('')
    }
  }

  return <fieldset className="retention-controls">
    <legend>Clear local data</legend>
    <p className="muted">Removing documents deletes PresenterAI's copies only, never your original files.</p>
    <div className="retention-actions">{controls.map(([label, action]) => <button type="button" key={label} disabled={busy || Boolean(pending)} onClick={() => void run(label, action)}>{pending === label ? 'Working…' : label}</button>)}</div>
    <button type="button" className="danger-button" disabled={busy || Boolean(pending)} onClick={() => { setConfirmingAll(true); setConfirmation(''); setMessage('') }}>Delete all local PresenterAI data</button>
    {busy && <p className="muted">Finish or cancel the active operation before deleting local data.</p>}
    {confirmingAll && <section role="dialog" aria-label="Confirm deletion of all local data" className="delete-confirmation">
      <strong>This clears all PresenterAI settings, history, usage, the document index, and your API key.</strong>
      <p>Your original files are kept. Type <code>DELETE ALL</code> to continue.</p>
      <input autoFocus aria-label="Delete all confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      <div className="actions"><button type="button" onClick={() => setConfirmingAll(false)}>Cancel</button><button type="button" className="danger-button" disabled={confirmation !== 'DELETE ALL'} onClick={() => void deleteAll()}>Delete all</button></div>
    </section>}
    {message && <p role="status">{message}</p>}
    {scopeResults.length > 0 && <ul aria-label="Local data deletion results">{scopeResults.map((result) => <li key={result.scope} className={result.ok ? '' : 'field-error'}>
      {result.scope}: {result.ok ? 'cleared' : result.message || 'failed'}
    </li>)}</ul>}
  </fieldset>
}

function PreviewInfo({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="info"><small>{label}</small><strong>{value}</strong></div>
}
