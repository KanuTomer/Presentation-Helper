import { app } from 'electron'
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HelperClient, HelperClientError, type HelperEvent } from './helperClient.js'
import type {
  AiErrorInfo, AssistantResponse, AudioCaptureResult, AudioDevice, OperationActionResult
} from '../../shared/contracts.js'
import type { SettingsStore } from '../settings/store.js'
import type { AiService } from '../ai/service.js'
import {
  OperationCoordinator, operationError, toOperationError, type OperationHandle
} from '../operations/coordinator.js'
import { validatePresenterWav } from './wavValidation.js'
import {
  buildResponseTransmissionPreview, buildTranscriptionTransmissionPreview,
  type TransmissionPreviewGate
} from '../privacy/transmissionPreview.js'

interface CaptureSession {
  operation: OperationHandle
  path: string
  captureStarted: boolean
  captureCommandIssued: boolean
  helperTerminal: boolean
  filePresent: boolean
  stopRequested: boolean
  cancelRequested: boolean
  processing: boolean
  terminal: boolean
  limitTimer?: NodeJS.Timeout
  cancellation?: Promise<void>
}

export interface AudioControllerOptions {
  helper?: HelperClient
  temporaryDirectory?: () => string
  idGenerator?: () => string
  transmissionPreviewGate?: TransmissionPreviewGate
  onListeningConsentRequired?: () => void
}

export class AudioController {
  readonly helper: HelperClient
  devices: AudioDevice[] = []
  lastCapture?: Omit<AudioCaptureResult, 'path'>
  activeEndpoint?: AudioDevice
  warning?: string
  onState?: () => void
  onResponse?: (response: AssistantResponse, operationId: string) => void
  onError?: (error: AiErrorInfo) => void
  private session?: CaptureSession
  private restartUsed = false
  private disposed = false
  private helperInitialization?: Promise<void>
  private orphanedAudioPath?: string

  constructor(
    private ai: AiService,
    private settings: SettingsStore,
    readonly operations: OperationCoordinator,
    private options: AudioControllerOptions = {}
  ) {
    this.helper = options.helper ?? new HelperClient()
    this.operations.onChange = () => this.notify()
  }

  get listening(): boolean { return this.operations.snapshot().operation === 'listening' }
  get temporaryAudio(): string | undefined { return this.session?.filePresent ? this.session.path : this.orphanedAudioPath }

  async initialize(): Promise<void> {
    await this.cleanupStale()
    this.helper.onState = () => this.notify()
    this.helper.onShortcutDown = () => {
      void this.toggleListening().then((result) => { if (!result.ok) this.report(result.error) })
    }
    // The native hook still emits key-up so it can rearm the configured
    // accelerator and suppress autorepeat. Toggle semantics intentionally do
    // not attach an application action to release.
    this.helper.onShortcutUp = () => undefined
    this.helper.onCaptureLimitReached = (operationId, reason) => {
      const session = this.session
      if (!session || session.operation.id !== operationId || session.processing || session.terminal) return
      this.warning = reason === 'maximum_size'
        ? 'The bounded 128 MiB capture limit was reached. PresenterAI is finalizing the recording.'
        : 'The 90-second capture limit was reached. PresenterAI is finalizing the bounded recording.'
      void this.processCapture(session)
    }
    this.helper.onUnexpectedExit = () => { void this.recoverHelper() }
    await this.startHelper(false)
  }

  async configureShortcut(accelerator: string): Promise<void> {
    if (!this.helper.available) {
      throw operationError('helper_unavailable', 'The Windows helper must be ready before changing the listening toggle shortcut.', true)
    }
    await this.helper.command({ type: 'configureShortcut', accelerator }, ['shortcutConfigured', 'error'])
  }

