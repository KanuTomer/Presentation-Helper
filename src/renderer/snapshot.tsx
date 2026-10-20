import React from 'react'
import './snapshot.css'

/**
 * Attaches a snapshot of the presenter's current screen to the next message.
 * The image is captured in the main process and never shown here: the person
 * already knows what is on their screen.
 */
export function SnapshotButton({ attached, pending, disabled, onToggle }: { attached: boolean; pending: boolean; disabled: boolean; onToggle(): void }): React.JSX.Element {
  return <button type="button" className={`snapshot-button ${attached ? 'attached' : ''}`} aria-pressed={attached} disabled={disabled || pending} onClick={onToggle}
    title={`${attached ? 'Remove the attached screenshot' : 'Attach a screenshot of this screen to your message'} (Ctrl+Alt+S)`}>
    {pending ? 'Capturing…' : attached ? 'Snapshot ✓' : 'Snapshot'}
  </button>
}

export function ScreenshotChip({ onRemove, disabled }: { onRemove(): void; disabled: boolean }): React.JSX.Element {
  return <span className="attachment-chip" role="status">
    <span aria-hidden="true">▣</span> Screenshot attached
    <button type="button" aria-label="Remove screenshot" disabled={disabled} onClick={onRemove}>×</button>
  </span>
}
