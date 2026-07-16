// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { LocalDataDeletionService, type LocalDataDeletionActions } from '../src/main/settings/dataDeletion'
import { OperationCoordinator, operationError } from '../src/main/operations/coordinator'

function actions(): LocalDataDeletionActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    session: vi.fn(), documents: vi.fn(), usage: vi.fn(), compatibility: vi.fn(), consent: vi.fn(),
    apiKey: vi.fn(), temporaryAudio: vi.fn(), settings: vi.fn()
  }
}

describe('delete-all local data coordination', () => {
  it('requires the exact confirmation and an idle coordinator before touching any scope', async () => {
    const blockedActions = actions()
    const blocked = new LocalDataDeletionService(() => { throw operationError('busy', 'Busy.', false) }, blockedActions)
    await expect(blocked.deleteAll('DELETE ALL')).rejects.toMatchObject({ code: 'busy' })
    expect(Object.values(blockedActions).every((action) => action.mock.calls.length === 0)).toBe(true)

    const unconfirmedActions = actions()
    const unconfirmed = new LocalDataDeletionService(() => vi.fn(), unconfirmedActions)
    await expect(unconfirmed.deleteAll('delete all')).rejects.toThrow(/DELETE ALL exactly/)
    expect(Object.values(unconfirmedActions).every((action) => action.mock.calls.length === 0)).toBe(true)
  })

  it('clears every owned scope once and reports a complete result', async () => {
    const clearing = actions()
    const release = vi.fn()
    const service = new LocalDataDeletionService(() => release, clearing)
    const result = await service.deleteAll('DELETE ALL')
    expect(result.ok).toBe(true)
    expect(result.results.map((item) => item.scope)).toEqual([
      'session', 'documents', 'usage', 'compatibility', 'consent', 'api-key', 'temporary-audio', 'settings'
    ])
    expect(Object.values(clearing).every((action) => action.mock.calls.length === 1)).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('continues independent cleanup after a failure and returns redacted per-scope outcomes', async () => {
    const clearing = actions()
    clearing.documents.mockRejectedValue(new Error('SQLite index remained locked.'))
    clearing.apiKey.mockRejectedValue('opaque failure')
    const result = await new LocalDataDeletionService(() => vi.fn(), clearing).deleteAll('DELETE ALL')
    expect(result).toMatchObject({ ok: false, message: '2 local-data scope(s) could not be cleared.' })
    expect(result.results.find((item) => item.scope === 'documents')).toMatchObject({ ok: false, message: 'SQLite index remained locked.' })
    expect(result.results.find((item) => item.scope === 'api-key')).toMatchObject({ ok: false, message: 'This local-data scope could not be cleared.' })
    expect(clearing.settings).toHaveBeenCalledOnce()
  })

  it('holds the application-wide maintenance reservation across awaited scopes', async () => {
    let releaseDocuments!: () => void
    const documentsPending = new Promise<void>((resolve) => { releaseDocuments = resolve })
    const clearing = actions()
    clearing.documents.mockImplementation(() => documentsPending)
    const coordinator = new OperationCoordinator({ register: vi.fn(() => true), unregister: vi.fn() })
    const pending = new LocalDataDeletionService(
      () => coordinator.acquireMaintenance(),
      clearing
    ).deleteAll('DELETE ALL')

    await vi.waitFor(() => expect(clearing.documents).toHaveBeenCalledOnce())
    expect(() => coordinator.begin('typed', 'retrieving')).toThrow(/active/i)
    releaseDocuments()
    await expect(pending).resolves.toMatchObject({ ok: true })
    const operation = coordinator.begin('typed', 'retrieving')
    await coordinator.finish(operation.id, 'success')
  })
})
