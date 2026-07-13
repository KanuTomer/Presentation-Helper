export interface DocumentChunk {
  id: string
  documentId: string
  text: string
  pageOrSlide?: number
  section?: string
  kind: 'slide' | 'speakerNotes' | 'pdfPage' | 'markdown' | 'text'
}
