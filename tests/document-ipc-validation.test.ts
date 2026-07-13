import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_INSPECTION_PAGE_SIZE, parseDocumentId, parseDocumentInspectionRequest, parseDocumentSearchQuery
} from '../src/main/ipc/documentValidation'

describe('document IPC validation', () => {
  it('normalizes bounded search queries and document IDs', () => {
    expect(parseDocumentSearchQuery('  SQLite FTS5  ')).toBe('SQLite FTS5')
    expect(parseDocumentId('doc-1')).toBe('doc-1')
    expect(() => parseDocumentSearchQuery('x'.repeat(501))).toThrow()
    expect(() => parseDocumentId({ id: 'doc-1' })).toThrow()
  })

  it('accepts a hard maximum of one hundred but clamps every page to fifty', () => {
    expect(parseDocumentInspectionRequest({ documentId: 'doc-1', offset: 50, limit: 100 })).toEqual({
      documentId: 'doc-1', offset: 50, limit: DOCUMENT_INSPECTION_PAGE_SIZE
    })
    expect(() => parseDocumentInspectionRequest({ documentId: 'doc-1', offset: 0, limit: 101 })).toThrow()
    expect(() => parseDocumentInspectionRequest({ documentId: 'doc-1', offset: -1, limit: 50 })).toThrow()
  })
})
