import { randomUUID } from 'node:crypto'
import type {
  AiErrorInfo, OperationKind, OperationState, OperationTimings
} from '../../shared/contracts.js'

export interface OperationHandle {
  id: string
  kind: OperationKind
  signal: AbortSignal
}

export type TransmissionStage = 'transcription' | 'response'

export interface OperationSnapshot {
  operation: OperationState
  operationId?: string
  operationKind?: OperationKind
  operationStartedAt?: string
  stageStartedAt?: string
  operationTimings: OperationTimings
  indicatorLatencyMs?: number
  answerRenderConfirmed?: boolean
  operationError?: AiErrorInfo
  escapeWarning?: string
}

interface ShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

interface Clock {
  now(): number
  isoNow(): string
}

interface ActiveOperation {
  id: string
  kind: OperationKind
  controller: AbortController
  stage: OperationState
  startedAt: number
  startedAtIso: string
  stageStartedAt: number
  stageStartedAtIso: string
  stageOpen: boolean
  timings: OperationTimings
  cleanups: Array<() => void | Promise<void>>
  cancelHandler?: () => void | Promise<void>
  cancelling?: Promise<void>
  terminal?: Promise<void>
  captureConfirmedAt?: number
  releasedAt?: number
  indicatorLatencyMs?: number
  answerRenderConfirmed?: boolean
  answerVisibleAt?: number
  answerVisibility?: { promise: Promise<boolean>; confirm(): void }
  transmissionVisibility?: {
    stage: TransmissionStage
    promise: Promise<boolean>
    confirm(): void
  }
}

const timingField: Partial<Record<OperationState, keyof OperationTimings>> = {
  starting_capture: 'captureStartMs',
  listening: 'listeningMs',
  finalizing: 'finalizationMs',
  transcribing: 'transcriptionMs',
  retrieving: 'retrievalMs',
  generating: 'generationMs'
}

const allowedNextStages: Partial<Record<OperationState, ReadonlySet<OperationState>>> = {
  starting_capture: new Set(['listening', 'finalizing', 'cancelling']),
  listening: new Set(['finalizing', 'cancelling']),
  finalizing: new Set(['transcribing', 'cancelling']),
  transcribing: new Set(['retrieving', 'cancelling']),
  retrieving: new Set(['generating', 'cancelling']),
  generating: new Set(['cancelling'])
}

const systemClock: Clock = {
  now: () => performance.now(),
  isoNow: () => new Date().toISOString()
}

export class OperationCoordinator {
  private active?: ActiveOperation
  private maintenanceReserved = false
  private displayState: OperationState = 'idle'
  private lastTimings: OperationTimings = {}
  private lastIndicatorLatencyMs?: number
  private lastAnswerRenderConfirmed?: boolean
  private lastError?: AiErrorInfo
  private lastKind?: OperationKind
  private escapeWarning?: string
  onChange?: () => void

  constructor(
    private shortcuts: ShortcutAdapter,
    private clock: Clock = systemClock
  ) {}

  get isBusy(): boolean { return Boolean(this.active) || this.maintenanceReserved }

  get current(): OperationHandle | undefined {
    const operation = this.active
    return operation && { id: operation.id, kind: operation.kind, signal: operation.controller.signal }
  }

  begin(kind: OperationKind, initialStage: OperationState): OperationHandle {
    if (this.active || this.maintenanceReserved) throw operationError('busy', 'Another PresenterAI operation is already active.', false)
    const now = this.clock.now()
    const operation: ActiveOperation = {
      id: randomUUID(), kind, controller: new AbortController(), stage: initialStage,
      startedAt: now, startedAtIso: this.clock.isoNow(), stageStartedAt: now, stageStartedAtIso: this.clock.isoNow(),
      stageOpen: true, timings: {}, cleanups: []
    }
    this.active = operation
    this.lastKind = kind
    this.displayState = initialStage
    this.lastError = undefined
    this.lastTimings = {}
    this.lastIndicatorLatencyMs = undefined
    this.lastAnswerRenderConfirmed = undefined
    this.escapeWarning = this.shortcuts.register('Escape', () => { void this.cancel() })
      ? undefined
      : 'Esc could not be registered globally; use Cancel in PresenterAI.'
    this.emit()
    return { id: operation.id, kind, signal: operation.controller.signal }
  }

