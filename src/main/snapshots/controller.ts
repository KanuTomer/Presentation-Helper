import type { AskResult, AiErrorInfo, SnapshotPreview } from '../../shared/contracts.js'
import type { AiService } from '../ai/service.js'
import { SNAPSHOT_QUESTION } from '../ai/snapshotPrompt.js'
import { operationError, toOperationError, type OperationCoordinator } from '../operations/coordinator.js'
import type { SnapshotStore } from './store.js'
import { buildResponseTransmissionPreview, type TransmissionPreviewGate } from '../privacy/transmissionPreview.js'

export class SnapshotController {
  constructor(readonly frames: SnapshotStore, private ai: AiService, private operations: OperationCoordinator, private preview: TransmissionPreviewGate) {}
  async capture(monitorId?: string): Promise<SnapshotPreview> {
    const operation = this.operations.begin('snapshot', 'retrieving')
    let failure: AiErrorInfo | undefined
    try { return await this.frames.capture(monitorId, operation.signal) }
    catch (error) { failure = toOperationError(error); this.frames.clear(); throw error }
    finally { await this.operations.finish(operation.id, operation.signal.aborted ? 'cancelled' : failure ? 'error' : 'success', failure) }
  }
  async solve(id: string): Promise<AskResult> {
    let operation
    try { operation = this.operations.begin('snapshot', 'retrieving') }
    catch (error) { return { ok: false, error: toOperationError(error) } }
    let failure: AiErrorInfo | undefined
    try {
      this.operations.registerCleanup(operation.id, () => this.frames.clear())
      this.operations.registerCleanup(operation.id, () => this.preview.clear(operation.id))
      const frame = this.frames.get(id)
      const chunks = this.ai.retrieveSnapshot(SNAPSHOT_QUESTION, operation.signal)
      await this.preview.present(buildResponseTransmissionPreview(operation.id, chunks))
      if (operation.signal.aborted || !this.operations.isCurrent(operation.id)) throw operationError('cancelled', 'Operation cancelled.', false)
      this.operations.transition(operation.id, 'generating')
      const response = await this.ai.generate(SNAPSHOT_QUESTION, chunks, { signal: operation.signal, snapshotDataUrl: frame.dataUrl })
      return { ok: true, response }
    } catch (error) { failure = operation.signal.aborted ? { code: 'cancelled', message: 'Operation cancelled.', retryable: false } : toOperationError(error); return { ok: false, error: failure } }
    finally { await this.operations.finish(operation.id, operation.signal.aborted ? 'cancelled' : failure ? 'error' : 'success', failure) }
  }
}
