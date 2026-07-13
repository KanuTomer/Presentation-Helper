export type DocumentChunkKind = 'slide' | 'speakerNotes' | 'pdfPage' | 'markdown' | 'text'

export interface DocumentChunk {
  id: string
  documentId: string
  text: string
  pageOrSlide?: number
  section?: string
  title?: string
  kind: DocumentChunkKind
  /** One-based position of this chunk within its source slide, page, notes, or section. */
  part: number
  /** Total number of chunks emitted for the source slide, page, notes, or section. */
  partCount: number
}

export type DocumentErrorCode =
  | 'unsupported_type'
  | 'unreadable'
  | 'malformed'
  | 'encrypted'
  | 'password_protected'
  | 'empty'

export class DocumentParseError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentParseError'
  }
}
