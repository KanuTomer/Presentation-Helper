import type { AppSettings } from '../../shared/contracts.js'

type ShortcutSet = Pick<AppSettings, 'askShortcut' | 'hideShortcut' | 'listenShortcut'>

export interface ElectronShortcutAdapter {
  readonly shortcutWarnings: readonly string[]
  applyShortcutSet(
    askShortcut: string,
    hideShortcut: string,
    fallback: Pick<ShortcutSet, 'askShortcut' | 'hideShortcut'>
  ): boolean
}

export class ShortcutSettingsTransaction {
  constructor(
    private electron: ElectronShortcutAdapter,
    private configureHelper: (accelerator: string) => Promise<void>
  ) {}

  async apply<T>(input: {
    previous: ShortcutSet
    next: ShortcutSet
    commit(): Promise<T>
    rollbackPersistence(): Promise<unknown>
  }): Promise<T> {
    if (!this.electron.applyShortcutSet(input.next.askShortcut, input.next.hideShortcut, input.previous)) {
      throw new Error(this.electron.shortcutWarnings[0] ?? 'The shortcut set could not be registered.')
    }

    let failure: unknown
    const helperChanged = input.next.listenShortcut !== input.previous.listenShortcut
    try {
      if (helperChanged) await this.configureHelper(input.next.listenShortcut)
      return await input.commit()
    } catch (error) {
      failure = error
    }

    const rollbackActions: Array<Promise<unknown>> = [
      Promise.resolve(this.electron.applyShortcutSet(
        input.previous.askShortcut,
        input.previous.hideShortcut,
        input.previous
      )).then((ok) => { if (!ok) throw new Error('Electron shortcut rollback failed.') }),
      input.rollbackPersistence()
    ]
    if (helperChanged) rollbackActions.push(this.configureHelper(input.previous.listenShortcut))
    const rollback = await Promise.allSettled(rollbackActions)
    if (rollback.some((result) => result.status === 'rejected')) {
      throw new Error(`The shortcut update failed and rollback was incomplete. Restart PresenterAI. ${safeMessage(failure)}`)
    }
    throw failure
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 300) : 'The shortcut update failed.'
}
