import { z } from 'zod'
import type { AppSettings } from '../../shared/contracts.js'

const emergencyShortcut = 'CONTROL+SHIFT+I'
const sensitiveKeys: ReadonlySet<keyof AppSettings> = new Set([
  'modelMode', 'normalModel', 'strongModel', 'transcriptionModel', 'askShortcut', 'hideShortcut',
  'listenShortcut', 'projectSummary', 'approvedVocabulary', 'selectedAudioEndpointId', 'sessionBudgetUsd'
])

const unicodeLength = (value: string): number => Array.from(value).length
const shortcutSchema = z.string().trim().min(1).max(128).superRefine((value, context) => {
  try { canonicalAccelerator(value) }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid shortcut.' })
  }
})
const modelSchema = z.string().trim().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'Model IDs may contain only letters, numbers, dots, underscores, colons, and hyphens.'
)
const projectSummarySchema = z.string().refine(
  (value) => unicodeLength(value) <= 4_000,
  'The project summary is limited to 4,000 characters.'
)
const endpointSchema = z.string().trim().min(1).max(2_048).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Audio endpoint IDs cannot contain control characters.'
)
const vocabularySchema = z.array(z.string()).max(30).transform((value, context) => {
  try { return validateVocabularyTerms(value) }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid approved vocabulary.' })
    return z.NEVER
  }
})

/** Strict persistence and IPC boundary for the renderer-visible settings object. */
export const appSettingsSchema = z.object({
  glassTint: z.number().finite().min(0.18).max(0.78),
  clickThrough: z.boolean(),
  modelMode: z.enum(['normal', 'strong']),
  normalModel: modelSchema,
  strongModel: modelSchema,
  transcriptionModel: modelSchema,
  askShortcut: shortcutSchema,
  hideShortcut: shortcutSchema,
  listenShortcut: shortcutSchema,
  projectSummary: projectSummarySchema,
  approvedVocabulary: vocabularySchema,
  selectedAudioEndpointId: endpointSchema.optional(),
  sessionBudgetUsd: z.number().finite().min(0.01).max(100)
}).strict()

export const appSettingsPatchSchema = appSettingsSchema.partial().strict()

export function parseSettingsPatch(value: unknown): Partial<AppSettings> {
  const parsed = appSettingsPatchSchema.safeParse(value)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid settings update.')
  return parsed.data
}

export function validateSettingsMutation(
  current: AppSettings,
  patch: Partial<AppSettings>,
  operationBusy: boolean
): void {
  patch = parseSettingsPatch(patch)
  if (operationBusy && Object.keys(patch).some((key) => sensitiveKeys.has(key as keyof AppSettings))) {
    throw new Error('Finish or cancel the active PresenterAI operation before changing request, audio, or shortcut settings.')
  }

  const next = { ...current, ...patch }
  const shortcuts = [
    ['Ask', canonicalAccelerator(next.askShortcut)],
    ['Hide/show', canonicalAccelerator(next.hideShortcut)],
    ['Listening toggle', canonicalAccelerator(next.listenShortcut)]
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

export function validateVocabularyTerms(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Approved vocabulary is limited to 30 terms.')
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Approved vocabulary terms must be text.')
    const normalized = item.normalize('NFKC').trim()
    if (!normalized || unicodeLength(normalized) > 64) throw new Error('Each approved vocabulary term must contain 1–64 characters.')
    const key = normalized.toLocaleLowerCase('en-US')
    if (!seen.has(key)) { seen.add(key); result.push(normalized) }
  }
  return result
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
