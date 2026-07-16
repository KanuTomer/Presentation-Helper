import type { AppSettings } from '../../shared/contracts.js'

const emergencyShortcut = 'CONTROL+SHIFT+I'
const sensitiveKeys: ReadonlySet<keyof AppSettings> = new Set([
  'modelMode', 'normalModel', 'strongModel', 'transcriptionModel', 'askShortcut', 'hideShortcut',
  'listenShortcut', 'projectSummary', 'approvedVocabulary', 'selectedAudioEndpointId'
])

export function validateSettingsMutation(
  current: AppSettings,
  patch: Partial<AppSettings>,
  operationBusy: boolean
): void {
  if (operationBusy && Object.keys(patch).some((key) => sensitiveKeys.has(key as keyof AppSettings))) {
    throw new Error('Finish or cancel the active PresenterAI operation before changing request, audio, or shortcut settings.')
  }

  const next = { ...current, ...patch }
  const shortcuts = [
    ['Ask', canonicalAccelerator(next.askShortcut)],
    ['Hide/show', canonicalAccelerator(next.hideShortcut)],
    ['Hold-to-listen', canonicalAccelerator(next.listenShortcut)]
  ] as const
  for (const [label, accelerator] of shortcuts) {
    if (accelerator === emergencyShortcut) throw new Error(`${label} cannot replace the emergency interaction shortcut.`)
  }
  const seen = new Map<string, string>()
  for (const [label, accelerator] of shortcuts) {
    const conflict = seen.get(accelerator)
    if (conflict) throw new Error(`${label} conflicts with the ${conflict} shortcut.`)
    seen.set(accelerator, label)
  }
}

/** Canonical subset accepted by both Electron and the restricted native hook. */
export function canonicalAccelerator(accelerator: string): string {
  if (typeof accelerator !== 'string' || !accelerator.trim()) throw new Error('A shortcut is required.')
  const raw = accelerator.split('+').map((token) => token.trim().toUpperCase())
  if (raw.some((token) => !token)) throw new Error('Shortcut tokens cannot be empty.')
  const tokens = raw.map((token) => token === 'CTRL' || token === 'COMMANDORCONTROL' ? 'CONTROL' : token)
  if (new Set(tokens).size !== tokens.length) throw new Error('Shortcut tokens cannot be repeated.')
  const modifierOrder = ['CONTROL', 'SHIFT', 'ALT'] as const
  const keys = tokens.filter((token) => !modifierOrder.includes(token as typeof modifierOrder[number]))
  if (keys.length !== 1) throw new Error('A shortcut must contain exactly one trigger key.')
  if (!tokens.some((token) => modifierOrder.includes(token as typeof modifierOrder[number]))) {
    throw new Error('A global shortcut must contain at least one modifier; bare Escape is reserved for active-operation cancellation.')
  }
  const key = keys[0]!
  if (!(key === 'SPACE' || /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))) {
    throw new Error('Shortcut key must be Space, A-Z, 0-9, or F1-F24.')
  }
  return [...modifierOrder.filter((modifier) => tokens.includes(modifier)), key].join('+')
}
