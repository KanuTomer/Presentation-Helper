import {
  documentIdSchema, documentInspectionRequestSchema, documentSearchQuerySchema
} from '../../shared/contracts.js'

export const DOCUMENT_INSPECTION_PAGE_SIZE = 50
export const DOCUMENT_INSPECTION_REQUEST_LIMIT = 100

export function parseDocumentId(value: unknown): string {
  return documentIdSchema.parse(value)
}

export function parseDocumentSearchQuery(value: unknown): string {
  return documentSearchQuerySchema.parse(value)
}

export function parseDocumentInspectionRequest(value: unknown): { documentId: string; offset: number; limit: number } {
  const parsed = documentInspectionRequestSchema.parse(value)
  return { ...parsed, limit: Math.min(parsed.limit, DOCUMENT_INSPECTION_PAGE_SIZE) }
}
