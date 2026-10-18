import type { AskResult, AiErrorInfo, ScreenshotAttachment } from '../../shared/contracts.js'
import type { AiService } from '../ai/service.js'
import { snapshotQuestion } from '../ai/snapshotPrompt.js'
import { operationError, toOperationError, type OperationCoordinator } from '../operations/coordinator.js'
import type { SnapshotStore } from './store.js'
import { buildResponseTransmissionPreview, type TransmissionPreviewGate } from '../privacy/transmissionPreview.js'

export class SnapshotController {
  constructor(readonly frames: SnapshotStore, private ai: AiService, private operations: OperationCoordinator, private preview: TransmissionPreviewGate) {}

  /** Captures the presenter's monitor now and keeps it in memory until sent, removed, or expired. */
  async attach(): Promise<ScreenshotAttachment> {
    const frame = await this.frames.capture(undefined, new AbortController().signal)
    return { id: frame.id, expiresAt: frame.expiresAt }
  }

  /**
   * Sends the attached screenshot with the typed question. The image never
   * reaches the renderer and is cleared when the operation ends.
   */
  async ask(typedQuestion: string, attachmentId: string): Promise<AskResult> {
    let operation
    try { operation = this.operations.begin('snapshot', 'retrieving') }
    catch (error) { return { ok: false, error: toOperationError(error) } }
    let failure: AiErrorInfo | undefined
    try {
      this.operations.registerCleanup(operation.id, () => this.frames.clear())
      this.operations.registerCleanup(operation.id, () => this.preview.clear(operation.id))
      const frame = this.frames.get(attachmentId)
      const question = snapshotQuestion(typedQuestion)
      const chunks = this.ai.retrieveSnapshot(question, operation.signal)
      await this.preview.present(buildResponseTransmissionPreview(operation.id, chunks, { screenshot: true }))
      if (operation.signal.aborted || !this.operations.isCurrent(operation.id)) throw operationError('cancelled', 'Operation cancelled.', false)
      this.operations.transition(operation.id, 'generating')
      const response = await this.ai.generate(question, chunks, { signal: operation.signal, snapshotDataUrl: frame.dataUrl })
      return { ok: true, response }
    } catch (error) { failure = operation.signal.aborted ? { code: 'cancelled', message: 'Operation cancelled.', retryable: false } : toOperationError(error); return { ok: false, error: failure } }
    finally { await this.operations.finish(operation.id, operation.signal.aborted ? 'cancelled' : failure ? 'error' : 'success', failure) }
  }
}
