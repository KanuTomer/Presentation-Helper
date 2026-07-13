import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_CHUNK_CHARS,
  documentKind,
  parseDocument,
  parseDocumentBytes,
  splitDocumentText
} from '../src/main/documents/parsers'
import { DocumentParseError } from '../src/main/documents/types'
import {
  createCfbEncryptedBytes,
  createEmptyPptx,
  createEncryptedPdfMarker,
  createMalformedXmlPptx,
  createPasswordProtectedPdf,
  createPdfFixture,
  createRelationshipPptx
} from './fixtures/m4-document-fixtures'

let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })

describe('document parser contract', () => {
  it('accepts only the four supported document families', () => {
    expect(documentKind('deck.PPTX')).toBe('pptx')
    expect(documentKind('paper.pdf')).toBe('pdf')
    expect(documentKind('notes.markdown')).toBe('markdown')
    expect(documentKind('facts.txt')).toBe('text')
    expect(() => documentKind('data.csv')).toThrowError(expect.objectContaining({ code: 'unsupported_type' }))
  })

  it('reports an unreadable path without leaking it in the actionable message', async () => {
    directory = await mkdtemp(join(tmpdir(), 'presenterai-parser-'))
    const missing = join(directory, 'private-project-name.txt')
    const error = await caught(parseDocument(missing, 'doc'))
    expect(error).toMatchObject({ code: 'unreadable' })
    expect(error.message).not.toContain(missing)
    expect(error.message).not.toContain('private-project-name')
  })

  it('parses an immutable byte snapshot', async () => {
    const bytes = new TextEncoder().encode('Original snapshot text.')
    const parsing = parseDocumentBytes({ documentId: 'snapshot', name: 'snapshot.txt', bytes })
    bytes.fill(0)
    await expect(parsing).resolves.toMatchObject([{ text: 'Original snapshot text.' }])
  })
})

describe('PPTX parser', () => {
  it('uses the main slide list despite section metadata and preserves titles, tables, repeats, and filtered notes', async () => {
    const chunks = await parseDocumentBytes({
      documentId: 'deck', name: 'review.pptx', bytes: createRelationshipPptx()
    })
    const firstSlide = chunks.find((chunk) => chunk.kind === 'slide' && chunk.pageOrSlide === 1)
    const secondSlide = chunks.find((chunk) => chunk.kind === 'slide' && chunk.pageOrSlide === 2)
    const notes = chunks.find((chunk) => chunk.kind === 'speakerNotes')

    expect(firstSlide).toMatchObject({
      id: 'deck:slide:1:part:1', title: 'Presenter Architecture', part: 1, partCount: 1
    })
    expect(firstSlide?.text.match(/Repeated evidence/g)).toHaveLength(2)
    expect(firstSlide?.text).toContain('Metric | Value\nAccuracy | Unreported')
    expect(secondSlide).toMatchObject({ title: 'Second Slide', pageOrSlide: 2 })
    expect(notes).toMatchObject({
      id: 'deck:slide:1:notes:part:1', pageOrSlide: 1, title: 'Presenter Architecture'
    })
    expect(notes?.text).toContain('Explain the local retrieval boundary.')
    expect(notes?.text).toContain('Preserve this untyped note.')
    expect(notes?.text).not.toMatch(/slide image|footer|date|99/i)
  })

  it('splits oversized slides deterministically on safe boundaries with source metadata', async () => {
    const oversized = `${'algorithm boundary '.repeat(180)}Unicode 🔬 conclusion`
    const bytes = createRelationshipPptx({ oversizedText: oversized })
    const first = await parseDocumentBytes({ documentId: 'deck', name: 'large.pptx', bytes })
    const second = await parseDocumentBytes({ documentId: 'deck', name: 'large.pptx', bytes })
    expect(second).toEqual(first)

    const parts = first.filter((chunk) => chunk.kind === 'slide' && chunk.pageOrSlide === 2)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map((part) => part.part)).toEqual(parts.map((_, index) => index + 1))
    expect(new Set(parts.map((part) => part.partCount))).toEqual(new Set([parts.length]))
    expect(parts.every((part) => Array.from(part.text).length <= MAX_CHUNK_CHARS)).toBe(true)
    expect(parts.at(-1)?.text).toContain('Unicode 🔬 conclusion')
  })

  it.each([
    ['malformed XML', createMalformedXmlPptx(), 'malformed'],
    ['malformed ZIP', Uint8Array.from([0x50, 0x4b, 1, 2, 3]), 'malformed'],
    ['missing relationship target', createRelationshipPptx({ presentationTarget: 'slides/missing.xml', omitTargetSlide: true }), 'malformed'],
    ['package traversal', createRelationshipPptx({ presentationTarget: '../../../outside.xml', omitTargetSlide: true }), 'malformed'],
    ['external relationship', createRelationshipPptx({ presentationTarget: 'https://example.test/slide.xml', presentationTargetMode: 'External', omitTargetSlide: true }), 'malformed'],
    ['encrypted CFB package', createCfbEncryptedBytes(), 'encrypted'],
    ['text-empty deck', createEmptyPptx(), 'empty']
  ])('rejects %s with a typed safe error', async (_label, bytes, code) => {
    const error = await caught(parseDocumentBytes({ documentId: 'deck', name: 'bad.pptx', bytes }))
    expect(error).toMatchObject({ code })
    expect(error.message).not.toContain('outside.xml')
  })
})