  async refreshDevices(manualRetry = false): Promise<AudioDevice[]> {
    if (!this.helper.available && manualRetry) await this.startHelper(true)
    if (!this.helper.available) { this.devices = []; this.notify(); return [] }
    const response = await this.helper.command({ type: 'listDevices' }, ['deviceList', 'error'])
    this.devices = parseDevices(response.devices)
    const selected = this.settings.settings.selectedAudioEndpointId
    if (selected && !this.devices.some((device) => device.id === selected)) {
      this.warning = 'The selected audio output is unavailable. PresenterAI will use the current Windows default output.'
      await this.settings.updateSettings({ selectedAudioEndpointId: undefined })
    }
    this.notify()
    return this.devices
  }

  async startCapture(): Promise<OperationActionResult> {
    if (this.disposed) return failure('helper_unavailable', 'PresenterAI is shutting down.', false)
    if (!this.settings.privacyConsent.satisfied) {
      this.options.onListeningConsentRequired?.()
      return failure(
        'listening_consent_required',
        'Review and accept the first-use listening disclosure in Privacy before starting capture.',
        false
      )
    }
    let operation: OperationHandle
    try { operation = this.operations.begin('audio', 'starting_capture') }
    catch (error) { return { ok: false, error: toOperationError(error) } }
    if (!this.helper.available) {
      const error = operationError('helper_unavailable', this.helper.lastError ?? 'Windows audio helper is unavailable.', true)
      await this.operations.finish(operation.id, 'error', error)
      return { ok: false, error }
    }

    const directory = this.tempDirectory()
    const session: CaptureSession = {
      operation, path: join(directory, `${(this.options.idGenerator ?? randomUUID)()}.wav`),
      captureStarted: false, captureCommandIssued: false, helperTerminal: false, filePresent: false,
      stopRequested: false, cancelRequested: false, processing: false, terminal: false
    }
    this.session = session
    this.warning = undefined
    this.activeEndpoint = undefined
    this.operations.registerCleanup(operation.id, async () => this.cleanupSession(session))
    if (this.options.transmissionPreviewGate) {
      this.operations.registerCleanup(operation.id, () => this.options.transmissionPreviewGate?.clear(operation.id))
    }
    this.operations.setCancelHandler(operation.id, async () => this.cancelSession(session))
    this.notify()

    try {
      await mkdir(directory, { recursive: true })
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) {
        await this.cancelSession(session)
        return { ok: true }
      }
      let event: HelperEvent
      try { event = await this.startHelperCapture(session, this.settings.settings.selectedAudioEndpointId) }
      catch (error) {
        if (!this.settings.settings.selectedAudioEndpointId || !isDeviceUnavailable(error) || !this.operations.isCurrent(operation.id)) throw error
        this.warning = 'The selected audio output disappeared. PresenterAI switched to the current Windows default output.'
        await this.settings.updateSettings({ selectedAudioEndpointId: undefined })
        try { await this.refreshDevices() }
        catch {
          // Enumeration and default activation are separate Windows operations.
          // A disappearing endpoint can invalidate enumeration while the new
          // default is already usable, so the one permitted fallback attempt
          // must not be skipped solely because refresh failed.
          this.devices = []
          this.warning = 'The selected audio output disappeared and device refresh failed. PresenterAI is trying the current Windows default output once.'
          this.notify()
        }
        event = await this.startHelperCapture(session, undefined)
      }
      if (!this.operations.isCurrent(operation.id)) return { ok: true }
      validateOperationEvent(event, operation.id)
      session.captureStarted = true
      this.activeEndpoint = endpointFromEvent(event, this.devices)
      this.helper.setLifecycle('capturing')
      if (operation.signal.aborted || session.cancelRequested) {
        await this.cancelSession(session)
      } else if (session.stopRequested) {
        void this.processCapture(session)
      } else {
        this.operations.transition(operation.id, 'listening')
        session.limitTimer = setTimeout(() => {
          if (!this.operations.isCurrent(operation.id) || session.processing || session.terminal) return
          this.warning = 'The 90-second capture limit was reached. PresenterAI is finalizing the bounded recording.'
          void this.processCapture(session)
        }, 90_000)
      }
      return { ok: true }
    } catch (error) {
      const mapped = mapCaptureError(error)
      // finish(error) aborts the shared signal as part of terminal cleanup, so
      // cancellation ownership must be captured before finish mutates it.
      const wasCancelled = operation.signal.aborted
      await this.operations.finish(operation.id, wasCancelled ? 'cancelled' : 'error', wasCancelled ? undefined : mapped)
      return wasCancelled ? { ok: true } : { ok: false, error: mapped }
    }
  }

  /**
   * Atomically toggles the single application-wide audio operation. A second
   * press during helper startup is latched and finalized after capture starts;
   * presses during downstream processing remain Busy rather than accidentally
   * starting a new capture.
   */
  async toggleListening(): Promise<OperationActionResult> {
    const current = this.operations.current
    if (!current) return this.startCapture()
    if (current.kind !== 'audio') {
      return failure('busy', 'Another PresenterAI operation is already active.', false)
    }
    const stage = this.operations.snapshot().operation
    if (stage === 'starting_capture' || stage === 'listening') return this.stopAndProcess()
    return failure('busy', 'Wait for PresenterAI to finish processing the current recording.', false)
  }

  async stopAndProcess(): Promise<OperationActionResult> {
    const session = this.session
    if (!session || !this.operations.isCurrent(session.operation.id)) {
      return failure('busy', 'PresenterAI is not currently capturing audio.', false)
    }
    const stage = this.operations.snapshot().operation
    if (stage === 'starting_capture') {
      session.stopRequested = true
      this.notify()
      return { ok: true }
    }
    if (stage !== 'listening' || session.processing) return { ok: true }
    void this.processCapture(session)
    return { ok: true }
  }

  async cancel(): Promise<OperationActionResult> {
    if (!this.operations.isBusy) { await this.operations.cancel(); return { ok: true } }
    await this.operations.cancel()
    return { ok: true }
  }

  acknowledgeListeningIndicator(operationId: string): void {
    this.operations.acknowledgeListeningIndicator(operationId)
  }

  acknowledgeAnswerVisible(operationId: string): void {
    this.operations.acknowledgeAnswerVisible(operationId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.operations.cancel()
    const session = this.session
    if (session) await this.cleanupSession(session)
    await this.helper.stopProcess()
  }

  async clearOwnedTemporaryAudio(): Promise<void> {
    if (this.operations.isBusy) throw operationError('busy', 'Wait for the active PresenterAI operation to finish before clearing local data.', false)
    await this.deleteOwnedTemporaryAudioFiles()
  }

  /**
   * Delete All calls this only after acquiring the application-wide
   * maintenance reservation. The ordinary cleanup entry point above keeps its
   * busy guard so no renderer or operation path can bypass active-work safety.
   */
  async clearOwnedTemporaryAudioForMaintenance(): Promise<void> {
    await this.deleteOwnedTemporaryAudioFiles()
  }

  private async deleteOwnedTemporaryAudioFiles(): Promise<void> {
    const directory = this.tempDirectory()
    await mkdir(directory, { recursive: true })
    const failures: string[] = []
    for (const file of await readdir(directory)) {
      if (!file.toLocaleLowerCase('en-US').endsWith('.wav')) continue
      const path = join(directory, file)
      try {
        const info = await lstat(path)
        if (info.isFile() && !await this.deleteAudio(path)) failures.push(file)
      } catch { failures.push(file) }
    }
    if (failures.length) throw new Error(`PresenterAI could not remove ${failures.length} temporary audio file(s).`)
    this.orphanedAudioPath = undefined
    this.warning = undefined
    this.notify()
  }

  private async processCapture(session: CaptureSession): Promise<void> {
    if (session.processing || session.terminal || !this.operations.isCurrent(session.operation.id)) return
    session.processing = true
    clearTimeout(session.limitTimer)
    const { operation } = session
    let terminalError: AiErrorInfo | undefined
    try {
      this.operations.transition(operation.id, 'finalizing')
      const event = await this.helper.command({
        type: 'stopCapture', operationId: operation.id, terminalReason: 'stopped'
      }, ['captureStopped', 'error'], 30_000)
      validateOperationEvent(event, operation.id)
      session.helperTerminal = true
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) throw operationError('cancelled', 'Operation cancelled.', false)
      this.helper.setLifecycle('ready')
      const capture = captureResult(event, session.path)
      session.filePresent = true
      const validatedAudio = await validatePresenterWav(session.path, this.tempDirectory(), capture)
      this.lastCapture = withoutPath(capture)
      this.activeEndpoint = { id: capture.endpointId, name: capture.endpointName, isDefault: this.devices.find((device) => device.id === capture.endpointId)?.isDefault ?? false }

      this.operations.transition(operation.id, 'transcribing')
      let transcription: Awaited<ReturnType<AiService['transcribe']>>
      const terminologyHint = this.ai.transcriptionTerminologyHint()
      try {
        await this.options.transmissionPreviewGate?.present(buildTranscriptionTransmissionPreview(
          operation.id,
          { durationMs: validatedAudio.durationMs, bytes: validatedAudio.byteCount, endpointName: capture.endpointName },
          terminologyHint
        ))
        transcription = await this.ai.transcribe(
          { bytes: validatedAudio.bytes, filename: 'reviewer.wav' },
          { signal: operation.signal, durationMs: validatedAudio.durationMs, terminologyHint }
        )
      } finally {
        await this.deleteSessionAudio(session, true)
      }
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) throw operationError('cancelled', 'Operation cancelled.', false)

      this.operations.transition(operation.id, 'retrieving')
      const chunks = this.ai.retrieve(transcription.text, { signal: operation.signal })
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) throw operationError('cancelled', 'Operation cancelled.', false)

      await this.options.transmissionPreviewGate?.present(buildResponseTransmissionPreview(operation.id, chunks))
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) throw operationError('cancelled', 'Operation cancelled.', false)

      this.operations.transition(operation.id, 'generating')
      const response = await this.ai.generate(transcription.text, chunks, { signal: operation.signal })
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) throw operationError('cancelled', 'Operation cancelled.', false)
      this.operations.completeCurrentStage(operation.id)
      this.onResponse?.(response, operation.id)
      const answerVisible = await this.operations.waitForAnswerVisible(operation.id)
      if (!answerVisible && !operation.signal.aborted) {
        throw operationError('timeout', 'The answer was generated, but PresenterAI could not confirm that it became visible.', true)
      }
    } catch (error) {
      terminalError = mapPipelineError(error)
      if (terminalError.code !== 'cancelled' && !operation.signal.aborted && this.operations.isCurrent(operation.id)) this.report(terminalError)
    } finally {
      session.terminal = true
      await this.operations.finish(operation.id, operation.signal.aborted || terminalError?.code === 'cancelled' ? 'cancelled' : terminalError ? 'error' : 'success', terminalError)
    }
  }

  private async cancelSession(session: CaptureSession): Promise<void> {
    session.cancelRequested = true
    if (session.terminal) return
    if (session.cancellation) return session.cancellation
    session.cancellation = (async () => {
      await this.ensureHelperTerminal(session)
      session.terminal = true
      await this.operations.finish(session.operation.id, 'cancelled')
    })()
    return session.cancellation
  }

  private async cleanupSession(session: CaptureSession): Promise<void> {
    clearTimeout(session.limitTimer)
    await this.ensureHelperTerminal(session)
    await this.deleteSessionAudio(session)
    if (this.session?.operation.id === session.operation.id) this.session = undefined
    this.activeEndpoint = undefined
    if (this.helper.state !== 'failed' && this.helper.state !== 'missing' && this.helper.state !== 'starting') this.helper.setLifecycle('ready')
    this.notify()
  }

  private async startHelperCapture(session: CaptureSession, endpointId?: string): Promise<HelperEvent> {
    session.captureCommandIssued = true
    return this.helper.command({
      type: 'startCapture', operationId: session.operation.id, path: session.path,
      ...(endpointId ? { endpointId } : {})
    }, ['captureStarted', 'error'])
  }

  private async startHelper(manual: boolean): Promise<void> {
    if (manual) this.restartUsed = false
    if (this.helperInitialization) return this.helperInitialization
    const attempt = this.initializeHelper().finally(() => {
      if (this.helperInitialization === attempt) this.helperInitialization = undefined
    })
    this.helperInitialization = attempt
    return attempt
  }

  private async initializeHelper(): Promise<void> {
    if (!await this.helper.start()) return
    try {
      await this.configureShortcut(this.settings.settings.listenShortcut)
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : 'The listening toggle shortcut could not be configured.'
      await this.helper.stopProcess()
      this.helper.setFailure(message)
      this.warning = message
      this.notify()
      return
    }
    try {
      await this.refreshDevices()
    } catch (error) {
      this.devices = []
      this.warning = error instanceof Error && error.message
        ? `Audio devices could not be enumerated: ${error.message}`
        : 'Audio devices could not be enumerated. The Windows default output will be tried.'
      this.notify()
    }
  }

  private async recoverHelper(): Promise<void> {
    const active = this.operations.current
    if (active?.kind === 'audio') {
      const error = operationError('helper_unavailable', 'Windows audio helper stopped unexpectedly.', true)
      this.report(error)
      await this.operations.finish(active.id, 'error', error)
      return
    }
    if (this.restartUsed || this.disposed) {
      this.report(operationError('helper_unavailable', 'Windows audio helper stopped again. Use Retry after checking the installation.', true))
      return
    }
    this.restartUsed = true
    await new Promise((resolve) => setTimeout(resolve, 500))
    await this.startHelper(false)
    if (!this.helper.available) this.report(operationError('helper_unavailable', 'Windows audio helper could not be restarted.', true))
  }

  private report(error: AiErrorInfo): void { this.onError?.(error); this.notify() }
  private notify(): void { this.onState?.() }
  private tempDirectory(): string { return this.options.temporaryDirectory?.() ?? join(app.getPath('temp'), 'PresenterAI-audio') }
  private async deleteAudio(path: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(path, { force: true })
        try { await stat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
          throw error
        }
      } catch { /* retry after the helper/file handle has had a chance to close */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  private async deleteSessionAudio(session: CaptureSession, required = false): Promise<void> {
    const deleted = await this.deleteAudio(session.path)
    session.filePresent = !deleted
    this.orphanedAudioPath = deleted ? (this.orphanedAudioPath === session.path ? undefined : this.orphanedAudioPath) : session.path
    if (!deleted) this.warning = 'PresenterAI could not delete its temporary WAV. Close applications that may be scanning the file, then restart PresenterAI to retry stale-file cleanup.'
    this.notify()
    if (!deleted && required) {
      throw operationError('invalid_audio', 'PresenterAI could not delete its temporary WAV, so no document or model processing was allowed to continue.', false)
    }
  }

  private async ensureHelperTerminal(session: CaptureSession): Promise<void> {
    if (!session.captureCommandIssued || session.helperTerminal) return
    if (!this.helper.available) { session.helperTerminal = true; return }
    try {
      const terminal = await this.helper.command(
        { type: 'cancel', operationId: session.operation.id },
        ['captureCancelled', 'error'],
        5_000
      )
      validateOperationEvent(terminal, session.operation.id)
      session.helperTerminal = true
      this.helper.setLifecycle('ready')
    } catch (error) {
      if (error instanceof HelperClientError && error.code === 'duplicate_terminal') {
        // Protocol v2 records terminal operations before replying. A concurrent
        // stop may therefore win the race and make this cleanup cancel
        // redundant; duplicate_terminal is positive proof that capture ended.
        session.helperTerminal = true
        this.helper.setLifecycle('ready')
        return
      }
      // A timed-out/invalid start may still become active after the UI has
      // moved on. Terminating the sidecar is the only definitive way to prove
      // WASAPI capture has stopped when no matching terminal event arrives.
      await this.helper.stopProcess()
      session.helperTerminal = true
    }
  }

  private async cleanupStale(): Promise<void> {
    const directory = this.tempDirectory()
    await mkdir(directory, { recursive: true })
    for (const file of await readdir(directory)) {
      if (!file.toLocaleLowerCase('en-US').endsWith('.wav')) continue
      const path = join(directory, file)
      try {
        const info = await lstat(path)
        if (info.isFile() && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { force: true })
      } catch { /* another process may have removed or locked a stale file */ }
    }
  }
}

