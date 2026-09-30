import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
afterEach(async () => { if (userData) await rm(userData, { recursive: true, force: true }); userData = '' })
async function create() {
  userData = await mkdtemp(join(tmpdir(), 'presenter-session-'))
  const { SettingsStore } = await import('../src/main/settings/store')
  const store = new SettingsStore(); await store.initialize(); return { store, SettingsStore, path: join(userData, 'presenterai.json') }
}
describe('uncapped persistent session usage', () => {
  it('defaults new installations to GPT-6 and medium reasoning', async () => {
    const { store } = await create()
    expect(store.settings).toMatchObject({ normalModel: 'gpt-6-luna', strongModel: 'gpt-6.1-sol', normalReasoning: 'medium', strongReasoning: 'medium' })
    expect(store.settings).not.toHaveProperty('sessionBudgetUsd')
  })
  it('preserves exact usage and reasoning counts across restart', async () => {
    const { store, SettingsStore } = await create()
    await store.recordUsage({ endpoint: 'responses', requestedModel: 'gpt-6.1-sol', returnedModel: 'gpt-6.1-sol', inputTokens: 100, outputTokens: 1000, reasoningTokens: 700 })
    const restarted = new SettingsStore(); await restarted.initialize()
    expect(restarted.sessionUsageStatus).toMatchObject({ actualUsd: .0102, inputTokens: 100, outputTokens: 1000, reasoningTokens: 700 })
  })
  it('retires legacy cap and holds without counting them as spending', async () => {
    const { store, SettingsStore, path } = await create()
    const old = JSON.parse(await readFile(path, 'utf8'))
    old.schemaVersion = 5; delete old.settings.normalReasoning; delete old.settings.strongReasoning
    old.settings.normalModel = 'gpt-5.6-luna'; old.settings.strongModel = 'gpt-5.6-terra'; old.settings.sessionBudgetUsd = .01
    old.sessionBudget.actualUsd = .12
    old.sessionBudget.reservations = [{ id: 'hold', endpoint: 'responses', requestedModel: 'gpt-5.6-luna', maximumUsd: .2, reservedAt: new Date().toISOString() }]
    await writeFile(path, JSON.stringify(old))
    const migrated = new SettingsStore(); await migrated.initialize()
    expect(migrated.recoveryWarning).toBeUndefined()
    expect(migrated.settings).toMatchObject({ normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra', normalReasoning: 'medium' })
    expect(migrated.settings).not.toHaveProperty('sessionBudgetUsd')
    expect(migrated.sessionUsageStatus.actualUsd).toBe(.12)
    expect(JSON.parse(await readFile(path, 'utf8')).sessionBudget.reservations).toEqual([])
  })
  it('New Session resets totals while preserving historical usage', async () => {
    const { store } = await create(); await store.recordUsage({ endpoint: 'responses', requestedModel: 'gpt-6-luna', returnedModel: 'gpt-6-luna', inputTokens: 100, outputTokens: 100 })
    const id = store.sessionUsageStatus.sessionId; await store.startNewSession()
    expect(store.sessionUsageStatus).toMatchObject({ actualUsd: 0, inputTokens: 0, outputTokens: 0 })
    expect(store.sessionUsageStatus.sessionId).not.toBe(id); expect(store.usageRecords).toHaveLength(1)
  })
  it('Clear Usage clears records and session totals', async () => {
    const { store } = await create(); await store.recordUsage({ endpoint: 'responses', requestedModel: 'gpt-6-luna', returnedModel: 'unknown', inputTokens: 100, outputTokens: 100 })
    expect(store.sessionUsageStatus.unpricedRequests).toBe(1)
    await store.clearUsage(); expect(store.usageRecords).toHaveLength(0); expect(store.sessionUsageStatus.unpricedRequests).toBe(0)
  })
})