describe('PDF parser', () => {
  it('preserves page numbers, resolvable outline titles, and oversized page parts', async () => {
    const largeText = `${Array.from({ length: 40 }, () => 'retrieval evidence '.repeat(4)).join('\n')}\nfinal fact`
    const chunks = await parseDocumentBytes({
      documentId: 'paper', name: 'paper.pdf',
      bytes: createPdfFixture([
        { title: 'Method', text: 'Local index architecture.' },
        { title: 'Evaluation', text: largeText }
      ])
    })
    expect(chunks.find((chunk) => chunk.pageOrSlide === 1)).toMatchObject({
      id: 'paper:page:1:part:1', kind: 'pdfPage', title: 'Method', part: 1, partCount: 1
    })
    const pageTwo = chunks.filter((chunk) => chunk.pageOrSlide === 2)
    expect(pageTwo.length).toBeGreaterThan(1)
    expect(pageTwo.every((chunk) => chunk.title === 'Evaluation')).toBe(true)
    expect(pageTwo.at(-1)?.text).toContain('final fact')
  }, 15_000)

  it('does not treat encryption-like page text as an encrypted trailer', async () => {
    const marker = 'trailer << /Encrypt 9 0 R >>\n9 0 obj << /Filter /Standard >> endobj is quoted documentation, not PDF security metadata.'
    const chunks = await parseDocumentBytes({
      documentId: 'paper', name: 'quoted-security.pdf', bytes: createPdfFixture([{ text: marker }])
    })
    expect(chunks[0]?.text).toContain('/Encrypt 9 0 R')
  })

  it.each([
    ['password-protected', createPasswordProtectedPdf(), 'password_protected'],
    ['invalid public-key encryption marker', createEncryptedPdfMarker(), 'malformed'],
    ['malformed', new TextEncoder().encode('%PDF-1.4 broken'), 'malformed'],
    ['image-only/empty', createPdfFixture([{ text: '' }]), 'empty']
  ])('rejects a %s PDF explicitly', async (_label, bytes, code) => {
    const error = await caught(parseDocumentBytes({ documentId: 'paper', name: 'paper.pdf', bytes }))
    expect(error).toMatchObject({ code })
  })
})

