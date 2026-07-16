import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DocumentChunk } from '../src/main/documents/types'
import { documentInspectionPageSchema, documentSearchHitsSchema } from '../src/shared/contracts'
import {
  buildFtsExpression,
  MAX_EVIDENCE_CHARACTERS,
  RetrievalIndex,
  selectEvidenceChunks,
  serializeEvidenceChunk,
  serializeEvidenceChunks,
  type DocumentParserInput,
  type RetrievedChunk
} from '../src/main/retrieval'

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

function chunk(input: DocumentParserInput, text: string, title = 'Project Method', suffix = '1'): DocumentChunk {
  return {
    id: `${input.documentId}:section:${suffix}:part:1`, documentId: input.documentId, text, title,
    section: title, kind: input.name.endsWith('.md') ? 'markdown' : 'text', part: 1, partCount: 1
  }
}

async function harness(options: {
  parser?: (input: DocumentParserInput) => Promise<DocumentChunk[]>
  canonicalizePath?: (path: string) => string
} = {}) {
  directory = await mkdtemp(join(tmpdir(), 'presenterai-retrieval-'))
  const bytes = new Map<string, Uint8Array>()
  const catalogSink = { setDocuments: vi.fn(async () => undefined) }
  let sequence = 0
  const index = new RetrievalIndex({
    databasePath: join(directory, 'documents.sqlite'), catalogSink,
    idGenerator: () => `doc-${++sequence}`, clock: () => new Date('2026-07-13T12:00:00.000Z'),
    canonicalizePath: options.canonicalizePath ?? ((path) => path.replaceAll('\\', '/').toLowerCase()),
    readBytes: async (path) => {
      const value = bytes.get(path)
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    },
    parser: options.parser ?? (async (input) => [chunk(input, new TextDecoder().decode(input.bytes))])
  })
  await index.initialize()
  return { index, bytes, catalogSink, databasePath: join(directory, 'documents.sqlite') }
}

