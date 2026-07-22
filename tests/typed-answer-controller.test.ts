// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AiService } from '../src/main/ai/service'
import { TypedAnswerController } from '../src/main/ai/typedAnswerController'
import { OperationCoordinator, operationError } from '../src/main/operations/coordinator'
import type { TransmissionPreviewGate } from '../src/main/privacy/transmissionPreview'
import type { AssistantResponse } from '../src/shared/contracts'

const response: AssistantResponse = {
  category: 'QUESTION', support: 'general-technical', evidenceIssue: 'none', say: 'A bounded response.',
  keyPoints: ['First point.', 'Second point.', 'Third point.'], ifChallenged: 'A bounded defence.', evidence: []
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function harness(present: TransmissionPreviewGate['present']) {
  const operations = new OperationCoordinator({ register: vi.fn(() => true), unregister: vi.fn() })
  const ai = {
    retrieve: vi.fn(() => []),
    generate: vi.fn(async () => response)
  }
  const preview = { present: vi.fn(present), clear: vi.fn() } as unknown as TransmissionPreviewGate
  return { operations, ai, preview, controller: new TypedAnswerController(ai as unknown as AiService, operations, preview) }
}

describe('typed answer outbound preview orchestration', () => {
  it('does not dispatch response generation until the current preview is acknowledged', async () => {
    const acknowledged = deferred<void>()
    const h = harness(async () => acknowledged.promise)
    const pending = h.controller.ask('Explain eventual consistency.')
    await vi.waitFor(() => expect(h.preview.present).toHaveBeenCalledOnce())
    expect(h.ai.generate).not.toHaveBeenCalled()
    acknowledged.resolve()
    await expect(pending).resolves.toEqual({ ok: true, response })
    expect(h.ai.generate).toHaveBeenCalledOnce()
    expect(h.preview.clear).toHaveBeenCalledOnce()
  })

  it('passes the validated per-request Code override through the preview pipeline', async () => {
    const h = harness(async () => undefined)
    await expect(h.controller.ask('Explain eventual consistency.', 'code')).resolves.toEqual({ ok: true, response })
    expect(h.ai.generate).toHaveBeenCalledWith(
      'Explain eventual consistency.',
      [],
      expect.objectContaining({ answerFormat: 'code', signal: expect.any(AbortSignal) })
    )
  })

  it('never dispatches generation after preview timeout or cancellation', async () => {
    const unavailable = harness(async () => { throw operationError('privacy_preview_unavailable', 'Preview unavailable.', true) })
    await expect(unavailable.controller.ask('Explain caching.')).resolves.toMatchObject({
      ok: false, error: { code: 'privacy_preview_unavailable' }
    })
    expect(unavailable.ai.generate).not.toHaveBeenCalled()

    const pendingPreview = deferred<void>()
    const cancelled = harness(async () => pendingPreview.promise)
    const pending = cancelled.controller.ask('Explain cancellation.')
    await vi.waitFor(() => expect(cancelled.preview.present).toHaveBeenCalledOnce())
    await cancelled.operations.cancel()
    pendingPreview.resolve()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(cancelled.ai.generate).not.toHaveBeenCalled()
  })
})
