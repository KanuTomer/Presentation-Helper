import type { OutboundTransmissionPreview } from '../../shared/contracts.js'
import { preparedAnswerFromChunks } from '../ai/preparedAnswer.js'
import { OperationCoordinator, operationError } from '../operations/coordinator.js'
import type { RetrievedChunk } from '../retrieval/index.js'

export interface TransmissionPreviewGateOptions {
  showOverlay(): void
  onChange(): void
  timeoutMs?: number
}

/**
 * Owns the renderer-visible outbound preview without granting the renderer
 * authority to dispatch a network request. The operation coordinator accepts
 * only an acknowledgement for the current operation and current stage.
 */
export class TransmissionPreviewGate {
  private active?: OutboundTransmissionPreview

  constructor(
    private operations: OperationCoordinator,
    private options: TransmissionPreviewGateOptions
  ) {}

  get current(): OutboundTransmissionPreview | undefined {
    return this.active ? structuredClone(this.active) : undefined
  }

  async present(preview: OutboundTransmissionPreview): Promise<void> {
    const operation = this.operations.current
    if (!operation || operation.id !== preview.operationId || operation.signal.aborted) {
      throw operationError('cancelled', 'Operation cancelled.', false)
    }
    const rendered = this.operations.waitForTransmissionPreview(
      preview.operationId,
      preview.stage,
      this.options.timeoutMs ?? 2_000
    )
    this.active = structuredClone(preview)
    this.options.showOverlay()
    this.options.onChange()
    if (!await rendered) {
      throw operationError(
        'privacy_preview_unavailable',
        'PresenterAI could not confirm that the outbound data preview became visible, so nothing was sent.',
        true
      )
    }
  }

  acknowledge(operationId: string, stage: OutboundTransmissionPreview['stage']): void {
    if (this.active?.operationId !== operationId || this.active.stage !== stage) return
    this.operations.acknowledgeTransmissionPreview(operationId, stage)
  }

  clear(operationId?: string): void {
    if (!this.active || (operationId && this.active.operationId !== operationId)) return
    this.active = undefined
    this.options.onChange()
  }
}

export function buildResponseTransmissionPreview(
  operationId: string,
  chunks: readonly RetrievedChunk[]
): OutboundTransmissionPreview {
  const prepared = preparedAnswerFromChunks(chunks)
  const selected = prepared?.chunks ?? chunks
  return {
    operationId,
    stage: 'response',
    chunks: selected.map((chunk) => ({
      chunkId: chunk.id,
      documentName: chunk.documentName,
      ...(chunk.title ? { title: chunk.title } : {}),
      location: chunk.location,
      text: chunk.text
    })),
    rollingTurnCount: prepared?.rollingTurnCount ?? 0,
    includesProjectSummary: Boolean(prepared?.projectSummary)
  }
}

export function buildTranscriptionTransmissionPreview(
  operationId: string,
  audio: { durationMs: number; bytes: number; endpointName: string },
  terminologyHint: string
): OutboundTransmissionPreview {
  return {
    operationId,
    stage: 'transcription',
    audio: { ...audio },
    ...(terminologyHint ? { terminologyHint } : {}),
    chunks: [],
    rollingTurnCount: 0,
    includesProjectSummary: false
  }
}
