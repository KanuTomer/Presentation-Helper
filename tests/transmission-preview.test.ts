// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OperationCoordinator } from '../src/main/operations/coordinator'
import { TransmissionPreviewGate } from '../src/main/privacy/transmissionPreview'

function harness(timeoutMs = 25) {
  const shortcuts = { register: vi.fn(() => true), unregister: vi.fn() }
  const operations = new OperationCoordinator(shortcuts)
  const showOverlay = vi.fn()
  const onChange = vi.fn()
  const gate = new TransmissionPreviewGate(operations, { showOverlay, onChange, timeoutMs })
  return { operations, gate, showOverlay, onChange }
}

function responsePreview(operationId: string) {
  return {
    operationId, stage: 'response' as const, chunks: [], rollingTurnCount: 0,
    includesProjectSummary: false
  }
}

describe('outbound transmission preview gate', () => {
  it('publishes before dispatch authority is granted and accepts only the current stage acknowledgement', async () => {
    const h = harness()
    const operation = h.operations.begin('typed', 'retrieving')
    const pending = h.gate.present(responsePreview(operation.id))
    expect(h.gate.current).toEqual(responsePreview(operation.id))
    expect(h.showOverlay).toHaveBeenCalledOnce()
    h.gate.acknowledge('stale', 'response')
    h.gate.acknowledge(operation.id, 'transcription')
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.gate.acknowledge(operation.id, 'response')
    await expect(pending).resolves.toBeUndefined()
    h.gate.clear(operation.id)
    expect(h.gate.current).toBeUndefined()
  })

  it('fails closed on timeout and cancellation', async () => {
    vi.useFakeTimers()
    const timedOut = harness(2_000)
    const first = timedOut.operations.begin('typed', 'retrieving')
    const timeout = timedOut.gate.present(responsePreview(first.id))
    const timeoutRejection = expect(timeout).rejects.toMatchObject({ code: 'privacy_preview_unavailable' })
    await vi.advanceTimersByTimeAsync(2_000)
    await timeoutRejection
    await timedOut.operations.finish(first.id, 'error')

    const cancelled = harness(2_000)
    const second = cancelled.operations.begin('typed', 'retrieving')
    const pending = cancelled.gate.present(responsePreview(second.id))
    const cancellationRejection = expect(pending).rejects.toMatchObject({ code: 'privacy_preview_unavailable' })
    await cancelled.operations.cancel()
    await cancellationRejection
    vi.useRealTimers()
  })
})
