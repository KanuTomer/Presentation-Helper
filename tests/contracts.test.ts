import { describe, expect, it } from 'vitest'
import {
  aiErrorCodes, askResultSchema, assistantResponseSchema, documentImportResultSchema,
  documentInspectionPageSchema, documentInspectionRequestSchema, documentSearchHitsSchema,
  documentSearchQuerySchema, questionSchema
} from '../src/shared/contracts'

describe('assistant response contract', () => {
  it('accepts the presenter format', () => {
    expect(assistantResponseSchema.parse({
      category: 'CHALLENGE', support: 'unsupported-project-claim', evidenceIssue: 'missing',
      say: 'The design favors predictable local behavior.',
      keyPoints: ['Documents remain local.', 'Only selected excerpts are transmitted.', 'Evidence limitations remain visible.'],
      ifChallenged: 'The trade-off is weaker semantic recall.', warning: 'No benchmark was supplied.', evidence: []
    }).category).toBe('CHALLENGE')
  })
  it('rejects long key-point lists and unknown categories', () => {
    expect(() => assistantResponseSchema.parse({ category: 'OPINION', support: 'general-technical', evidenceIssue: 'none', say: 'x', keyPoints: ['1', '2', '3', '4', '5'], ifChallenged: 'x', evidence: [] })).toThrow()
  })
  it('validates typed IPC outcomes and bounded questions', () => {
    for (const code of aiErrorCodes) expect(askResultSchema.parse({ ok: false, error: { code, message: 'Safe message.', retryable: false } }).ok).toBe(false)
    expect(questionSchema.parse('  hello  ')).toBe('hello')
    expect(() => questionSchema.parse('x'.repeat(4_001))).toThrow()
  })

  it('bounds document search and inspection contracts', () => {
    expect(documentSearchQuerySchema.parse('  local evidence  ')).toBe('local evidence')
    expect(() => documentSearchQuerySchema.parse('')).toThrow()
    expect(documentInspectionRequestSchema.parse({ documentId: 'doc-1' })).toEqual({ documentId: 'doc-1', offset: 0, limit: 50 })
    expect(() => documentInspectionRequestSchema.parse({ documentId: 'doc-1', offset: 0, limit: 101 })).toThrow()
    expect(documentSearchHitsSchema.parse([{
      chunkId: 'chunk-1', documentId: 'doc-1', documentName: 'deck.pptx', title: 'Architecture',
      location: 'Slide 2', kind: 'slide', preview: 'Local evidence.'
    }])).toHaveLength(1)
    expect(() => documentSearchHitsSchema.parse(Array.from({ length: 6 }, (_, index) => ({
      chunkId: `chunk-${index}`, documentId: 'doc-1', documentName: 'deck.pptx',
      location: 'Slide 2', kind: 'slide', preview: 'Local evidence.'
    })))).toThrow()
  })

  it('validates partial import outcomes and pages of at most fifty chunks', () => {
    expect(documentImportResultSchema.parse({ documents: [], outcomes: [
      { path: 'good.md', name: 'good.md', status: 'added', documentId: 'doc-1' },
      { path: 'bad.pdf', name: 'bad.pdf', status: 'failed', error: { code: 'password_protected', message: 'Unlock the PDF before importing it.' } }
    ] }).outcomes).toHaveLength(2)
    const chunks = Array.from({ length: 50 }, (_, index) => ({
      id: `chunk-${index}`, location: 'Page 1', kind: 'pdfPage', text: 'Evidence', part: 1, partCount: 1
    }))
    expect(documentInspectionPageSchema.parse({
      document: { id: 'doc-1', name: 'report.pdf', path: 'report.pdf', kind: 'pdf', chunkCount: 51, addedAt: '2026-07-13T00:00:00Z' },
      chunks, offset: 0, limit: 50, total: 51, hasMore: true
    }).chunks).toHaveLength(50)
    expect(() => documentInspectionPageSchema.parse({
      document: { id: 'doc-1', name: 'report.pdf', path: 'report.pdf', kind: 'pdf', chunkCount: 51, addedAt: '2026-07-13T00:00:00Z' },
      chunks: [...chunks, chunks[0]], offset: 0, limit: 51, total: 51, hasMore: false
    })).toThrow()
  })
})