describe('Markdown, text, and shared chunking', () => {
  it('preserves ATX and Setext breadcrumbs but ignores headings inside fences', async () => {
    const markdown = `Preface text.\r\n\r\n# Method\r\nMethod body.\r\n\r\n\`\`\`md\r\n# Not a heading\r\n\`\`\`\r\n\r\n## Retrieval\r\nFTS details.\r\n\r\nResults\r\n=======\r\nNo superiority claim.`
    const chunks = await parseDocumentBytes({
      documentId: 'notes', name: 'notes.md', bytes: new TextEncoder().encode(markdown)
    })
    expect(chunks.map((chunk) => chunk.section)).toEqual([
      'Preamble', 'Method', 'Method > Retrieval', 'Results'
    ])
    expect(chunks.map((chunk) => chunk.title)).toEqual([undefined, 'Method', 'Retrieval', 'Results'])
    expect(chunks[1]?.text).toContain('# Not a heading')
  })

  it('uses strict UTF-8, labels text sections, and reports empty input', async () => {
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('First café.\n\nSecond 🔬 section.')])
    await expect(parseDocumentBytes({ documentId: 'text', name: 'facts.txt', bytes: withBom })).resolves.toMatchObject([
      { section: 'Section 1', text: 'First café.', part: 1, partCount: 1 },
      { section: 'Section 2', text: 'Second 🔬 section.', part: 1, partCount: 1 }
    ])
    await expectErrorCode(Uint8Array.from([0xc3, 0x28]), 'invalid.txt', 'malformed')
    await expectErrorCode(new TextEncoder().encode(' \n\n '), 'empty.txt', 'empty')
  })

  it.each([
    ['large.md', `# Oversized\n${Array.from({ length: 500 }, (_, index) => `markdown${index}`).join(' ')}`, 'markdown'],
    ['large.txt', Array.from({ length: 500 }, (_, index) => `text${index}`).join(' '), 'text']
  ])('applies the shared bounded chunk policy to %s sections', async (name, content, kind) => {
    const chunks = await parseDocumentBytes({ documentId: 'large', name, bytes: new TextEncoder().encode(content) })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.kind === kind && Array.from(chunk.text).length <= MAX_CHUNK_CHARS)).toBe(true)
    expect(chunks.map((chunk) => chunk.part)).toEqual(chunks.map((_, index) => index + 1))
    expect(new Set(chunks.map((chunk) => chunk.partCount))).toEqual(new Set([chunks.length]))
  })

  it('uses whole-word overlap and code-point-safe fallback for a single long token', () => {
    const chunks = splitDocumentText(Array.from({ length: 500 }, (_, index) => `word${index}`).join(' '))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => Array.from(chunk).length <= MAX_CHUNK_CHARS)).toBe(true)
    const firstWords = chunks[0]!.split(/\s+/)
    const secondWords = chunks[1]!.split(/\s+/)
    const overlapStart = firstWords.indexOf(secondWords[0]!)
    expect(overlapStart).toBeGreaterThan(0)
    const overlap = firstWords.slice(overlapStart).join(' ')
    expect(overlap.length).toBeGreaterThan(100)
    expect(overlap.length).toBeLessThanOrEqual(200)

    const unicode = `🔬`.repeat(MAX_CHUNK_CHARS + 25)
    const hardParts = splitDocumentText(unicode)
    expect(hardParts).toHaveLength(2)
    expect(hardParts.join('')).toBe(unicode)
    expect(hardParts.every((part) => !part.includes('\uFFFD'))).toBe(true)
  })
})

async function caught(promise: Promise<unknown>): Promise<DocumentParseError> {
  try { await promise } catch (error) {
    expect(error).toBeInstanceOf(DocumentParseError)
    return error as DocumentParseError
  }
  throw new Error('Expected parser to reject')
}

async function expectErrorCode(bytes: Uint8Array, name: string, code: DocumentParseError['code']): Promise<void> {
  const error = await caught(parseDocumentBytes({ documentId: 'doc', name, bytes }))
  expect(error.code).toBe(code)
}
