import React, { useEffect, useRef, useState } from 'react'
import type { AnswerFormat, ClickThroughStatus } from '../shared/contracts'

export interface CopilotQuickControlsProps {
  answerFormat: AnswerFormat
  neonIntensity: number
  clickThrough: ClickThroughStatus
  answerStyleDisabled?: boolean
  onAnswerFormatChange(format: AnswerFormat): void
  onNeonIntensityChange(value: number): void
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
  neonIntensity,
  clickThrough,
  answerStyleDisabled = false,
  onAnswerFormatChange,
  onNeonIntensityChange,
  onSetClickThrough
}: CopilotQuickControlsProps): React.JSX.Element {
  const [confirmingClickThrough, setConfirmingClickThrough] = useState(false)
  const [changingClickThrough, setChangingClickThrough] = useState(false)
  const clickThroughTrigger = useRef<HTMLButtonElement>(null)
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

  return <section className="quick-controls" aria-label="Copilot quick controls">
    <div className="quick-control answer-style-control">
      <span className="quick-control-label">Answer style</span>
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
    </div>

    <label className="quick-control neon-control">
      <span className="quick-control-label">Neon intensity <output>{Math.round(neonIntensity * 100)}%</output></span>
      <input
        aria-label="Neon intensity"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={neonIntensity}
        onChange={(event) => onNeonIntensityChange(Number(event.target.value))}
      />
    </label>

    <div className="quick-control click-through-control">
      <span className="quick-control-label">Interaction</span>
      <button
        ref={clickThroughTrigger}
        type="button"
        className={clickThrough.enabled ? 'click-through-active' : ''}
        disabled={changingClickThrough || (!clickThrough.enabled && !clickThrough.recoveryAvailable)}
        aria-pressed={clickThrough.enabled}
        title={!clickThrough.recoveryAvailable ? 'The emergency recovery shortcut is unavailable, so click-through is disabled.' : undefined}
        onClick={() => {
          if (clickThrough.enabled) void onSetClickThrough(false).catch(() => undefined)
          else setConfirmingClickThrough(true)
        }}
      >
        {clickThrough.enabled ? 'Click-through on' : 'Enable click-through'}
      </button>
      {!clickThrough.recoveryAvailable && <small className="recovery-unavailable">Recovery shortcut unavailable</small>}
    </div>

    {confirmingClickThrough && <div
      className="click-through-confirmation"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="click-through-confirmation-title"
      aria-describedby="click-through-confirmation-description"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeConfirmation()
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
    </div>}
  </section>
}

export function ClickThroughBanner({ status }: { status: ClickThroughStatus }): React.JSX.Element | null {
  if (!status.enabled) return null
  return <div className="click-through-banner" role="status">
    CLICK-THROUGH ON · {recoveryLabel(status.recoveryShortcut)} or Tray → Show PresenterAI to restore
  </div>
}
