import React, { useEffect, useRef, useState } from 'react'

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
  inrPerUsd?: number
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
    <legend>First-use listening acknowledgement</legend>
    <p>PresenterAI captures bounded system-output audio only after you explicitly toggle listening on. Press the listening control again to stop and answer. Listening starts OFF on every launch.</p>
    <p>Live assistance may be restricted in interviews, examinations, meetings, or graded work. Confirm the applicable rules and obtain consent where required.</p>
    <label className="toggle"><input type="checkbox" checked disabled /> The red listening indicator will remain visible during capture.</label>
    <button type="button" className="primary" disabled={disabled || pending} onClick={() => void accept()}>{pending ? 'Saving…' : 'I understand and enable toggle listening'}</button>
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

  return <section className="transmission-preview" aria-live="polite" aria-label="OpenAI transmission preview">
    <h3>{preview.stage === 'transcription' ? 'Audio about to be sent' : 'Answer context about to be sent'}</h3>
    {preview.audio && <div className="info-grid">
      <PreviewInfo label="Duration" value={`${(preview.audio.durationMs / 1_000).toFixed(1)} seconds`} />
      <PreviewInfo label="Size" value={`${Math.ceil(preview.audio.bytes / 1_024)} KiB`} />
      <PreviewInfo label="Captured endpoint" value={preview.audio.endpointName} />
    </div>}
    {preview.terminologyHint && <details><summary>Transcription terminology hint</summary><p>{preview.terminologyHint}</p></details>}
    <p>{preview.rollingTurnCount} recent conversation turn{preview.rollingTurnCount === 1 ? '' : 's'} included · project summary {preview.includesProjectSummary ? 'included' : 'not included'}.</p>
    {preview.chunks.length > 0 ? <div className="preview-chunks">
      <strong>{preview.chunks.length} selected local evidence chunk{preview.chunks.length === 1 ? '' : 's'}</strong>
      {preview.chunks.map((chunk) => <details key={chunk.chunkId}>
        <summary>{chunk.documentName} · {chunk.title ? `${chunk.title} · ` : ''}{chunk.location}</summary>
        <p>{chunk.text}</p>
      </details>)}
    </div> : <p className="muted">No document evidence chunk is included.</p>}
    {onCancel && <button type="button" onClick={() => void onCancel()}>Cancel transmission</button>}
  </section>
}

export function PrivacyDisclosure(): React.JSX.Element {
  return <section className="privacy-disclosure">
    <h3>Data handling</h3>
    <ul>
      <li>Bounded audio is sent only for transcription and is deleted locally when that request reaches a terminal state.</li>
      <li>Only the current question, bounded background, and selected local evidence chunks are sent for an answer.</li>
      <li>Responses use <code>store:false</code>; PresenterAI creates no OpenAI Conversation and keeps no cloud meeting history.</li>
      <li>OpenAI may retain Responses API abuse-monitoring logs for up to 30 days under its ordinary API controls. The published transcription endpoint table currently lists no application-state or abuse-monitoring retention.</li>
      <li>API content is not used to train OpenAI models unless the account owner explicitly opts in.</li>
    </ul>
    <p>API keys are encrypted for this Windows user with DPAPI. That primarily protects against other Windows users; it cannot isolate the key from every process already running as the same user.</p>
  </section>
}

export function UsageEstimatePanel({ usage }: { usage: UsageEstimateView }): React.JSX.Element {
  const inr = usage.inrPerUsd === undefined ? undefined : usage.estimatedUsd * usage.inrPerUsd
  return <section className="usage">
    <strong>Local usage estimate</strong>
    <span>${usage.estimatedUsd.toFixed(4)} USD</span>
    {inr !== undefined && <span>≈ ₹{inr.toFixed(2)} INR</span>}
    <small>{usage.requestCount} recent request{usage.requestCount === 1 ? '' : 's'}{usage.rolledUpRequestCount ? ` · ${usage.rolledUpRequestCount} older rolled up` : ''}</small>
    {usage.unpricedRequestCount > 0 && <small className="field-error">{usage.unpricedRequestCount} request{usage.unpricedRequestCount === 1 ? ' is' : 's are'} unpriced because the exact returned model is unknown.</small>}
    <small>Pricing metadata: {usage.pricingVersion}. Estimates are not billing reconciliation; INR uses your manually configured exchange rate.</small>
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

export function RetentionControls({ actions, busy = false }: { actions: RetentionActions; busy?: boolean }): React.JSX.Element {
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
      setMessage('Delete all local data completed.')
      setConfirmingAll(false); setConfirmation('')
    } catch (error) {
      setMessage((error as Error).message || 'Delete all local data failed.')
    } finally {
      setPending('')
    }
  }

  return <fieldset className="retention-controls">
    <legend>Local retention controls</legend>
    <p className="muted">Removing indexed documents deletes PresenterAI’s local copies and index rows, never your original PPTX, PDF, Markdown, or text files.</p>
    <div className="retention-actions">{controls.map(([label, action]) => <button type="button" key={label} disabled={busy || Boolean(pending)} onClick={() => void run(label, action)}>{pending === label ? 'Working…' : label}</button>)}</div>
    <button type="button" className="danger-button" disabled={busy || Boolean(pending)} onClick={() => { setConfirmingAll(true); setConfirmation(''); setMessage('') }}>Delete all local PresenterAI data</button>
    {busy && <p className="muted">Finish or cancel the active operation before deleting local data.</p>}
    {confirmingAll && <section role="dialog" aria-label="Confirm deletion of all local data" className="delete-confirmation">
      <strong>This clears settings, consent, context, usage, compatibility records, the local index, encrypted API-key ciphertext, and PresenterAI-owned temporary audio.</strong>
      <p>Your original source documents are not deleted. Type <code>DELETE ALL</code> to continue.</p>
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
