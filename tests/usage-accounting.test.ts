import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

afterEach(async () => {
  if (userData) await rm(userData, { recursive: true, force: true })
  userData = ''
})

describe('audio usage accounting', () => {
  it('records capture duration once while pricing returned token usage', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-usage-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    const store = new SettingsStore()
    await store.initialize()
    await store.addUsage(0, 0, 0.5)
    await store.addTranscriptionUsage({
      type: 'tokens', inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100,
      audioTokens: 900, textTokens: 100
    }, 'gpt-4o-mini-transcribe')
    expect(store.usage).toMatchObject({
      audioMinutes: 0.5,
      transcriptionInputTokens: 1_000,
      transcriptionAudioTokens: 900,
      transcriptionOutputTokens: 100,
      estimatedUsd: 0.00175
    })

    await store.addTranscriptionUsage({
      type: 'duration', inputTokens: 0, outputTokens: 0, totalTokens: 0,
      audioTokens: 0, textTokens: 0, durationSeconds: 30
    }, 'gpt-4o-mini-transcribe')
    expect(store.usage.audioMinutes).toBe(0.5)
    expect(store.usageRecords.at(-1)).toMatchObject({ endpoint: 'transcription', priced: false, estimatedUsd: 0 })
    const recordCount = store.usageRecords.length
    await store.addTranscriptionUsage({
      type: 'none', inputTokens: 0, outputTokens: 0, totalTokens: 0, audioTokens: 0, textTokens: 0
    }, 'gpt-4o-mini-transcribe')
    expect(store.usageRecords).toHaveLength(recordCount)
  })

  it('serializes concurrent bounds, settings, and usage writes without losing the newest snapshot', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-usage-concurrent-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    const store = new SettingsStore()
    await store.initialize()

    const writes: Promise<unknown>[] = []
    for (let index = 1; index <= 20; index++) {
      writes.push(store.setWindowBounds({ x: index, y: index, width: 560, height: 720 }))
      writes.push(store.addUsage(index, index * 2, 0.01))
    }
    writes.push(store.updateSettings({ opacity: 0.77 }))
    await Promise.all(writes)

    const saved = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
    expect(saved.windowBounds).toEqual({ x: 20, y: 20, width: 560, height: 720 })
    expect(saved.windowLayoutRevision).toBe(1)
    expect(saved.settings.opacity).toBe(0.77)
    expect(saved.usage.inputTokens).toBe(210)
    expect(saved.usage.outputTokens).toBe(420)
    expect(saved.usage.audioMinutes).toBeCloseTo(0.2)
  })

  it('records exact-model request provenance, subset tokens, and unknown models without guessing a price', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-usage-records-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({
      idGenerator: () => `usage-${++id}`,
      clock: () => new Date('2026-07-16T12:00:00.000Z')
    })
    await store.initialize()

    const priced = await store.recordUsage({
      endpoint: 'responses', requestedModel: 'gpt-5.6-luna', returnedModel: 'gpt-5.6-luna',
      inputTokens: 1_000, outputTokens: 500, reasoningTokens: 200
    })
    const unknown = await store.recordUsage({
      endpoint: 'responses', requestedModel: 'gpt-5.6-luna', returnedModel: 'gpt-5.6-luna-future',
      inputTokens: 100, outputTokens: 50, reasoningTokens: 10
    })
    const transcription = await store.recordUsage({
      endpoint: 'transcription', requestedModel: 'gpt-4o-mini-transcribe',
      inputTokens: 1_000, outputTokens: 100, audioTokens: 900, durationMs: 30_000
    })

    expect(priced).toMatchObject({ priced: true, estimatedUsd: 0.004, reasoningTokens: 200 })
    expect(unknown).toMatchObject({ priced: false, estimatedUsd: 0 })
    expect(transcription).toMatchObject({ priced: true, estimatedUsd: 0.00175, audioTokens: 900 })
    expect(store.usage).toMatchObject({
      inputTokens: 1_100, outputTokens: 550, audioMinutes: 0.5,
      transcriptionInputTokens: 1_000, transcriptionAudioTokens: 900, transcriptionOutputTokens: 100,
      estimatedUsd: 0.00575
    })
    expect(store.usageLedger.recent).toHaveLength(3)
    expect(store.usageLedger.recent[0]).not.toHaveProperty('prompt')
    expect(store.usageLedger.recent[0]).not.toHaveProperty('response')
  })

  it('keeps 100 recent request records and rolls older records up by exact endpoint/model', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-usage-rollup-'))
    const { SettingsStore } = await import('../src/main/settings/store')
    let id = 0
    const store = new SettingsStore({ idGenerator: () => `usage-${++id}` })
    await store.initialize()
    for (let index = 0; index < 101; index++) {
      await store.recordUsage({
        endpoint: 'responses', requestedModel: 'gpt-5.6-luna', inputTokens: 1, outputTokens: 2, reasoningTokens: 1
      })
    }
    expect(store.usageRecords).toHaveLength(100)
    expect(store.usageRollups).toEqual([expect.objectContaining({
      endpoint: 'responses', model: 'gpt-5.6-luna', requestCount: 1,
      inputTokens: 1, outputTokens: 2, reasoningTokens: 1, unpricedRequestCount: 0
    })])
  })

  it('migrates legacy data, persists consent, and exposes independent clearing primitives', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-settings-migrate-'))
    await writeFile(join(userData, 'presenterai.json'), JSON.stringify({
      settings: {
        opacity: 0.8, clickThrough: true, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
        strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
        askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
        projectSummary: 'legacy project', approvedVocabulary: ['WASAPI'], inrPerUsd: 84
      },
      windowBounds: { x: 10, y: 20, width: 560, height: 720 }, documents: [], captureResults: [],
      usage: {
        inputTokens: 10, outputTokens: 20, audioMinutes: 0.25,
        transcriptionInputTokens: 30, transcriptionAudioTokens: 25, transcriptionOutputTokens: 5,
        estimatedUsd: 0.01, pricingVersion: 'legacy'
      }
    }), 'utf8')
    const { LISTENING_CONSENT_VERSION, SettingsStore } = await import('../src/main/settings/store')
    const store = new SettingsStore({ clock: () => new Date('2026-07-16T13:00:00.000Z') })
    await store.initialize()

    expect(store.settings).toMatchObject({ opacity: 0.8, projectSummary: 'legacy project', inrPerUsd: 84 })
    expect(store.recoveryWarning).toBeUndefined()
    expect(store.usageRollups).toEqual([expect.objectContaining({ endpoint: 'legacy', model: 'legacy-unattributed' })])
    await store.acceptListeningConsent(LISTENING_CONSENT_VERSION)
    expect(store.privacyConsent).toEqual({
      requiredVersion: LISTENING_CONSENT_VERSION, acceptedVersion: LISTENING_CONSENT_VERSION,
      acceptedAt: '2026-07-16T13:00:00.000Z', satisfied: true
    })
    const consentFile = join(userData, 'presenterai.json')
    const withOldConsent = JSON.parse(await readFile(consentFile, 'utf8'))
    withOldConsent.privacyConsent.acceptedVersion = LISTENING_CONSENT_VERSION - 1
    await writeFile(consentFile, JSON.stringify(withOldConsent), 'utf8')
    const reopened = new SettingsStore({ clock: () => new Date('2026-07-16T13:05:00.000Z') })
    await reopened.initialize()
    expect(reopened.privacyConsent).toMatchObject({
      requiredVersion: LISTENING_CONSENT_VERSION,
      acceptedVersion: LISTENING_CONSENT_VERSION - 1,
      satisfied: false
    })

    await store.clearUsage()
    await store.clearCaptureResults()
    await store.clearWindowBounds()
    expect(store.usageRecords).toEqual([])
    expect(store.usageRollups).toEqual([])
    expect(store.usage.estimatedUsd).toBe(0)
    expect(store.windowBounds).toBeUndefined()
    await store.clearSettingsData()
    expect(store.settings.projectSummary).toBe('')
    expect(store.privacyConsent.satisfied).toBe(false)
    expect(store.recoveryWarning).toBeUndefined()
  })

  it('recovers malformed JSON with a redacted local warning', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-settings-corrupt-'))
    await writeFile(join(userData, 'presenterai.json'), '{"settings":', 'utf8')
    const { SettingsStore } = await import('../src/main/settings/store')
    const store = new SettingsStore({ clock: () => new Date('2026-07-16T14:00:00.000Z') })
    await store.initialize()
    expect(store.recoveryWarning).toEqual({ code: 'invalid_json', recoveredAt: '2026-07-16T14:00:00.000Z' })
    const saved = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
    expect(saved.schemaVersion).toBe(3)
    expect(saved.windowLayoutRevision).toBe(1)
    expect(saved.recoveryWarning).toEqual(store.recoveryWarning)
    expect(saved.recoveryWarning).not.toHaveProperty('message')
  })

  it('salvages valid siblings from a version-2 file with an invalid setting', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-settings-salvage-'))
    await writeFile(join(userData, 'presenterai.json'), JSON.stringify({
      schemaVersion: 2,
      settings: {
        opacity: 0.81, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna',
        strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
        askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
        projectSummary: 'keep this valid value', approvedVocabulary: ['FTS5'], inrPerUsd: 5_000
      },
      documents: [], captureResults: [], usage: {
        inputTokens: 0, outputTokens: 0, audioMinutes: 0,
        transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
        estimatedUsd: 0, pricingVersion: 'openai-2026-07-16'
      },
      usageRecords: [], usageRollups: []
    }), 'utf8')
    const { SettingsStore } = await import('../src/main/settings/store')
    const store = new SettingsStore({ clock: () => new Date('2026-07-16T14:30:00.000Z') })
    await store.initialize()
    expect(store.settings).toMatchObject({ opacity: 0.81, projectSummary: 'keep this valid value', approvedVocabulary: ['FTS5'] })
    expect(store.settings.inrPerUsd).toBeUndefined()
    expect(store.recoveryWarning).toEqual({ code: 'invalid_shape', recoveredAt: '2026-07-16T14:30:00.000Z' })
  })

  it('migrates a valid version-2 file without losing local state and leaves legacy bounds pending one layout upgrade', async () => {
    userData = await mkdtemp(join(tmpdir(), 'presenter-settings-v2-'))
    const now = '2026-07-16T15:00:00.000Z'
    const versionTwo = {
      schemaVersion: 2,
      settings: {
        opacity: 0.73, clickThrough: true, modelMode: 'strong', normalModel: 'gpt-5.6-luna',
        strongModel: 'gpt-5.6-terra', transcriptionModel: 'gpt-4o-mini-transcribe',
        askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
        selectedAudioEndpointId: 'render-device', projectSummary: 'preserved summary',
        approvedVocabulary: ['WASAPI'], inrPerUsd: 84
      },
      windowBounds: { x: 2200, y: 80, width: 560, height: 690 },
      documents: [{ id: 'doc-1', name: 'project.md', path: 'C:\\fixtures\\project.md', kind: 'markdown', chunkCount: 2, addedAt: now }],
      captureResults: [{
        id: 'capture-1', path: 'Snipping Tool', captureAppVersion: '1',
        controlResult: 'overlay-visible', protectedResult: 'overlay-absent', testedAt: now, notes: 'preserve',
        environment: { windowsBuild: '26100', presenterVersion: '0.2', electronVersion: '43.1.0', gpu: 'fixture', monitorCount: 2 }
      }],
      usage: {
        inputTokens: 10, outputTokens: 5, audioMinutes: 0.25,
        transcriptionInputTokens: 8, transcriptionAudioTokens: 6, transcriptionOutputTokens: 2,
        estimatedUsd: 0.01, pricingVersion: 'openai-2026-07-16'
      },
      usageRecords: [{
        id: 'usage-1', timestamp: now, endpoint: 'responses', requestedModel: 'gpt-5.6-luna',
        returnedModel: 'gpt-5.6-luna', inputTokens: 10, outputTokens: 5,
        pricingVersion: 'openai-2026-07-16', priced: true, estimatedUsd: 0.00004
      }],
      usageRollups: [],
      privacyConsent: { acceptedVersion: 2, acceptedAt: now }
    }
    await writeFile(join(userData, 'presenterai.json'), JSON.stringify(versionTwo), 'utf8')
    const { SettingsStore, WINDOW_LAYOUT_REVISION } = await import('../src/main/settings/store')
    const store = new SettingsStore()
    await store.initialize()

    expect(store.recoveryWarning).toBeUndefined()
    expect(store.settings).toMatchObject({ opacity: 0.73, projectSummary: 'preserved summary', selectedAudioEndpointId: 'render-device' })
    expect(store.documents).toHaveLength(1)
    expect(store.captureResults).toHaveLength(1)
    expect(store.usageRecords).toHaveLength(1)
    expect(store.privacyConsent).toMatchObject({
      requiredVersion: 3,
      acceptedVersion: 2,
      acceptedAt: now,
      satisfied: false
    })
    expect(store.windowBounds).toEqual(versionTwo.windowBounds)
    expect(store.windowLayoutRevision).toBe(0)

    await store.setWindowLayout({ x: 1930, y: 80, width: 1100, height: 690 }, WINDOW_LAYOUT_REVISION)
    const saved = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
    expect(saved).toMatchObject({
      schemaVersion: 3, windowLayoutRevision: 1,
      windowBounds: { x: 1930, y: 80, width: 1100, height: 690 },
      settings: { projectSummary: 'preserved summary' }
    })
    expect(saved.documents).toEqual(versionTwo.documents)
    expect(saved.captureResults).toEqual(versionTwo.captureResults)
    expect(saved.usageRecords).toEqual(versionTwo.usageRecords)
    expect(saved.privacyConsent).toEqual(versionTwo.privacyConsent)
  })
})
