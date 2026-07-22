import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

afterEach(async () => {
  if (userData) await rm(userData, { recursive: true, force: true })
  userData = ''
})

describe('persistent PresenterAI session budget', () => {
  it('persists a reservation before dispatch and restores its hold after restart', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-budget-restart-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({
      idGenerator: () => `id-${++id}`,
      clock: () => new Date('2026-07-22T10:00:00.000Z')
    })
    await store.initialize()

    expect(store.sessionBudget).toEqual({
      sessionId: 'id-1', startedAt: '2026-07-22T10:00:00.000Z', capUsd: 0.25,
      actualUsd: 0, heldUsd: 0, remainingUsd: 0.25,
      pricingVersion: expect.any(String), blocked: false
    })
    const reservation = await store.reserveSessionBudget('responses', 'gpt-5.6-luna', 0.08)
    expect(reservation).toMatchObject({ id: 'id-2', maximumUsd: 0.08 })
    expect(store.sessionBudget).toMatchObject({ heldUsd: 0.08, remainingUsd: 0.17 })

    const reopened = new SettingsStore({ idGenerator: () => 'unused-on-reopen' })
    await reopened.initialize()
    expect(reopened.sessionBudget).toMatchObject({ sessionId: 'id-1', heldUsd: 0.08, remainingUsd: 0.17 })
    const persisted = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
    expect(persisted.sessionBudget.reservations).toEqual([expect.objectContaining({ id: 'id-2', maximumUsd: 0.08 })])
  })

  it('settles exact priced usage and clear usage does not reset the session ledger', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-budget-settle-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({ idGenerator: () => `id-${++id}` })
    await store.initialize()
    const reservation = await store.reserveSessionBudget('transcription', 'gpt-4o-mini-transcribe', 0.03)
    await store.settleSessionBudget(reservation.id, 0.00175)
    expect(store.sessionBudget).toMatchObject({ actualUsd: 0.00175, heldUsd: 0, remainingUsd: 0.24825 })

    await store.recordUsage({
      endpoint: 'transcription', requestedModel: 'gpt-4o-mini-transcribe', returnedModel: 'gpt-4o-mini-transcribe',
      inputTokens: 1_000, outputTokens: 100, audioTokens: 900
    })
    await store.clearUsage()
    expect(store.usage.estimatedUsd).toBe(0)
    expect(store.sessionBudget).toMatchObject({ actualUsd: 0.00175, heldUsd: 0, remainingUsd: 0.24825 })
    await store.updateSettings({ sessionBudgetUsd: 1 })
    await store.resetSettings()
    expect(store.sessionBudget).toMatchObject({ capUsd: 0.25, actualUsd: 0.00175, heldUsd: 0, remainingUsd: 0.24825 })
  })

  it('retains the full hold for missing or unpriced usage', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-budget-retain-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({ idGenerator: () => `id-${++id}` })
    await store.initialize()
    const reservation = await store.reserveSessionBudget('responses', 'gpt-5.6-luna', 0.1)
    expect(await store.settleSessionBudget(reservation.id, 0, true))
      .toMatchObject({ actualUsd: 0, heldUsd: 0.1, remainingUsd: 0.15 })

    const reopened = new SettingsStore({ idGenerator: () => 'unused-on-reopen' })
    await reopened.initialize()
    expect(reopened.sessionBudget).toMatchObject({ actualUsd: 0, heldUsd: 0.1, remainingUsd: 0.15 })
  })

  it('enforces cap changes and releases only known-undispatched reservations', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-budget-cap-'))
    const { SessionBudgetExceededError, SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({ idGenerator: () => `id-${++id}` })
    await store.initialize()
    const reservation = await store.reserveSessionBudget('responses', 'gpt-5.6-luna', 0.2)
    await store.updateSettings({ sessionBudgetUsd: 0.1 })
    expect(store.sessionBudget).toMatchObject({ capUsd: 0.1, heldUsd: 0.2, remainingUsd: 0, blocked: true })
    await expect(store.reserveSessionBudget('responses', 'gpt-5.6-luna', 0.01))
      .rejects.toBeInstanceOf(SessionBudgetExceededError)

    await store.updateSettings({ sessionBudgetUsd: 0.3 })
    await store.releaseSessionBudget(reservation.id)
    expect(store.sessionBudget).toMatchObject({ capUsd: 0.3, actualUsd: 0, heldUsd: 0, remainingUsd: 0.3 })
  })

  it('starts a fresh ledger only through New Session and refuses under-reserved settlement', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-budget-new-session-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({
      idGenerator: () => `id-${++id}`,
      clock: () => new Date(`2026-07-22T10:00:0${Math.min(id, 9)}.000Z`)
    })
    await store.initialize()
    const reservation = await store.reserveSessionBudget('responses', 'gpt-5.6-luna', 0.05)
    await expect(store.settleSessionBudget(reservation.id, 0.06)).rejects.toThrow(/hold was retained/i)
    expect(store.sessionBudget.heldUsd).toBe(0.05)

    const previousSession = store.sessionBudget.sessionId
    const next = await store.startNewSession()
    expect(next).toMatchObject({ actualUsd: 0, heldUsd: 0, remainingUsd: 0.25 })
    expect(next.sessionId).not.toBe(previousSession)
    await expect(store.releaseSessionBudget(reservation.id)).rejects.toThrow(/no longer active/i)
  })
})
