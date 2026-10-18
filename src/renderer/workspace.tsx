import React, { useEffect, useRef, useState } from 'react'
import type { WorkspaceStatus } from '../shared/contracts'

export function SetupReturnConfirmation({ workspace, busy, onError }: { workspace: WorkspaceStatus; busy: boolean; onError(message: string): void }): React.JSX.Element | null {
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const visible = workspace.mode === 'presenter' && Boolean(workspace.setupRequest)
  useEffect(() => {
    if (!visible) return
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [visible])
  if (!visible) return null
  return <section ref={dialog} className="setup-return-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="setup-return-title" onKeyDown={(event) => {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); void window.presenter.dismissSetupRequest() }
    if (event.key === 'Tab') {
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons?.[0], last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <strong id="setup-return-title">Leave presenter mode?</strong>
    <p>Setup is a normal desktop window and may appear in recordings or screen sharing. Your draft and answer will be kept.</p>
    {busy && <p>An operation is active. Returning will cancel it and wait for cleanup.</p>}
    <div className="actions"><button ref={cancel} disabled={pending} onClick={() => void window.presenter.dismissSetupRequest()}>Stay in presenter</button>
      <button disabled={pending} className="primary" onClick={async () => {
        setPending(true)
        try { await window.presenter.confirmSetup(busy) } catch (error) { onError((error as Error).message) } finally { setPending(false) }
      }}>{pending ? 'Finishing cleanup…' : busy ? 'Cancel operation & return' : 'Return to Setup'}</button></div>
  </section>
}

/** Measure natural content, never the viewport's own flex-expanded height. */
export function usePresenterSizing(shell: React.RefObject<HTMLElement | null>, content: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !shell.current || !content.current || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous = -1
    const measure = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!shell.current || !content.current) return
        const contentArea = content.current.parentElement!
        const style = getComputedStyle(contentArea)
        const chrome = Array.from(shell.current.children).filter((item) => item !== contentArea && !item.classList.contains('liquid-glass'))
          .reduce((sum, item) => sum + item.getBoundingClientRect().height, 0)
        const preview = document.querySelector('.snapshot-preview')
        const height = Math.ceil(chrome + content.current.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom))
        const confirmation = document.querySelector<HTMLElement>('.click-through-confirmation')
        const requested = Math.max(height, preview ? 620 : 0, confirmation ? confirmation.scrollHeight + 36 : 0)
        if (requested === previous) return
        previous = requested
        void window.presenter.resizePresenter(requested).catch(() => undefined)
      }, 60)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(shell.current); resize.observe(content.current)
    const mutation = new MutationObserver(measure)
    mutation.observe(document.body, { childList: true, subtree: true })
    // The presenter is first laid out while hidden; measure again once shown.
    document.addEventListener('visibilitychange', measure)
    measure()
    return () => { clearTimeout(timer); resize.disconnect(); mutation.disconnect(); document.removeEventListener('visibilitychange', measure) }
  }, [enabled, shell, content])
}