function parseDevices(value: unknown): AudioDevice[] {
  if (!Array.isArray(value)) return []
  return value.map((device) => {
    const item = device as Record<string, unknown>
    return { id: String(item.id), name: String(item.name), isDefault: Boolean(item.isDefault) }
  }).filter((device) => device.id !== 'undefined' && device.name !== 'undefined')
}

function endpointFromEvent(event: HelperEvent, devices: AudioDevice[]): AudioDevice {
  const id = String(event.endpointId)
  const name = String(event.endpointName)
  if (!id || id === 'undefined' || !name || name === 'undefined') throw operationError('invalid_audio', 'The Windows helper returned invalid endpoint metadata.', true)
  return { id, name, isDefault: devices.find((device) => device.id === id)?.isDefault ?? false }
}

function captureResult(event: HelperEvent, expectedPath: string): AudioCaptureResult {
  const terminalReason = String(event.terminalReason)
  const result: AudioCaptureResult = {
    path: String(event.path), durationMs: Number(event.durationMs), bytes: Number(event.bytes), sampleRate: Number(event.sampleRate),
    channels: Number(event.channels), endpointId: String(event.endpointId), endpointName: String(event.endpointName),
    terminalReason: terminalReason as AudioCaptureResult['terminalReason']
  }
  if (resolve(result.path) !== resolve(expectedPath) || !result.endpointId || result.endpointId === 'undefined' ||
      !result.endpointName || result.endpointName === 'undefined' || !['released', 'maximum_duration', 'maximum_size', 'stopped'].includes(terminalReason) ||
      !Number.isFinite(result.durationMs) || result.durationMs < 250 || result.durationMs > 90_000 ||
      !Number.isFinite(result.bytes) || result.bytes <= 44 || result.bytes > 3_100_000 ||
      result.sampleRate !== 16_000 || result.channels !== 1) {
    throw operationError('invalid_audio', 'The Windows helper returned invalid capture metadata.', true)
  }
  return result
}

