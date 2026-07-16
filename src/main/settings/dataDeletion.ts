import type {
  DeleteAllLocalDataResult, LocalDataScope, LocalDataScopeResult
} from '../../shared/contracts.js'

export interface LocalDataDeletionActions {
  session(): void | Promise<void>
  documents(): void | Promise<void>
  usage(): void | Promise<void>
  compatibility(): void | Promise<void>
  consent(): void | Promise<void>
  apiKey(): void | Promise<void>
  temporaryAudio(): void | Promise<void>
  settings(): void | Promise<void>
}

const orderedScopes: ReadonlyArray<{
  scope: LocalDataScope
  action: keyof LocalDataDeletionActions
}> = [
  { scope: 'session', action: 'session' },
  { scope: 'documents', action: 'documents' },
  { scope: 'usage', action: 'usage' },
  { scope: 'compatibility', action: 'compatibility' },
  { scope: 'consent', action: 'consent' },
  { scope: 'api-key', action: 'apiKey' },
  { scope: 'temporary-audio', action: 'temporaryAudio' },
  { scope: 'settings', action: 'settings' }
]

export class LocalDataDeletionService {
  constructor(
    private acquireExclusive: () => () => void,
    private actions: LocalDataDeletionActions
  ) {}

  async deleteAll(confirmation: unknown): Promise<DeleteAllLocalDataResult> {
    if (confirmation !== 'DELETE ALL') throw new Error('Type DELETE ALL exactly to confirm local data deletion.')
    const release = this.acquireExclusive()
    const results: LocalDataScopeResult[] = []
    try {
      for (const { scope, action } of orderedScopes) {
        try {
          await this.actions[action]()
          results.push({ scope, ok: true })
        } catch (error) {
          results.push({
            scope,
            ok: false,
            message: error instanceof Error && error.message
              ? error.message.slice(0, 400)
              : 'This local-data scope could not be cleared.'
          })
        }
      }
    } finally {
      release()
    }
    const failed = results.filter((result) => !result.ok)
    return {
      ok: failed.length === 0,
      ...(failed.length ? { message: `${failed.length} local-data scope(s) could not be cleared.` } : {}),
      results
    }
  }
}
