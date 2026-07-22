// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiService } from '../src/main/ai/service'
import type { TransmissionPreviewGate } from '../src/main/privacy/transmissionPreview'
import {
  HelperClientError,
  type HelperClient,
  type HelperEvent
} from '../src/main/audio/helperClient'
import type { SettingsStore } from '../src/main/settings/store'
import type { AppSettings, AssistantResponse, AudioDevice, TranscriptionDraft } from '../src/shared/contracts'
import { LocalDataDeletionService } from '../src/main/settings/dataDeletion'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const answer: AssistantResponse = {
  category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none',
  say: 'A grounded answer.', keyPoints: ['One.', 'Two.', 'Three.'],
  ifChallenged: 'Use the supplied evidence.', evidence: []
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

class FakeHelper {
  state: 'missing' | 'starting' | 'ready' | 'capturing' | 'failed' = 'ready'
  lastError?: string
  features: string[] = []
  onState?: () => void
  onShortcutDown?: () => void
  onShortcutUp?: () => void
  onCaptureLimitReached?: (operationId: string, reason: string) => void
  onUnexpectedExit?: () => void
  commands: Record<string, unknown>[] = []
  startCalls = 0
  stopProcessCalls = 0
  startCaptureReply?: Promise<HelperEvent>
  commandOverride?: (command: Record<string, unknown>) => Promise<HelperEvent> | HelperEvent | undefined
  devices: AudioDevice[] = [{ id: 'default', name: 'Default speakers', isDefault: true }]
  capturePath = ''

  get available() { return this.state === 'ready' || this.state === 'capturing' }

  async start() {
    this.startCalls++
    this.setLifecycle('ready')
    return true
  }

  async stopProcess() {
    this.stopProcessCalls++
    this.setLifecycle('missing')
  }

  setLifecycle(state: typeof this.state) { this.state = state; this.onState?.() }
  setFailure(message: string) { this.lastError = message; this.setLifecycle('failed') }

  async command(command: Record<string, unknown>): Promise<HelperEvent> {
    this.commands.push(command)
    const overridden = await this.commandOverride?.(command)
    if (overridden) return overridden
    const operationId = String(command.operationId)
    if (command.type === 'startCapture') {
      this.capturePath = String(command.path)
      return this.startCaptureReply ?? {
        type: 'captureStarted', operationId, endpointId: 'default', endpointName: 'Default speakers'
      }
    }
    if (command.type === 'stopCapture') {
      await writeFile(this.capturePath, pcmWave(1_000))
      return stopped(operationId, this.capturePath)
    }
    if (command.type === 'cancel') return { type: 'captureCancelled', operationId }
    if (command.type === 'listDevices') return { type: 'deviceList', devices: this.devices }
    if (command.type === 'configureShortcut') return { type: 'shortcutConfigured' }
    return { type: 'ready' }
  }
}

function stopped(operationId: string, path: string, overrides: Partial<HelperEvent> = {}): HelperEvent {
  return {
    type: 'captureStopped', operationId, path, durationMs: 1_000, bytes: 32_044,
    sampleRate: 16_000, channels: 1, endpointId: 'default', endpointName: 'Default speakers',
    terminalReason: 'stopped', ...overrides
  }
}

function pcmWave(durationMs: number): Buffer {
  const dataBytes = Math.floor(durationMs / 1_000 * 32_000)
  const output = Buffer.alloc(44 + dataBytes)
  output.write('RIFF', 0, 'ascii'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8, 'ascii')
  output.write('fmt ', 12, 'ascii'); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22); output.writeUInt32LE(16_000, 24); output.writeUInt32LE(32_000, 28)
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36, 'ascii'); output.writeUInt32LE(dataBytes, 40)
  return output
}

function appSettings(): AppSettings {
  return {
    glassTint: 0.42, sessionBudgetUsd: 0.25, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
    transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H',
    listenShortcut: 'Control+Shift+Space', projectSummary: '', approvedVocabulary: []
  }
}