describe('document catalog and transactional reindexing', () => {
  it('adds, no-ops unchanged bytes, and replaces changed chunks while preserving identity', async () => {
    const { index, bytes } = await harness()
    const path = 'C:\\Docs\\Project.txt'
    bytes.set(path, new TextEncoder().encode('alpha implementation detail'))
    const added = await index.addFiles([path])
    expect(added.outcomes).toMatchObject([{ status: 'added', documentId: 'doc-1' }])
    expect(index.search('alpha')[0]?.documentId).toBe('doc-1')

    const unchanged = await index.addFiles([path])
    expect(unchanged.outcomes[0]).toMatchObject({ status: 'unchanged', documentId: 'doc-1' })

    bytes.set(path, new TextEncoder().encode('beta replacement evidence'))
    const updated = await index.addFiles([path])
    expect(updated.outcomes[0]).toMatchObject({ status: 'updated', documentId: 'doc-1' })
    expect(index.listDocuments()).toHaveLength(1)
    expect(index.search('alpha')).toEqual([])
    expect(index.search('beta')[0]?.documentId).toBe('doc-1')
    index.close()
  })

  it('keeps different canonical paths independent even when their content is identical', async () => {
    const { index, bytes } = await harness()
    bytes.set('one.txt', new TextEncoder().encode('same exact retrieval text'))
    bytes.set('two.txt', new TextEncoder().encode('same exact retrieval text'))
    const result = await index.addFiles(['one.txt', 'two.txt'])
    expect(result.outcomes.map((item) => item.status)).toEqual(['added', 'added'])
    expect(result.documents).toHaveLength(2)
    expect(index.search('retrieval', 5)).toHaveLength(1)
    index.close()
  })

  it('returns one safe outcome per input and preserves successful siblings', async () => {
    const { index, bytes } = await harness({
      parser: async (input) => {
        if (input.name === 'bad.txt') throw new Error('sensitive parser internals')
        return [chunk(input, new TextDecoder().decode(input.bytes))]
      }
    })
    bytes.set('good.txt', new TextEncoder().encode('good evidence'))
    bytes.set('bad.txt', new TextEncoder().encode('bad bytes'))
    const result = await index.addFiles(['good.txt', 'missing.txt', 'bad.txt'])
    expect(result.outcomes.map((item) => item.status)).toEqual(['added', 'failed', 'failed'])
    expect(result.outcomes[1]?.error).toEqual({
      code: 'unreadable', message: 'The document could not be read. Check that it still exists and is accessible.'
    })
    expect(result.outcomes[2]?.error).toEqual({
      code: 'malformed', message: 'The document could not be indexed because its contents were invalid.'
    })
    expect(result.documents.map((item) => item.name)).toEqual(['good.txt'])
    index.close()
  })

  it('rolls back a failed insert and removal leaves no relational or FTS orphans', async () => {
    let useCollidingId = false
    const { index, bytes, databasePath } = await harness({
      parser: async (input) => {
        const value = chunk(input, new TextDecoder().decode(input.bytes), 'Title', 'shared')
        return [{ ...value, id: useCollidingId ? 'doc-1:section:shared:part:1' : value.id }]
      }
    })
    bytes.set('first.txt', new TextEncoder().encode('first unique evidence'))
    const first = await index.addFiles(['first.txt'])
    useCollidingId = true
    bytes.set('second.txt', new TextEncoder().encode('second unique evidence'))
    const second = await index.addFiles(['second.txt'])
    expect(second.outcomes[0]?.status).toBe('failed')
    expect(index.listDocuments()).toHaveLength(1)
    await index.remove(first.outcomes[0]!.documentId!)
    index.close()

    const db = new DatabaseSync(databasePath)
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get()).toMatchObject({ n: 0 })
    db.close()
  })

  it('clears the complete catalog and FTS index without deleting original source documents', async () => {
    const { index, bytes, catalogSink, databasePath } = await harness()
    const sourcePath = join(directory, 'user-owned-source.txt')
    const sourceText = 'User-owned source content must survive local-index deletion.'
    await writeFile(sourcePath, sourceText, 'utf8')
    bytes.set(sourcePath, new TextEncoder().encode(sourceText))
    await index.addFiles([sourcePath])
    expect(index.search('survive')).toHaveLength(1)

    await index.clearAll()
    expect(index.listDocuments()).toEqual([])
    expect(index.search('survive')).toEqual([])
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceText)
    expect(catalogSink.setDocuments).toHaveBeenLastCalledWith([])
    index.close()

    const db = new DatabaseSync(databasePath, { readOnly: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get()).toMatchObject({ n: 0 })
    db.close()
  })

  it('keeps the prior searchable version when a changed-file replacement cannot be parsed', async () => {
    let rejectReplacement = false
    const { index, bytes } = await harness({
      parser: async (input) => {
        if (rejectReplacement) throw new Error('replacement parse failed')
        return [chunk(input, new TextDecoder().decode(input.bytes))]
      }
    })
    bytes.set('stable.txt', new TextEncoder().encode('original kestrel evidence'))
    const added = await index.addFiles(['stable.txt'])
    const original = added.documents[0]!
    rejectReplacement = true
    bytes.set('stable.txt', new TextEncoder().encode('replacement juniper evidence'))
    const failed = await index.addFiles(['stable.txt'])
    expect(failed.outcomes[0]).toMatchObject({ status: 'failed', error: { code: 'malformed' } })
    expect(failed.documents).toEqual([original])
    expect(index.search('kestrel')[0]?.documentId).toBe(original.id)
    expect(index.search('juniper')).toEqual([])
    index.close()
  })

  it('reconciles the SQLite catalog on initialization and supports bounded inspection', async () => {
    const { index, bytes, catalogSink, databasePath } = await harness()
    bytes.set('inspect.txt', new TextEncoder().encode('inspectable content'))
    const added = await index.addFiles(['inspect.txt'])
    const id = added.outcomes[0]!.documentId!
    expect(index.inspectDocument(id, -1, 999)).toMatchObject({ offset: 0, limit: 50, total: 1, hasMore: false })
    index.close()

    const restartSink = { setDocuments: vi.fn(async () => undefined) }
    const restarted = new RetrievalIndex({ databasePath, catalogSink: restartSink })
    await restarted.initialize()
    expect(restartSink.setDocuments).toHaveBeenCalledWith([expect.objectContaining({ id, name: 'inspect.txt' })])
    restarted.close()
    expect(catalogSink.setDocuments).toHaveBeenCalled()
  })

  it('serializes concurrent same-path imports so an older parse cannot overwrite newer bytes', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const { index, bytes } = await harness({
      parser: async (input) => {
        calls += 1
        if (calls === 1) { firstStarted(); await blocked }
        return [chunk(input, new TextDecoder().decode(input.bytes))]
      }
    })
    bytes.set('ordered.txt', new TextEncoder().encode('older cedar snapshot'))
    const older = index.addFiles(['ordered.txt'])
    await started
    bytes.set('ordered.txt', new TextEncoder().encode('newer juniper snapshot'))
    const newer = index.addFiles(['ordered.txt'])
    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([older, newer])
    expect(firstResult.outcomes[0]?.status).toBe('added')
    expect(secondResult.outcomes[0]).toMatchObject({ status: 'updated', documentId: firstResult.outcomes[0]?.documentId })
    expect(index.search('cedar')).toEqual([])
    expect(index.search('juniper')[0]?.documentId).toBe(firstResult.outcomes[0]?.documentId)
    index.close()
  })

  it('uses a transaction compare-and-swap guard against a separate writer during parsing', async () => {
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const { index, bytes, databasePath } = await harness({
      parser: async (input) => { markStarted(); await blocked; return [chunk(input, 'stale snapshot')] }
    })
    bytes.set('race.txt', new TextEncoder().encode('stale snapshot'))
    const pending = index.addFiles(['race.txt'])
    await started
    const external = new DatabaseSync(databasePath)
    external.prepare(`INSERT INTO documents
      (id, canonical_path, path, name, kind, content_hash, chunk_count, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'external', 'race.txt', 'race.txt', 'race.txt', 'text', 'newer-hash', 0,
      '2026-07-13T12:01:00.000Z', '2026-07-13T12:01:00.000Z'
    )
    external.close()
    release()
    const result = await pending
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', error: { code: 'unreadable' } })
    expect(index.listDocuments()).toMatchObject([{ id: 'external', chunkCount: 0 }])
    index.close()
  })

  it('keeps inspection in source order and bounds Unicode metadata at the IPC boundary', async () => {
    const { index, bytes } = await harness({
      parser: async (input) => Array.from({ length: 12 }, (_, offset) => ({
        id: `${input.documentId}:section:${offset + 1}:part:1`, documentId: input.documentId,
        text: offset === 0 ? `needle ${'😀'.repeat(310)}` : `content ${offset + 1}`,
        title: offset === 0 ? '🚀'.repeat(300) : `Title ${offset + 1}`,
        section: offset === 0 ? '😀'.repeat(300) : `Section ${offset + 1}`,
        kind: 'text' as const, part: 1, partCount: 1
      }))
    })
    bytes.set('unicode.txt', new TextEncoder().encode('fixture'))
    const added = await index.addFiles(['unicode.txt'])
    const documentId = added.outcomes[0]!.documentId!
    const inspection = index.inspectDocument(documentId)
    expect(inspection.chunks.map((item) => item.text.replace(/^content /, ''))).toEqual([
      `needle ${'😀'.repeat(310)}`, ...Array.from({ length: 11 }, (_, offset) => String(offset + 2))
    ])
    expect(Array.from(inspection.chunks[0]!.location).length).toBeLessThanOrEqual(500)
    expect(() => documentInspectionPageSchema.parse(inspection)).not.toThrow()
    expect(() => documentSearchHitsSchema.parse(index.searchDocuments('needle'))).not.toThrow()
    index.close()
  })
})

describe('schema migration', () => {
  it('retains the newest canonical duplicate and rebuilds searchable FTS rows', async () => {
    directory = await mkdtemp(join(tmpdir(), 'presenterai-migration-'))
    const databasePath = join(directory, 'documents.sqlite')
    const db = new DatabaseSync(databasePath)
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, added_at TEXT NOT NULL);
      CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, text TEXT NOT NULL, location TEXT NOT NULL, kind TEXT NOT NULL, page_or_slide INTEGER, section TEXT);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, text, location, document_name);
    `)
    const insertDoc = db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)')
    insertDoc.run('old', 'Project.txt', 'C:\\Docs\\Project.txt', 'text', 'old-hash', '2026-01-01T00:00:00Z')
    insertDoc.run('new', 'Project.txt', 'c:\\docs\\PROJECT.txt', 'text', 'new-hash', '2026-02-01T00:00:00Z')
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)').run('old:1', 'old', 'obsolete alpha', 'Section 1', 'text', null, 'Section 1')
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)').run('new:1', 'new', 'current beta evidence', 'Section 1', 'text', null, 'Section 1')
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'new:oversized', 'new', `${'legacy bounded evidence '.repeat(130)}final marker`,
      'Section 2', 'text', null, 'Section 2'
    )
    db.close()

    const index = new RetrievalIndex({ databasePath, canonicalizePath: (path) => path.toLowerCase() })
    await index.initialize()
    expect(index.listDocuments()).toMatchObject([{ id: 'new' }])
    expect(index.listDocuments()[0]!.chunkCount).toBeGreaterThan(2)
    expect(index.search('obsolete')).toEqual([])
    expect(index.search('beta')[0]?.id).toBe('new:1')
    const migratedInspection = index.inspectDocument('new')
    expect(migratedInspection.chunks.every((item) => Array.from(item.text).length <= 2_200)).toBe(true)
    expect(migratedInspection.chunks.filter((item) => item.id.startsWith('new:oversized:legacy-part:')).length).toBeGreaterThan(1)
    index.close()

    const migrated = new DatabaseSync(databasePath)
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
    const chunkCount = migrated.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get()).toMatchObject({ n: chunkCount.n })
    migrated.close()
  })
})