function validateOperationEvent(event: HelperEvent, operationId: string): void {
  if (event.operationId !== operationId) throw operationError('invalid_audio', 'The Windows helper returned a stale capture event.', true)
}

function withoutPath(capture: AudioCaptureResult): Omit<AudioCaptureResult, 'path'> {
  const { path: _path, ...metadata } = capture
  return metadata
}

function isDeviceUnavailable(error: unknown): boolean {
  return error instanceof HelperClientError && ['device_unavailable', 'endpoint_not_found'].includes(error.code)
}

function mapCaptureError(error: unknown): AiErrorInfo {
  if (error instanceof HelperClientError) {
    if (isDeviceUnavailable(error)) return operationError('device_unavailable', error.message, true)
    if (error.code === 'invalid_audio') return operationError('invalid_audio', error.message, true)
    if (error.code === 'helper_timeout' || error.code === 'capture_timeout') return operationError('capture_timeout', error.message, true)
    return operationError('helper_unavailable', error.message, true)
  }
  return toOperationError(error)
}

function mapPipelineError(error: unknown): AiErrorInfo {
  // Finalization uses the same helper error vocabulary as startup. AI and
  // coordinator errors already carry an allowed application-level code.
  if (error instanceof HelperClientError) return mapCaptureError(error)
  return toOperationError(error)
}

function failure(code: AiErrorInfo['code'], message: string, retryable: boolean): OperationActionResult {
  return { ok: false, error: { code, message, retryable } }
}
