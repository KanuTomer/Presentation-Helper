import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AiErrorInfo, AssistantResponse, SnapshotMonitor, SnapshotPreview } from '../shared/contracts'
import './snapshot.css'

export function SnapshotButton({ disabled, canSend = false, onOpenSettings, sessionId, onResponse, onError }: { disabled: boolean; canSend?: boolean; onOpenSettings?(): void; sessionId: string; onResponse(response: AssistantResponse): void; onError(error: AiErrorInfo): void }): React.JSX.Element {
  const [monitors, setMonitors] = useState<SnapshotMonitor[]>([])
  const [monitorId, setMonitorId] = useState<string>()
  const [frame, setFrame] = useState<SnapshotPreview>()
  const [pending, setPending] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const sendButton = useRef<HTMLButtonElement>(null)
  const captureButton = useRef<HTMLButtonElement>(null)
  const revision = useRef(0)
  useEffect(() => {
    let active = true
    revision.current++
    setFrame(undefined)
    setPending(false)
    void window.presenter.listSnapshotMonitors?.().then((items) => { if (active) { setMonitors(items); setMonitorId(items.find((item) => item.current)?.id) } }).catch(() => undefined)
    return () => { active = false; revision.current++; void window.presenter.discardSnapshot?.() }
  }, [sessionId])
  useEffect(() => {
    if (!frame) return
    dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const timer = setTimeout(() => { setFrame(undefined); void window.presenter.discardSnapshot() }, Math.max(0, Date.parse(frame.expiresAt) - Date.now()))
    return () => { clearTimeout(timer); captureButton.current?.focus() }
  }, [frame])
  async function capture(): Promise<void> {
    if (disabled || pending) return
    const current = ++revision.current
    setPending(true); setFrame(undefined)
    try { const result = await window.presenter.captureSnapshot(monitorId); if (revision.current === current) setFrame(result) }
    catch { if (revision.current === current) onError({ code: 'unknown', message: 'Snapshot capture failed. Check the selected monitor and try again.', retryable: false }) }
    finally { if (revision.current === current) setPending(false) }
  }
  async function send(): Promise<void> {
    if (!frame || pending || !canSend || disabled) return
    const current = ++revision.current
    setPending(true)
    const id = frame.id
    // Remove the renderer image before request dispatch; the main process owns it.
    setFrame(undefined)
    try { const result = await window.presenter.solveSnapshot(id); if (revision.current === current) { if (result.ok) onResponse(result.response); else onError(result.error) } }
    catch { if (revision.current === current) onError({ code: 'unknown', message: 'The screenshot could not be sent. Take another snapshot to retry.', retryable: false }) }
    finally { if (revision.current === current) { setPending(false); void window.presenter.discardSnapshot() } }
  }
  return <>
    {monitors.length > 1 && <select aria-label="Snapshot monitor" disabled={disabled || pending} value={monitorId} onChange={(event) => setMonitorId(event.target.value)}>{monitors.map((monitor) => <option value={monitor.id} key={monitor.id}>{monitor.name}</option>)}</select>}
    <button ref={captureButton} type="button" disabled={disabled || pending} onClick={() => void capture()} title="Preview the current screen, then send it to solve the visible problem">{pending ? 'Snapshot…' : 'Snapshot'}</button>
    {frame && createPortal(<div className="snapshot-backdrop"><section ref={dialog} className="snapshot-preview" role="dialog" aria-modal="true" aria-label="Snapshot preview" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); setFrame(undefined); void window.presenter.discardSnapshot() }
      if (event.key === 'Tab') {
        const controls = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = controls?.[0], last = controls?.[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <h2>Review screen snapshot</h2><p>This full monitor image will be sent to the selected OpenAI model only when you press Send. It may contain private information.</p>
      <img src={frame.dataUrl} alt="Captured monitor preview" />
      {!canSend && <div className="notice warning">Preview is available offline. Add an API key in Settings before sending. <button onClick={() => { setFrame(undefined); void window.presenter.discardSnapshot(); onOpenSettings?.() }}>Open Settings</button></div>}
      <div className="snapshot-actions"><button ref={sendButton} disabled={!canSend || disabled || pending} className="primary" onClick={() => void send()}>Send</button><button disabled={disabled || pending} onClick={() => void capture()}>Retake</button><button onClick={() => { setFrame(undefined); void window.presenter.discardSnapshot() }}>Discard</button></div>
    </section></div>, document.body)}
  </>
}