  transition(id: string, stage: OperationState): boolean {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return false
    if (operation.controller.signal.aborted && stage !== 'cancelling') return false
    if (!allowedNextStages[operation.stage]?.has(stage)) return false
    this.closeStage(operation)
    operation.stage = stage
    operation.stageStartedAt = this.clock.now()
    operation.stageStartedAtIso = this.clock.isoNow()
    operation.stageOpen = true
    if (stage === 'listening') operation.captureConfirmedAt = operation.stageStartedAt
    if (stage === 'finalizing' && operation.releasedAt === undefined) operation.releasedAt = operation.stageStartedAt
    this.displayState = stage
    this.emit()
    return true
  }

  completeCurrentStage(id: string): boolean {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal || !operation.stageOpen) return false
    this.closeStage(operation)
    this.emit()
    return true
  }

  registerCleanup(id: string, cleanup: () => void | Promise<void>): boolean {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return false
    operation.cleanups.push(cleanup)
    return true
  }

  setCancelHandler(id: string, handler: () => void | Promise<void>): boolean {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return false
    operation.cancelHandler = handler
    return true
  }

  async cancel(): Promise<void> {
    const operation = this.active
    if (!operation) {
      if (this.displayState === 'error') { this.displayState = 'idle'; this.lastError = undefined; this.emit() }
      return
    }
    if (operation.cancelling) return operation.cancelling
    operation.controller.abort()
    this.transition(operation.id, 'cancelling')
    operation.cancelling = Promise.resolve(operation.cancelHandler?.()).then(() => undefined)
    return operation.cancelling
  }

  async finish(id: string, outcome: 'success' | 'cancelled' | 'error', error?: AiErrorInfo): Promise<void> {
    const operation = this.active
    if (!operation || operation.id !== id) return
    if (operation.terminal) return operation.terminal
    operation.terminal = (async () => {
      if (outcome !== 'success' && !operation.controller.signal.aborted) operation.controller.abort()
      this.closeStage(operation)
      operation.timings.totalMs = Math.max(0, this.clock.now() - operation.startedAt)
      if (operation.releasedAt !== undefined) {
        if (operation.answerRenderConfirmed && operation.answerVisibleAt !== undefined) {
          operation.timings.releaseToAnswerMs = Math.max(0, operation.answerVisibleAt - operation.releasedAt)
        }
      }
      for (const cleanup of [...operation.cleanups].reverse()) {
        try { await cleanup() } catch { /* terminal cleanup is best effort and each resource is independently owned */ }
      }
      if (this.active?.id !== id) return
      this.shortcuts.unregister('Escape')
      this.lastTimings = { ...operation.timings }
      this.lastIndicatorLatencyMs = operation.indicatorLatencyMs
      this.lastAnswerRenderConfirmed = operation.answerRenderConfirmed
      this.active = undefined
      this.lastError = outcome === 'error' ? error ?? operationError('unknown', 'The operation failed.', false) : undefined
      this.displayState = outcome === 'error' ? 'error' : 'idle'
      this.emit()
    })()
    return operation.terminal
  }

  acknowledgeListeningIndicator(id: string): void {
    const operation = this.active
    if (!operation || operation.id !== id || operation.captureConfirmedAt === undefined || operation.indicatorLatencyMs !== undefined) return
    operation.indicatorLatencyMs = Math.max(0, this.clock.now() - operation.captureConfirmedAt)
    this.emit()
  }

  waitForAnswerVisible(id: string, timeoutMs = 10_000): Promise<boolean> {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return Promise.resolve(false)
    if (operation.answerRenderConfirmed) return Promise.resolve(true)
    if (operation.answerVisibility) return operation.answerVisibility.promise
    let confirm!: () => void
    const promise = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (confirmed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        operation.controller.signal.removeEventListener('abort', abort)
        operation.answerRenderConfirmed = confirmed
        resolve(confirmed)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      const abort = (): void => finish(false)
      confirm = () => finish(true)
      if (operation.controller.signal.aborted) abort()
      else operation.controller.signal.addEventListener('abort', abort, { once: true })
    })
    operation.answerVisibility = { promise, confirm }
    return promise
  }

  acknowledgeAnswerVisible(id: string): void {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal || operation.answerRenderConfirmed) return
    operation.answerRenderConfirmed = true
    operation.answerVisibleAt = this.clock.now()
    operation.answerVisibility?.confirm()
    this.emit()
  }

  acquireMaintenance(): () => void {
    if (this.active || this.maintenanceReserved) {
      throw operationError('busy', 'Another PresenterAI operation is already active.', false)
    }
    this.maintenanceReserved = true
    this.emit()
    let released = false
    return () => {
      if (released) return
      released = true
      this.maintenanceReserved = false
      this.emit()
    }
  }

  waitForTransmissionPreview(id: string, stage: TransmissionStage, timeoutMs = 2_000): Promise<boolean> {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return Promise.resolve(false)
    if (operation.transmissionVisibility?.stage === stage) return operation.transmissionVisibility.promise
    let confirm!: () => void
    const promise = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (confirmed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        operation.controller.signal.removeEventListener('abort', abort)
        resolve(confirmed)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      const abort = (): void => finish(false)
      confirm = () => finish(true)
      if (operation.controller.signal.aborted) abort()
      else operation.controller.signal.addEventListener('abort', abort, { once: true })
    })
    operation.transmissionVisibility = { stage, promise, confirm }
    return promise
  }

  acknowledgeTransmissionPreview(id: string, stage: TransmissionStage): void {
    const operation = this.active
    if (!operation || operation.id !== id || operation.terminal) return
    if (operation.transmissionVisibility?.stage !== stage) return
    operation.transmissionVisibility.confirm()
  }

  isCurrent(id: string): boolean { return this.active?.id === id }

  snapshot(): OperationSnapshot {
    const operation = this.active
    return {
      operation: operation?.stage ?? this.displayState,
      operationId: operation?.id,
      operationKind: operation?.kind ?? (this.displayState === 'error' ? this.lastKind : undefined),
      operationStartedAt: operation?.startedAtIso,
      stageStartedAt: operation?.stageStartedAtIso,
      operationTimings: { ...(operation?.timings ?? this.lastTimings) },
      indicatorLatencyMs: operation?.indicatorLatencyMs ?? this.lastIndicatorLatencyMs,
      answerRenderConfirmed: operation?.answerRenderConfirmed ?? this.lastAnswerRenderConfirmed,
      operationError: this.lastError,
      escapeWarning: this.escapeWarning
    }
  }

  private closeStage(operation: ActiveOperation): void {
    if (!operation.stageOpen) return
    const field = timingField[operation.stage]
    if (field) operation.timings[field] = (operation.timings[field] ?? 0) + Math.max(0, this.clock.now() - operation.stageStartedAt)
    operation.stageOpen = false
  }

  private emit(): void { this.onChange?.() }
}

export function operationError(code: AiErrorInfo['code'], message: string, retryable: boolean): AiErrorInfo & Error {
  return Object.assign(new Error(message), { code, retryable })
}

export function toOperationError(error: unknown): AiErrorInfo {
  const value = error as Partial<AiErrorInfo> & { message?: string }
  return {
    code: value.code && isOperationCode(value.code) ? value.code : 'unknown',
    message: typeof value.message === 'string' && value.message ? value.message.slice(0, 800) : 'The operation failed.',
    retryable: Boolean(value.retryable)
  }
}

function isOperationCode(code: string): code is AiErrorInfo['code'] {
  return [
    'invalid_key', 'quota', 'rate_limit', 'timeout', 'offline', 'cancelled', 'output_limit', 'malformed_response',
    'busy', 'helper_unavailable', 'device_unavailable', 'invalid_audio', 'invalid_transcript', 'capture_timeout',
    'listening_consent_required', 'privacy_preview_unavailable', 'unknown'
  ].includes(code)
}
