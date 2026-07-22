import { describe, expect, it, vi } from 'vitest'
import { OperationCoordinator } from '../src/main/operations/coordinator'

function harness() {
  let now = 0
  let escape: (() => void) | undefined
  const shortcuts = {
    register: vi.fn((_key: string, callback: () => void) => { escape = callback; return true }),
    unregister: vi.fn()
  }
  const coordinator = new OperationCoordinator(shortcuts, {
    now: () => now,
    isoNow: () => `time-${now}`
  })
  return { coordinator, shortcuts, tick: (milliseconds: number) => { now += milliseconds }, escape: () => escape?.() }
}

describe('operation coordinator', () => {
  it('owns one operation, records real stages, and cleans up exactly once', async () => {
    const { coordinator, shortcuts, tick } = harness()
    const cleanup = vi.fn()
    const operation = coordinator.begin('audio', 'starting_capture')
    coordinator.registerCleanup(operation.id, cleanup)
    tick(20); coordinator.transition(operation.id, 'listening')
    tick(300); coordinator.transition(operation.id, 'finalizing')
    tick(40); coordinator.transition(operation.id, 'transcribing')
    tick(100)
    const rendered = coordinator.waitForAnswerVisible(operation.id)
    coordinator.acknowledgeAnswerVisible(operation.id)
    await expect(rendered).resolves.toBe(true)
    await coordinator.finish(operation.id, 'success')
    await coordinator.finish(operation.id, 'success')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(shortcuts.unregister).toHaveBeenCalledWith('Escape')
    expect(coordinator.snapshot()).toMatchObject({
      operation: 'idle', answerRenderConfirmed: true, operationTimings: {
        captureStartMs: 20, listeningMs: 300, finalizationMs: 40, transcriptionMs: 100,
        stopToAnswerMs: 140, totalMs: 460
      }
    })
  })

  it('does not claim stop-to-visible timing when the renderer never acknowledges the answer', async () => {
    vi.useFakeTimers()
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(10); coordinator.transition(operation.id, 'listening')
    tick(100); coordinator.transition(operation.id, 'finalizing')
    const visible = coordinator.waitForAnswerVisible(operation.id, 50)
    await vi.advanceTimersByTimeAsync(50)
    await expect(visible).resolves.toBe(false)
    await coordinator.finish(operation.id, 'error', { code: 'timeout', message: 'Not visible.', retryable: true })
    expect(coordinator.snapshot()).toMatchObject({ answerRenderConfirmed: false })
    expect(coordinator.snapshot().operationTimings.stopToAnswerMs).toBeUndefined()
    vi.useRealTimers()
  })

  it('latches an answer-frame acknowledgement that arrives before the waiter is installed', async () => {
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(10); coordinator.transition(operation.id, 'listening')
    tick(100); coordinator.transition(operation.id, 'finalizing')
    tick(25); coordinator.acknowledgeAnswerVisible(operation.id)
    await expect(coordinator.waitForAnswerVisible(operation.id)).resolves.toBe(true)
    tick(500); await coordinator.finish(operation.id, 'success')
    expect(coordinator.snapshot().operationTimings.stopToAnswerMs).toBe(25)
  })

  it('keeps API generation timing separate from renderer acknowledgement latency', async () => {
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(10); coordinator.transition(operation.id, 'listening')
    tick(100); coordinator.transition(operation.id, 'finalizing')
    tick(10); coordinator.transition(operation.id, 'transcribing')
    tick(20); coordinator.transition(operation.id, 'retrieving')
    tick(5); coordinator.transition(operation.id, 'generating')
    tick(50); coordinator.completeCurrentStage(operation.id)
    const visible = coordinator.waitForAnswerVisible(operation.id)
    tick(400); coordinator.acknowledgeAnswerVisible(operation.id)
    await visible
    await coordinator.finish(operation.id, 'success')
    expect(coordinator.snapshot().operationTimings).toMatchObject({ generationMs: 50, stopToAnswerMs: 485 })
  })

  it('records stop-to-transcript and transcript render acknowledgement timing', async () => {
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(10); coordinator.transition(operation.id, 'listening')
    tick(100); coordinator.transition(operation.id, 'finalizing')
    tick(20); coordinator.transition(operation.id, 'transcribing')
    tick(80); coordinator.completeCurrentStage(operation.id)
    const visible = coordinator.waitForTranscriptVisible(operation.id)
    tick(25); coordinator.acknowledgeTranscriptVisible(operation.id)
    await expect(visible).resolves.toBe(true)
    await coordinator.finish(operation.id, 'success')
    expect(coordinator.snapshot()).toMatchObject({
      operation: 'idle', transcriptRenderConfirmed: true, transcriptRenderLatencyMs: 25,
      operationTimings: { transcriptionMs: 80, stopToTranscriptMs: 125, totalMs: 235 }
    })
  })

  it('fails transcript visibility closed and ignores late or stale acknowledgements', async () => {
    vi.useFakeTimers()
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(10); coordinator.transition(operation.id, 'listening')
    tick(100); coordinator.transition(operation.id, 'finalizing')
    tick(20); coordinator.transition(operation.id, 'transcribing')
    const visible = coordinator.waitForTranscriptVisible(operation.id, 50)
    coordinator.acknowledgeTranscriptVisible('stale-operation')
    await vi.advanceTimersByTimeAsync(50)
    await expect(visible).resolves.toBe(false)
    coordinator.acknowledgeTranscriptVisible(operation.id)
    await coordinator.finish(operation.id, 'error', {
      code: 'transcript_display_unavailable', message: 'Draft not visible.', retryable: true
    })
    expect(coordinator.snapshot()).toMatchObject({
      operation: 'error', transcriptRenderConfirmed: false, transcriptRenderLatencyMs: undefined
    })
    expect(coordinator.snapshot().operationTimings.stopToTranscriptMs).toBeUndefined()
    vi.useRealTimers()
  })

  it('rejects overlap and aborts through one cancellation handler', async () => {
    const { coordinator, escape } = harness()
    const operation = coordinator.begin('typed', 'retrieving')
    expect(() => coordinator.begin('audio', 'starting_capture')).toThrow(/already active/i)
    const cancel = vi.fn()
    coordinator.setCancelHandler(operation.id, cancel)
    escape(); await coordinator.cancel()
    expect(operation.signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(coordinator.snapshot().operation).toBe('cancelling')
    await coordinator.finish(operation.id, 'cancelled')
    expect(coordinator.snapshot().operation).toBe('idle')
  })

  it('ignores stale transitions and measures the first rendered listening frame', async () => {
    const { coordinator, tick } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    tick(15); coordinator.transition(operation.id, 'listening')
    tick(42); coordinator.acknowledgeListeningIndicator(operation.id)
    tick(20); coordinator.acknowledgeListeningIndicator(operation.id)
    expect(coordinator.snapshot().indicatorLatencyMs).toBe(42)
    await coordinator.finish(operation.id, 'success')
    expect(coordinator.transition(operation.id, 'generating')).toBe(false)
  })

  it('preserves a typed terminal error until the next operation', async () => {
    const { coordinator } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    await coordinator.finish(operation.id, 'error', { code: 'device_unavailable', message: 'Output disappeared.', retryable: true })
    expect(coordinator.snapshot()).toMatchObject({ operation: 'error', operationError: { code: 'device_unavailable' } })
    const next = coordinator.begin('typed', 'retrieving')
    expect(coordinator.snapshot().operationError).toBeUndefined()
    await coordinator.finish(next.id, 'success')
  })

  it('enforces the operation graph and never regresses after cancellation', async () => {
    const { coordinator } = harness()
    const operation = coordinator.begin('audio', 'starting_capture')
    expect(coordinator.transition(operation.id, 'generating')).toBe(false)
    expect(coordinator.snapshot().operation).toBe('starting_capture')
    await coordinator.cancel()
    expect(coordinator.snapshot().operation).toBe('cancelling')
    expect(coordinator.transition(operation.id, 'listening')).toBe(false)
    expect(coordinator.transition(operation.id, 'transcribing')).toBe(false)
    expect(coordinator.snapshot().operation).toBe('cancelling')
    await coordinator.finish(operation.id, 'cancelled')
  })

  it('aborts an in-flight signal before error cleanup', async () => {
    const { coordinator } = harness()
    const operation = coordinator.begin('typed', 'retrieving')
    const cleanup = vi.fn(() => expect(operation.signal.aborted).toBe(true))
    coordinator.registerCleanup(operation.id, cleanup)
    await coordinator.finish(operation.id, 'error', { code: 'offline', message: 'Offline.', retryable: true })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('acknowledges only the current operation and transmission stage', async () => {
    const { coordinator } = harness()
    const operation = coordinator.begin('typed', 'retrieving')
    const preview = coordinator.waitForTransmissionPreview(operation.id, 'response')
    coordinator.acknowledgeTransmissionPreview('stale-operation', 'response')
    coordinator.acknowledgeTransmissionPreview(operation.id, 'transcription')
    coordinator.acknowledgeTransmissionPreview(operation.id, 'response')
    await expect(preview).resolves.toBe(true)
    await coordinator.finish(operation.id, 'success')
  })

  it('fails a transmission preview closed on timeout or cancellation', async () => {
    vi.useFakeTimers()
    const { coordinator } = harness()
    const operation = coordinator.begin('typed', 'retrieving')
    const timeout = coordinator.waitForTransmissionPreview(operation.id, 'response', 50)
    await vi.advanceTimersByTimeAsync(50)
    await expect(timeout).resolves.toBe(false)
    await coordinator.finish(operation.id, 'error')

    const cancelled = coordinator.begin('audio', 'starting_capture')
    const waiting = coordinator.waitForTransmissionPreview(cancelled.id, 'transcription', 500)
    await coordinator.cancel()
    await expect(waiting).resolves.toBe(false)
    await coordinator.finish(cancelled.id, 'cancelled')
    vi.useRealTimers()
  })
})
