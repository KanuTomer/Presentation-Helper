import type { AiErrorInfo, AnswerFormat, AskResult } from '../../shared/contracts.js'
import { operationError, toOperationError, type OperationCoordinator } from '../operations/coordinator.js'
import {
  buildResponseTransmissionPreview, type TransmissionPreviewGate
} from '../privacy/transmissionPreview.js'
import type { AiService } from './service.js'

export class TypedAnswerController {
  constructor(
    private ai: AiService,
    private operations: OperationCoordinator,
    private preview: TransmissionPreviewGate
  ) {}

  async ask(question: string, answerFormat: AnswerFormat = 'auto'): Promise<AskResult> {
    let operation
    try { operation = this.operations.begin('typed', 'retrieving') }
    catch (error) { return { ok: false, error: toOperationError(error) } }
    let terminalError: AiErrorInfo | undefined
    try {
      this.operations.registerCleanup(operation.id, () => this.preview.clear(operation.id))
      const chunks = this.ai.retrieve(question, { signal: operation.signal })
      await this.preview.present(buildResponseTransmissionPreview(operation.id, chunks))
      if (!this.operations.isCurrent(operation.id) || operation.signal.aborted) {
        throw operationError('cancelled', 'Operation cancelled.', false)
      }
      this.operations.transition(operation.id, 'generating')
      const response = await this.ai.generate(question, chunks, { signal: operation.signal, answerFormat })
      return { ok: true, response }
    } catch (error) {
      terminalError = toOperationError(error)
      return { ok: false, error: terminalError }
    } finally {
      await this.operations.finish(
        operation.id,
        operation.signal.aborted || terminalError?.code === 'cancelled'
          ? 'cancelled'
          : terminalError ? 'error' : 'success',
        terminalError
      )
    }
  }
}
