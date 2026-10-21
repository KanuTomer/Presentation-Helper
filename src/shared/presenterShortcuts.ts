/**
 * Fixed global shortcuts for presenter controls. They are registered only
 * while presenter mode is active, so they never claim keys elsewhere.
 */
export const PRESENTER_SHORTCUTS = [
  { command: 'send', accelerator: 'Control+Alt+Enter', label: 'Send', keys: 'Ctrl+Alt+Enter' },
  { command: 'snapshot', accelerator: 'Control+Alt+S', label: 'Attach or remove snapshot', keys: 'Ctrl+Alt+S' },
  { command: 'format', accelerator: 'Control+Alt+F', label: 'Switch Code / Presenter', keys: 'Ctrl+Alt+F' },
  { command: 'fold', accelerator: 'Control+Alt+A', label: 'Fold or show answer', keys: 'Ctrl+Alt+A' },
  { command: 'copy', accelerator: 'Control+Alt+C', label: 'Copy code (again for the next block)', keys: 'Ctrl+Alt+C' },
  { command: 'retry', accelerator: 'Control+Alt+R', label: 'Retry after an error', keys: 'Ctrl+Alt+R' },
  { command: 'cancel', accelerator: 'Control+Alt+X', label: 'Cancel the current request', keys: 'Ctrl+Alt+X' },
  { command: 'transcript-replace', accelerator: 'Control+Alt+1', label: 'Transcript: replace', keys: 'Ctrl+Alt+1' },
  { command: 'transcript-append', accelerator: 'Control+Alt+2', label: 'Transcript: append', keys: 'Ctrl+Alt+2' },
  { command: 'transcript-discard', accelerator: 'Control+Alt+3', label: 'Transcript: discard', keys: 'Ctrl+Alt+3' }
] as const

export type PresenterCommand = typeof PRESENTER_SHORTCUTS[number]['command']

export function isPresenterCommand(value: unknown): value is PresenterCommand {
  return PRESENTER_SHORTCUTS.some((shortcut) => shortcut.command === value)
}

/** The displayed key for a command, for tooltips. */
export function presenterKeys(command: PresenterCommand): string {
  return PRESENTER_SHORTCUTS.find((shortcut) => shortcut.command === command)!.keys
}
