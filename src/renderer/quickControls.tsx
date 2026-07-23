import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AnswerFormat, ClickThroughStatus } from '../shared/contracts'

export interface CopilotQuickControlsProps {
  answerFormat: AnswerFormat
  clickThrough: ClickThroughStatus
  answerStyleDisabled?: boolean
  children?: React.ReactNode
  onAnswerFormatChange(format: AnswerFormat): void
  onSetClickThrough(enabled: boolean): Promise<void>
}

export function answerFormatAfterSubmission(): AnswerFormat {
  return 'code'
}

function recoveryLabel(shortcut: ClickThroughStatus['recoveryShortcut']): string {
  return shortcut.replace('Control', 'Ctrl')
}

export function CopilotQuickControls({
  answerFormat,
  clickThrough,
  answerStyleDisabled = false,
  children,
  onAnswerFormatChange,
  onSetClickThrough
}: CopilotQuickControlsProps): React.JSX.Element {
  const [confirmingClickThrough, setConfirmingClickThrough] = useState(false)
  const [changingClickThrough, setChangingClickThrough] = useState(false)
  const clickThroughTrigger = useRef<HTMLButtonElement>(null)
  const confirmationDialog = useRef<HTMLDivElement>(null)
  const confirmationCancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmingClickThrough) confirmationCancel.current?.focus()
  }, [confirmingClickThrough])

  const closeConfirmation = (): void => {
    setConfirmingClickThrough(false)
    window.setTimeout(() => clickThroughTrigger.current?.focus(), 0)
  }

  const enableClickThrough = async (): Promise<void> => {
    setChangingClickThrough(true)
    try {
      await onSetClickThrough(true)
      setConfirmingClickThrough(false)
    } catch {
      // The parent surfaces the actionable error. Keep the confirmation open
      // so the user never mistakes a rejected safety transition for success.
    } finally {
      setChangingClickThrough(false)
    }
  }

  return <>
    <section className="quick-controls command-bar" aria-label="Copilot quick controls">
      <div className="answer-format" role="group" aria-label="Answer style">
        <button
          type="button"
          className={answerFormat === 'presenter' ? 'active' : ''}
          aria-pressed={answerFormat === 'presenter'}
          disabled={answerStyleDisabled}
          onClick={() => onAnswerFormatChange('presenter')}
        >
          Presenter
        </button>
        <button
          type="button"
          className={answerFormat === 'code' ? 'active' : ''}
          aria-pressed={answerFormat === 'code'}
          disabled={answerStyleDisabled}
          onClick={() => onAnswerFormatChange('code')}
        >
          &lt;/&gt; Code
        </button>
      </div>
      <button
        ref={clickThroughTrigger}
        type="button"
        className={`click-through-control ${clickThrough.enabled ? 'click-through-active' : ''}`}
        disabled={changingClickThrough || (!clickThrough.enabled && !clickThrough.recoveryAvailable)}
        aria-pressed={clickThrough.enabled}
        title={!clickThrough.recoveryAvailable ? 'The emergency recovery shortcut is unavailable, so click-through is disabled.' : undefined}
        onClick={() => {
          if (clickThrough.enabled) void onSetClickThrough(false).catch(() => undefined)
          else setConfirmingClickThrough(true)
        }}
      >
        {clickThrough.enabled
          ? 'Click-through on'
          : clickThrough.recoveryAvailable
            ? 'Enable click-through'
            : 'Click-through unavailable'}
      </button>
      <span className="command-spacer" aria-hidden="true" />
      {children && <div className="command-actions">{children}</div>}
    </section>

    {confirmingClickThrough && createPortal(
      <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeConfirmation()
      }}>
        <div
          ref={confirmationDialog}
          className="click-through-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="click-through-confirmation-title"
          aria-describedby="click-through-confirmation-description"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closeConfirmation()
              return
            }
            if (event.key === 'Tab') {
              const buttons = Array.from(
                confirmationDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
              )
              const first = buttons[0]
              const last = buttons.at(-1)
              if (!first || !last) {
                event.preventDefault()
                return
              }
              if (event.shiftKey && (document.activeElement === first || !confirmationDialog.current?.contains(document.activeElement))) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && (document.activeElement === last || !confirmationDialog.current?.contains(document.activeElement))) {
                event.preventDefault()
                first.focus()
              }
            }
          }}
        >
          <strong id="click-through-confirmation-title">Enable click-through?</strong>
          <p id="click-through-confirmation-description">PresenterAI will ignore mouse input until you press <kbd>{recoveryLabel(clickThrough.recoveryShortcut)}</kbd> or choose <strong>Tray → Show PresenterAI</strong>.</p>
          <div className="actions">
            <button ref={confirmationCancel} type="button" onClick={closeConfirmation}>Cancel</button>
            <button type="button" className="primary" disabled={changingClickThrough} onClick={() => void enableClickThrough()}>
              {changingClickThrough ? 'Enabling…' : 'Enable click-through'}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}
  </>
}

export function ClickThroughBanner({ status }: { status: ClickThroughStatus }): React.JSX.Element | null {
  if (!status.enabled) return null
  return <div className="click-through-banner" role="status">
    CLICK-THROUGH ON · {recoveryLabel(status.recoveryShortcut)} or Tray → Show PresenterAI to restore
  </div>
}
