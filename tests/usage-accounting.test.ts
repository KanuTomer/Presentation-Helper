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
    expect(saved.settings.opacity).toBe(0.77)
    expect(saved.usage.inputTokens).toBe(210)
    expect(saved.usage.outputTokens).toBe(420)
    expect(saved.usage.audioMinutes).toBeCloseTo(0.2)
  })
})