async function harness(
  overrides: Partial<AiService> = {},
  initialSettings: Partial<AppSettings> = {},
  controllerOptions: { transmissionPreviewGate?: TransmissionPreviewGate; onListeningConsentRequired?: () => void } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'presenter-audio-test-'))
  const helper = new FakeHelper()
  const settings = {
    settings: { ...appSettings(), ...initialSettings },
    privacyConsent: { requiredVersion: 4, acceptedVersion: 4, acceptedAt: new Date(0).toISOString(), satisfied: true },
    updates: [] as Partial<AppSettings>[],
    usage: [] as Array<[number, number, number]>,
    async updateSettings(patch: Partial<AppSettings>) {
      this.updates.push(patch)
      this.settings = { ...this.settings, ...patch }
      return this.settings
    },
    async addUsage(input: number, output: number, duration: number) { this.usage.push([input, output, duration]) }
  }
  const ai = {
    transcriptionTerminologyHint: vi.fn(() => ''),
    transcribe: vi.fn(async () => ({ text: 'What does the project use?', model: 'gpt-4o-mini-transcribe', latencyMs: 10, usage: {} })),
    retrieve: vi.fn(() => []),
    generate: vi.fn(async () => answer),
    ...overrides
  }
  const shortcuts = { register: vi.fn(() => true), unregister: vi.fn() }
  const { OperationCoordinator } = await import('../src/main/operations/coordinator')
  const { AudioController } = await import('../src/main/audio/controller')
  const operations = new OperationCoordinator(shortcuts)
  const controller = new AudioController(
    ai as unknown as AiService, settings as unknown as SettingsStore, operations,
    {
      helper: helper as unknown as HelperClient, temporaryDirectory: () => directory, idGenerator: () => 'capture',
      ...controllerOptions
    }
  )
  controller.devices = [...helper.devices]
  const errors: unknown[] = []
  const drafts: TranscriptionDraft[] = []
  controller.onError = (error) => errors.push(error)
  controller.onTranscriptDraft = (draft) => {
    drafts.push(draft)
    queueMicrotask(() => controller.acknowledgeTranscriptVisible(draft.operationId))
  }
  return {
    controller, operations, helper, ai, settings, errors, drafts, shortcuts, directory,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

async function startListening(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  await expect(h.controller.startCapture()).resolves.toEqual({ ok: true })
  expect(h.operations.snapshot().operation).toBe('listening')
  return h.operations.snapshot().operationId!
}

async function waitForIdle(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('idle'), { timeout: 20_000 })
}

beforeEach(() => vi.restoreAllMocks())