describe('safe deterministic retrieval and evidence budgeting', () => {
  it('constructs a bounded quoted FTS expression from punctuation and operators', () => {
    const expression = buildFtsExpression('C++ "quoted" OR foo* -bar .NET R R')
    expect(expression).toContain('"c"')
    expect(expression).toContain('"quoted"')
    expect(expression).toContain('"net"')
    expect(expression.match(/"r"/g)).toHaveLength(1)
    expect(expression).not.toContain('*')
  })

  it('uses title/filename fields, deterministic ordering, deduplication, and a hard top-five cap', async () => {
    const { index, bytes } = await harness({
      parser: async (input) => {
        const decoded = new TextDecoder().decode(input.bytes)
        const [title, text] = decoded.split('|') as [string, string]
        return [chunk(input, text, title)]
      }
    })
    for (let number = 1; number <= 8; number += 1) {
      const path = number === 1 ? 'quasar-reference.txt' : `document-${number}.txt`
      bytes.set(path, new TextEncoder().encode(`${number === 2 ? 'Quasar architecture' : `Title ${number}`}|quasar evidence variant ${number}`))
      await index.addFiles([path])
    }
    const results = index.search('quasar', 100)
    expect(results).toHaveLength(5)
    expect(results[0]?.documentName).toMatch(/quasar-reference|document-2/)
    expect(index.search('quasar " * - OR')).toHaveLength(5)
    expect(index.searchDocuments('quasar')).toHaveLength(5)
    index.close()
  })

  it('selects only whole evidence blocks within the exact 12,000-character budget', () => {
    const make = (id: string, text: string): RetrievedChunk => ({
      id, documentId: 'doc', documentName: 'Project.txt', location: 'Section', text,
      kind: 'text', part: 1, partCount: 1, score: 1
    })
    const first = make('one', 'a'.repeat(8_000))
    const tooLarge = make('two', 'b'.repeat(5_000))
    const final = make('three', 'c'.repeat(1_000))
    const selected = selectEvidenceChunks([first, tooLarge, final])
    expect(selected.map((item) => item.id)).toEqual(['one', 'three'])
    expect(serializeEvidenceChunks(selected).length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARACTERS)
    expect(serializeEvidenceChunks(selected)).toContain(serializeEvidenceChunk(final))
    expect(selectEvidenceChunks([first], serializeEvidenceChunk(first).length)).toEqual([first])
    expect(selectEvidenceChunks([first], serializeEvidenceChunk(first).length - 1)).toEqual([])
  })
})
