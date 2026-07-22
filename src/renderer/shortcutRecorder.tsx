import React, { useEffect, useState } from 'react'

export interface ShortcutSettings {
  askShortcut: string
  hideShortcut: string
  listenShortcut: string
}

export const DEFAULT_SHORTCUTS: Readonly<ShortcutSettings> = Object.freeze({
  askShortcut: 'Control+Space',
  hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space'
})

export type ShortcutSettingsPatch = Partial<ShortcutSettings>

interface ShortcutRecorderProps {
  label: string
  value: string
  disabled?: boolean
  onCommit(value: string): Promise<void> | void
}

/**
 * Records only the accelerator subset shared by Electron and the restricted
 * Windows helper. Main-process validation remains authoritative.
 */
export function ShortcutRecorder({ label, value, disabled = false, onCommit }: ShortcutRecorderProps): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    setRecording(false)
    setMessage('')
  }, [value])

  const commit = async (accelerator: string): Promise<void> => {
    setRecording(false)
    setPending(true)
    setMessage('')
    try {
      await onCommit(accelerator)
    } catch (error) {
      setMessage((error as Error).message || 'This shortcut could not be registered.')
    } finally {
      setPending(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording || event.repeat) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setMessage('Shortcut recording cancelled.')
      return
    }
    try {
      const accelerator = acceleratorFromKeyboardEvent(event)
      if (!accelerator) {
        setMessage('Keep at least one modifier held, then press Space, A–Z, 0–9, or F1–F24.')
        return
      }
      if (accelerator === 'Control+Shift+I') {
        setMessage('Ctrl+Shift+I is reserved for emergency interaction recovery.')
        return
      }
      void commit(accelerator)
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  return <div className="shortcut-setting shortcut-recorder">
    <div>
      <span className="shortcut-label">{label}</span>
      <kbd aria-label={`${label} shortcut`}>{recording ? 'Press shortcut…' : value}</kbd>
      {message && <small className="field-error" role="status">{message}</small>}
    </div>
    <button
      type="button"
      aria-label={recording ? `Cancel recording ${label} shortcut` : `Record ${label} shortcut`}
      aria-pressed={recording}
      disabled={disabled || pending}
      onClick={() => { setRecording((current) => !current); setMessage('') }}
      onKeyDown={onKeyDown}
    >{pending ? 'Applying…' : recording ? 'Cancel' : 'Record'}</button>
  </div>
}

export function ShortcutSettingsPanel({
  askShortcut,
  hideShortcut,
  listenShortcut,
  disabled = false,
  onChange
}: ShortcutSettings & {
  disabled?: boolean
  onChange(patch: ShortcutSettingsPatch): Promise<void> | void
}): React.JSX.Element {
  const restoreDisabled = askShortcut === DEFAULT_SHORTCUTS.askShortcut &&
    hideShortcut === DEFAULT_SHORTCUTS.hideShortcut && listenShortcut === DEFAULT_SHORTCUTS.listenShortcut

  return <fieldset className="shortcut-panel">
    <legend>Shortcuts</legend>
    <ShortcutRecorder label="Ask" value={askShortcut} disabled={disabled} onCommit={(value) => onChange({ askShortcut: value })} />
    <ShortcutRecorder label="Hide/show" value={hideShortcut} disabled={disabled} onCommit={(value) => onChange({ hideShortcut: value })} />
    <ShortcutRecorder label="Toggle system-audio listening" value={listenShortcut} disabled={disabled} onCommit={(value) => onChange({ listenShortcut: value })} />
    <div className="actions">
      <button type="button" disabled={disabled || restoreDisabled} onClick={() => void onChange({ ...DEFAULT_SHORTCUTS })}>Restore defaults</button>
    </div>
    <p className="muted">Ctrl+Shift+I always restores interaction if click-through is enabled.</p>
  </fieldset>
}

export function acceleratorFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'>): string | undefined {
  const key = triggerKey(event.key)
  if (!key) return undefined
  const modifiers = [event.ctrlKey && 'Control', event.shiftKey && 'Shift', event.altKey && 'Alt'].filter(Boolean) as string[]
  if (modifiers.length === 0) throw new Error('A global shortcut needs at least one modifier.')
  return [...modifiers, key].join('+')
}

function triggerKey(key: string): string | undefined {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return undefined
  if (key === ' ' || key === 'Spacebar' || key.toUpperCase() === 'SPACE') return 'Space'
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase()
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  throw new Error('Use Space, A–Z, 0–9, or F1–F24 as the trigger key.')
}