describe('audio controller operation lifecycle', () => {
  it('rejects user-initiated shortcut changes while the native helper is unavailable', async () => {
    const h = await harness()
    h.helper.setLifecycle('missing')
    await expect(h.controller.configureShortcut('Alt+Space')).rejects.toMatchObject({ code: 'helper_unavailable' })
    expect(h.helper.commands).toEqual([])
    await h.cleanup()
  })

  it('blocks direct and helper-shortcut capture entry before any helper command until consent is accepted', async () => {
    const openPrivacy = vi.fn()
    const h = await harness({}, {}, { onListeningConsentRequired: openPrivacy })
    h.settings.privacyConsent.satisfied = false

    await expect(h.controller.startCapture()).resolves.toMatchObject({
      ok: false, error: { code: 'listening_consent_required' }
    })
    expect(h.operations.isBusy).toBe(false)
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toEqual([])
    expect(openPrivacy).toHaveBeenCalledOnce()

    await h.controller.initialize()
    h.helper.onShortcutDown?.()
    await vi.waitFor(() => expect(h.errors).toContainEqual(expect.objectContaining({ code: 'listening_consent_required' })))
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toEqual([])
    expect(openPrivacy).toHaveBeenCalledTimes(2)
    await h.cleanup()
  })

  it('does not upload audio until the transcription preview is acknowledged and never answers automatically', async () => {
    const transcriptionAck = deferred<void>()
    const previews: Array<{ stage: string; chunks: unknown[]; audio?: unknown }> = []
    const gate = {
      present: vi.fn(async (preview: { stage: string; chunks: unknown[]; audio?: unknown }) => {
        previews.push(preview)
        await transcriptionAck.promise
      }),
      clear: vi.fn()
    } as unknown as TransmissionPreviewGate
    const h = await harness({}, {}, { transmissionPreviewGate: gate })
    h.ai.transcriptionTerminologyHint.mockReturnValue('PREVIEWED TERMINOLOGY')
    await startListening(h)
    await h.controller.stopAndProcess()

    await vi.waitFor(() => expect(previews.map((preview) => preview.stage)).toEqual(['transcription']))
    expect(previews[0]?.audio).toMatchObject({ durationMs: 1_000, endpointName: 'Default speakers' })
    expect(h.ai.transcribe).not.toHaveBeenCalled()
    h.ai.transcriptionTerminologyHint.mockReturnValue('UNPREVIEWED TERMINOLOGY')
    transcriptionAck.resolve()

    await waitForIdle(h)
    expect(previews.map((preview) => preview.stage)).toEqual(['transcription'])
    expect(h.ai.transcribe).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ terminologyHint: 'PREVIEWED TERMINOLOGY' })
    )
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    expect(h.drafts).toEqual([expect.objectContaining({
      text: 'What does the project use?', durationMs: 1_000,
      endpointId: 'default', endpointName: 'Default speakers'
    })])
    expect(gate.clear).toHaveBeenCalled()
    await h.cleanup()
  })

  it('removes only abandoned WAV files older than one hour during startup', async () => {
    const h = await harness()
    const stale = join(h.directory, 'abandoned.wav')
    const recent = join(h.directory, 'recent.wav')
    const unrelated = join(h.directory, 'keep.txt')
    await Promise.all([writeFile(stale, pcmWave(1_000)), writeFile(recent, pcmWave(1_000)), writeFile(unrelated, 'keep')])
    const old = new Date(Date.now() - 2 * 3_600_000)
    await Promise.all([utimes(stale, old, old), utimes(unrelated, old, old)])

    await h.controller.initialize()

    expect((await readdir(h.directory)).sort()).toEqual(['keep.txt', 'recent.wav'])
    await h.cleanup()
  })

  it('clears PresenterAI-owned WAV files without removing unrelated files', async () => {
    const h = await harness()
    const ownedOne = join(h.directory, 'capture.wav')
    const ownedTwo = join(h.directory, 'abandoned.WAV')
    const unrelated = join(h.directory, 'review-notes.txt')
    await Promise.all([
      writeFile(ownedOne, pcmWave(1_000)),
      writeFile(ownedTwo, pcmWave(1_000)),
      writeFile(unrelated, 'keep this file')
    ])

    await h.controller.clearOwnedTemporaryAudio()

    expect(await readdir(h.directory)).toEqual(['review-notes.txt'])
    expect(await readFile(unrelated, 'utf8')).toBe('keep this file')
    await h.cleanup()
  })

  it('clears owned WAVs through Delete All maintenance without weakening the active-operation guard', async () => {
    const h = await harness()
    const ownedOne = join(h.directory, 'capture.wav')
    const ownedTwo = join(h.directory, 'abandoned.WAV')
    const unrelated = join(h.directory, 'review-notes.txt')
    await Promise.all([
      writeFile(ownedOne, pcmWave(1_000)),
      writeFile(ownedTwo, pcmWave(1_000)),
      writeFile(unrelated, 'keep this file')
    ])
    const scopeAction = vi.fn(async () => undefined)
    const deletion = new LocalDataDeletionService(
      () => h.operations.acquireMaintenance(),
      {
        session: scopeAction,
        documents: scopeAction,
        usage: scopeAction,
        compatibility: scopeAction,
        consent: scopeAction,
        apiKey: scopeAction,
        temporaryAudio: async () => {
          expect(h.operations.isBusy).toBe(true)
          await h.controller.clearOwnedTemporaryAudioForMaintenance()
        },
        settings: scopeAction
      }
    )

    await expect(deletion.deleteAll('DELETE ALL')).resolves.toEqual({
      ok: true,
      results: [
        'session', 'documents', 'usage', 'compatibility', 'consent', 'api-key', 'temporary-audio', 'settings'
      ].map((scope) => ({ scope, ok: true }))
    })
    expect(await readdir(h.directory)).toEqual(['review-notes.txt'])
    expect(await readFile(unrelated, 'utf8')).toBe('keep this file')

    const operation = h.operations.begin('typed', 'retrieving')
    await expect(h.controller.clearOwnedTemporaryAudio()).rejects.toMatchObject({ code: 'busy' })
    await h.operations.finish(operation.id, 'success')
    await h.cleanup()
  })

  it('latches a rapid second toggle and processes exactly one finalized segment', async () => {
    const h = await harness()
    const start = deferred<HelperEvent>()
    h.helper.startCaptureReply = start.promise
    const starting = h.controller.toggleListening()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('starting_capture'))
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    const operationId = h.operations.snapshot().operationId!
    start.resolve({ type: 'captureStarted', operationId, endpointId: 'default', endpointName: 'Default speakers' })
    await starting
    await waitForIdle(h)
    expect(h.helper.commands.filter((item) => item.type === 'stopCapture')).toHaveLength(1)
    expect(h.ai.transcribe).toHaveBeenCalledTimes(1)
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    expect(h.drafts).toHaveLength(1)
    await expect(readFile(join(h.directory, 'capture.wav'))).rejects.toThrow()
    await h.cleanup()
  })

  it('toggles two complete shortcut-driven capture cycles and ignores key-up', async () => {
    const h = await harness()
    await h.controller.initialize()

    h.helper.onShortcutDown?.()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('listening'))
    const firstOperationId = h.operations.snapshot().operationId
    h.helper.onShortcutUp?.()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('listening'))
    expect(h.helper.commands.filter((item) => item.type === 'stopCapture')).toHaveLength(0)

    h.helper.onShortcutDown?.()
    await waitForIdle(h)
    expect(h.drafts).toHaveLength(1)

    h.helper.onShortcutDown?.()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('listening'))
    const secondOperationId = h.operations.snapshot().operationId
    expect(secondOperationId).not.toBe(firstOperationId)
    h.helper.onShortcutUp?.()
    expect(h.operations.snapshot().operation).toBe('listening')
    h.helper.onShortcutDown?.()
    await waitForIdle(h)

    expect(h.drafts).toHaveLength(2)
    expect(h.drafts[1]?.operationId).not.toBe(h.drafts[0]?.operationId)
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toHaveLength(2)
    expect(h.helper.commands.filter((item) => item.type === 'stopCapture')).toHaveLength(2)
    expect(h.helper.commands.filter((item) => item.type === 'stopCapture')).toEqual([
      expect.objectContaining({ operationId: firstOperationId, terminalReason: 'stopped' }),
      expect.objectContaining({ operationId: secondOperationId, terminalReason: 'stopped' })
    ])
    await h.cleanup()
  })

  it('starts a new capture from the terminal error display after a failed toggle', async () => {
    const h = await harness()
    let failFirstStart = true
    h.helper.commandOverride = async (command) => {
      if (command.type === 'startCapture' && failFirstStart) {
        failFirstStart = false
        throw new HelperClientError('device_unavailable', 'The default endpoint is unavailable.')
      }
      return undefined
    }

    await expect(h.controller.toggleListening()).resolves.toMatchObject({
      ok: false, error: { code: 'device_unavailable' }
    })
    expect(h.operations.snapshot().operation).toBe('error')

    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    expect(h.operations.snapshot()).toMatchObject({ operation: 'listening', operationError: undefined })
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    await waitForIdle(h)
    expect(h.drafts).toHaveLength(1)
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toHaveLength(2)
    await h.cleanup()
  })

  it('returns Busy when toggled during downstream audio processing or a typed operation', async () => {
    const transcription = deferred<Awaited<ReturnType<AiService['transcribe']>>>()
    const h = await harness({ transcribe: vi.fn(() => transcription.promise) as never })
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('transcribing'))
    await expect(h.controller.toggleListening()).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toHaveLength(1)
    await h.controller.cancel()
    transcription.resolve({ text: 'late', model: 'gpt-4o-mini-transcribe', latencyMs: 1, usage: {} })
    await waitForIdle(h)

    const typed = h.operations.begin('typed', 'retrieving')
    await expect(h.controller.toggleListening()).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    await h.operations.finish(typed.id, 'success')
    await h.cleanup()
  })

  it('accepts the legacy released terminal reason from an older helper', async () => {
    const h = await harness()
    const operationId = await startListening(h)
    h.helper.commandOverride = async (command) => {
      if (command.type !== 'stopCapture') return undefined
      await writeFile(h.helper.capturePath, pcmWave(1_000))
      return stopped(operationId, h.helper.capturePath, { terminalReason: 'released' })
    }
    await h.controller.toggleListening()
    await waitForIdle(h)
    expect(h.controller.lastCapture?.terminalReason).toBe('released')
    expect(h.drafts).toHaveLength(1)
    await h.cleanup()
  })

  it('cancels during startup, ignores the late reply, and removes the owned path', async () => {
    const h = await harness()
    const start = deferred<HelperEvent>()
    h.helper.startCaptureReply = start.promise
    const starting = h.controller.startCapture()
    await vi.waitFor(() => expect(h.operations.snapshot().operationId).toBeTruthy())
    const operationId = h.operations.snapshot().operationId!
    await vi.waitFor(() => expect(h.helper.commands.some((item) => item.type === 'startCapture')).toBe(true), { timeout: 20_000 })
    await h.controller.cancel()
    start.resolve({ type: 'captureStarted', operationId, endpointId: 'default', endpointName: 'Default speakers' })
    await starting
    expect(h.operations.snapshot().operation).toBe('idle')
    expect(h.ai.transcribe).not.toHaveBeenCalled()
    expect(h.helper.commands.filter((item) => item.type === 'cancel')).toHaveLength(1)
    await expect(readFile(join(h.directory, 'capture.wav'))).rejects.toThrow()
    await h.cleanup()
  })

  it('cancels during finalization and ignores the late stop reply', async () => {
    const h = await harness()
    const stop = deferred<HelperEvent>()
    h.helper.commandOverride = async (command) => command.type === 'stopCapture' ? stop.promise : undefined
    const operationId = await startListening(h)
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('finalizing'))
    await h.controller.cancel()
    expect(h.operations.snapshot().operation).toBe('idle')
    stop.resolve(stopped(operationId, join(h.directory, 'capture.wav')))
    await vi.waitFor(() => expect(h.ai.transcribe).not.toHaveBeenCalled())
    expect(h.errors).toEqual([])
    expect(h.drafts).toEqual([])
    expect(h.shortcuts.unregister).toHaveBeenCalledTimes(1)
    await h.cleanup()
  })

  it('treats duplicate_terminal during a stop/cancel race as proof of cleanup without killing the helper', async () => {
    const h = await harness()
    const stop = deferred<HelperEvent>()
    h.helper.commandOverride = async (command) => {
      if (command.type === 'stopCapture') return stop.promise
      if (command.type === 'cancel') throw new HelperClientError('duplicate_terminal', 'The operation already ended.')
      return undefined
    }
    const operationId = await startListening(h)
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('finalizing'))
    await h.controller.cancel()

    expect(h.operations.snapshot().operation).toBe('idle')
    expect(h.helper.stopProcessCalls).toBe(0)
    expect(h.helper.state).toBe('ready')
    stop.resolve(stopped(operationId, join(h.directory, 'capture.wav')))
    await vi.waitFor(() => expect(h.ai.transcribe).not.toHaveBeenCalled())
    expect(h.errors).toEqual([])
    await h.cleanup()
  })

  it('cancels during transcription, deletes the WAV, and prevents retrieval', async () => {
    const transcription = deferred<Awaited<ReturnType<AiService['transcribe']>>>()
    const h = await harness({ transcribe: vi.fn(() => transcription.promise) as never })
    await startListening(h)
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('transcribing'))
    expect(h.controller.temporaryAudio).toBe(join(h.directory, 'capture.wav'))
    await h.controller.cancel()
    await waitForIdle(h)
    expect(existsSync(join(h.directory, 'capture.wav'))).toBe(false)
    transcription.resolve({ text: 'late transcript', model: 'gpt-4o-mini-transcribe', latencyMs: 1, usage: {} })
    await vi.waitFor(() => expect(h.ai.retrieve).not.toHaveBeenCalled())
    expect(h.errors).toEqual([])
    expect(h.drafts).toEqual([])
    await h.cleanup()
  })

  it('emits an editable draft without retrieving chunks or generating an answer', async () => {
    const h = await harness()
    await startListening(h)
    await h.controller.stopAndProcess()
    await waitForIdle(h)
    expect(h.drafts).toEqual([expect.objectContaining({ text: 'What does the project use?' })])
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    expect(h.errors).toEqual([])
    await h.cleanup()
  })

  it('cancels while waiting for draft visibility and ignores a stale acknowledgement', async () => {
    const h = await harness()
    const draftSeen = deferred<TranscriptionDraft>()
    h.controller.onTranscriptDraft = (draft) => draftSeen.resolve(draft)
    await startListening(h)
    await h.controller.stopAndProcess()
    const draft = await draftSeen.promise
    expect(h.operations.snapshot().operation).toBe('transcribing')
    await h.controller.cancel()
    await waitForIdle(h)
    h.controller.acknowledgeTranscriptVisible(draft.operationId)
    expect(h.operations.snapshot()).toMatchObject({ operation: 'idle', transcriptRenderConfirmed: false })
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    expect(h.errors).toEqual([])
    await h.cleanup()
  })

  it('deletes audio immediately after transcription, before exposing the draft', async () => {
    const h = await harness()
    const drafts: TranscriptionDraft[] = []
    h.controller.onTranscriptDraft = (draft) => {
      expect(existsSync(join(h.directory, 'capture.wav'))).toBe(false)
      expect(h.controller.temporaryAudio).toBeUndefined()
      drafts.push(draft)
      h.controller.acknowledgeTranscriptVisible(draft.operationId)
    }
    await startListening(h)
    await h.controller.stopAndProcess()
    await waitForIdle(h)
    expect(drafts).toHaveLength(1)
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    expect(await readdir(h.directory)).toEqual([])
    await h.cleanup()
  })

  it('fails closed when the renderer cannot confirm that the transcript draft is visible', async () => {
    vi.useFakeTimers()
    const h = await harness()
    const draftSeen = deferred<TranscriptionDraft>()
    h.controller.onTranscriptDraft = (draft) => draftSeen.resolve(draft)
    await startListening(h)
    await h.controller.stopAndProcess()
    await draftSeen.promise
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    expect(h.errors).toEqual([expect.objectContaining({
      code: 'transcript_display_unavailable', retryable: true
    })])
    expect(h.ai.retrieve).not.toHaveBeenCalled()
    expect(h.ai.generate).not.toHaveBeenCalled()
    vi.useRealTimers()

    const retryDrafts: TranscriptionDraft[] = []
    h.controller.onTranscriptDraft = (draft) => {
      retryDrafts.push(draft)
      h.controller.acknowledgeTranscriptVisible(draft.operationId)
    }
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    expect(h.operations.snapshot()).toMatchObject({ operation: 'listening', operationError: undefined })
    await expect(h.controller.toggleListening()).resolves.toEqual({ ok: true })
    await waitForIdle(h)
    expect(retryDrafts).toHaveLength(1)
    await h.cleanup()
  })

  it('returns Busy for a second capture or typed/audio overlap without issuing another start', async () => {
    const h = await harness()
    await startListening(h)
    await expect(h.controller.startCapture()).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')).toHaveLength(1)
    await h.controller.cancel()

    const typed = h.operations.begin('typed', 'retrieving')
    await expect(h.controller.startCapture()).resolves.toMatchObject({ ok: false, error: { code: 'busy' } })
    await h.operations.finish(typed.id, 'success')
    await h.cleanup()
  })

  it('rejects a stale stop reply as invalid audio and emits exactly one terminal error', async () => {
    const h = await harness()
    await startListening(h)
    h.helper.commandOverride = async (command) => command.type === 'stopCapture'
      ? stopped('expired-operation', join(h.directory, 'capture.wav'))
      : undefined
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ code: 'invalid_audio' })
    expect(h.drafts).toEqual([])
    expect(h.shortcuts.unregister).toHaveBeenCalledTimes(1)
    expect(existsSync(join(h.directory, 'capture.wav'))).toBe(false)
    await h.cleanup()
  })

  it('maps a finalization timeout to capture_timeout and cancels the helper once', async () => {
    const h = await harness()
    await startListening(h)
    h.helper.commandOverride = async (command) => {
      if (command.type === 'stopCapture') throw new HelperClientError('helper_timeout', 'Windows helper timed out.')
      return undefined
    }
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    expect(h.errors).toEqual([expect.objectContaining({ code: 'capture_timeout', retryable: true })])
    expect(h.helper.commands.filter((item) => item.type === 'cancel')).toHaveLength(1)
    expect(h.drafts).toEqual([])
    await h.cleanup()
  })

  it('refreshes once and falls back visibly when a saved endpoint disappears', async () => {
    const h = await harness({}, { selectedAudioEndpointId: 'removed-output' })
    let starts = 0
    h.helper.commandOverride = async (command) => {
      if (command.type !== 'startCapture') return undefined
      starts++
      if (starts === 1) throw new HelperClientError('device_unavailable', 'The selected endpoint disappeared.')
      return { type: 'captureStarted', operationId: String(command.operationId), endpointId: 'default', endpointName: 'Default speakers' }
    }
    await expect(h.controller.startCapture()).resolves.toEqual({ ok: true })
    expect(starts).toBe(2)
    const startCommands = h.helper.commands.filter((item) => item.type === 'startCapture')
    expect(startCommands[0]).toMatchObject({ endpointId: 'removed-output' })
    expect(startCommands[1]).not.toHaveProperty('endpointId')
    expect(h.settings.settings.selectedAudioEndpointId).toBeUndefined()
    expect(h.controller.warning).toMatch(/switched to the current Windows default/i)
    expect(h.controller.activeEndpoint).toMatchObject({ id: 'default', name: 'Default speakers' })
    await h.controller.cancel()
    await h.cleanup()
  })

  it('still tries the Windows default once when endpoint refresh also fails', async () => {
    const h = await harness({}, { selectedAudioEndpointId: 'removed-output' })
    let starts = 0
    h.helper.commandOverride = async (command) => {
      if (command.type === 'listDevices') throw new HelperClientError('device_unavailable', 'Enumeration was invalidated.')
      if (command.type !== 'startCapture') return undefined
      starts++
      if (starts === 1) throw new HelperClientError('device_unavailable', 'The selected endpoint disappeared.')
      return { type: 'captureStarted', operationId: String(command.operationId), endpointId: 'new-default', endpointName: 'New default speakers' }
    }
    await expect(h.controller.startCapture()).resolves.toEqual({ ok: true })
    expect(starts).toBe(2)
    expect(h.helper.commands.filter((item) => item.type === 'listDevices')).toHaveLength(1)
    expect(h.helper.commands.filter((item) => item.type === 'startCapture')[1]).not.toHaveProperty('endpointId')
    expect(h.controller.warning).toMatch(/device refresh failed.*default output once/i)
    expect(h.controller.activeEndpoint).toMatchObject({ id: 'new-default', name: 'New default speakers' })
    await h.controller.cancel()
    await h.cleanup()
  })

  it('delivers a shortcut-driven capture-start failure exactly once', async () => {
    const h = await harness()
    await h.controller.initialize()
    h.helper.commandOverride = async (command) => {
      if (command.type === 'startCapture') throw new HelperClientError('device_unavailable', 'The default endpoint is unavailable.')
      return undefined
    }
    h.helper.onShortcutDown?.()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors).toEqual([expect.objectContaining({ code: 'device_unavailable' })])
    await h.cleanup()
  })

  it('handles an active helper crash with one error, full cleanup, and no automatic restart', async () => {
    const h = await harness()
    await h.controller.initialize()
    await startListening(h)
    h.helper.setLifecycle('failed')
    h.helper.onUnexpectedExit?.()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    expect(h.errors).toEqual([expect.objectContaining({ code: 'helper_unavailable' })])
    expect(h.helper.startCalls).toBe(1)
    expect(h.drafts).toEqual([])
    expect(h.controller.temporaryAudio).toBeUndefined()
    expect(await readdir(h.directory)).toEqual([])
    await h.cleanup()
  })

  it('reports a helper crash during pending finalization only once', async () => {
    const h = await harness()
    await h.controller.initialize()
    const stop = deferred<HelperEvent>()
    h.helper.commandOverride = async (command) => command.type === 'stopCapture' ? stop.promise : undefined
    await startListening(h)
    await h.controller.stopAndProcess()
    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('finalizing'))

    h.helper.setLifecycle('failed')
    h.helper.onUnexpectedExit?.()
    stop.reject(new HelperClientError('helper_exited', 'The helper exited.'))

    await vi.waitFor(() => expect(h.operations.snapshot().operation).toBe('error'))
    expect(h.errors).toEqual([expect.objectContaining({ code: 'helper_unavailable' })])
    expect(h.drafts).toEqual([])
    await h.cleanup()
  })

  it('restarts an idle sidecar crash without cancelling an unrelated typed operation', async () => {
    vi.useFakeTimers()
    const h = await harness()
    await h.controller.initialize()
    const typed = h.operations.begin('typed', 'generating')

    h.helper.setLifecycle('failed')
    h.helper.onUnexpectedExit?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(h.helper.startCalls).toBe(2))

    expect(h.operations.current).toMatchObject({ id: typed.id, kind: 'typed' })
    expect(h.operations.snapshot().operation).toBe('generating')
    expect(h.errors).toEqual([])
    await h.operations.finish(typed.id, 'success')
    vi.useRealTimers()
    await h.cleanup()
  })

  it('automatically restarts only the first idle crash until an explicit retry resets the allowance', async () => {
    vi.useFakeTimers()
    const h = await harness()
    await h.controller.initialize()
    expect(h.helper.startCalls).toBe(1)

    h.helper.setLifecycle('failed')
    h.helper.onUnexpectedExit?.()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(h.helper.startCalls).toBe(2))
    expect(h.helper.state).toBe('ready')

    h.helper.setLifecycle('failed')
    h.helper.onUnexpectedExit?.()
    await vi.runAllTicks()
    expect(h.helper.startCalls).toBe(2)
    expect(h.errors).toEqual([expect.objectContaining({ code: 'helper_unavailable' })])

    await h.controller.refreshDevices(true)
    expect(h.helper.startCalls).toBe(3)
    expect(h.helper.state).toBe('ready')
    vi.useRealTimers()
    await h.cleanup()
  })

  it('treats duplicate native safety-limit notifications as one finalization', async () => {
    const h = await harness()
    await h.controller.initialize()
    const operationId = await startListening(h)
    h.helper.commandOverride = async (command) => {
      if (command.type !== 'stopCapture') return undefined
      await writeFile(h.helper.capturePath, pcmWave(1_000))
      return stopped(operationId, h.helper.capturePath, { terminalReason: 'maximum_duration' })
    }
    h.helper.onCaptureLimitReached?.(operationId, 'maximum_duration')
    h.helper.onCaptureLimitReached?.(operationId, 'maximum_duration')
    await waitForIdle(h)
    expect(h.helper.commands.filter((item) => item.type === 'stopCapture')).toHaveLength(1)
    expect(h.ai.transcribe).toHaveBeenCalledTimes(1)
    expect(h.drafts).toHaveLength(1)
    expect(h.controller.lastCapture?.terminalReason).toBe('maximum_duration')
    await h.cleanup()
  })

  it('dispose cancels active capture, deletes owned files, and shuts the helper down once', async () => {
    const h = await harness()
    await h.controller.initialize()
    await startListening(h)
    await writeFile(join(h.directory, 'capture.wav'), pcmWave(1_000))
    await h.controller.dispose()
    expect(h.operations.snapshot().operation).toBe('idle')
    expect(h.helper.commands.filter((item) => item.type === 'cancel')).toHaveLength(1)
    expect(h.helper.stopProcessCalls).toBe(1)
    expect(h.controller.temporaryAudio).toBeUndefined()
    expect(await readdir(h.directory)).toEqual([])
    await expect(h.controller.startCapture()).resolves.toMatchObject({ ok: false, error: { code: 'helper_unavailable' } })
    await h.cleanup()
  })
})
