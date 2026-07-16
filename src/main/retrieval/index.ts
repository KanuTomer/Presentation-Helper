import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname, normalize, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  DocumentErrorCode as PublicDocumentErrorCode,
  DocumentImportOutcome,
  DocumentImportResult,
  DocumentInfo,
  DocumentInspectionPage,
  DocumentSearchHit
} from '../../shared/contracts.js'
import { MAX_DOCUMENT_BYTES, parseDocumentBytes, splitDocumentText } from '../documents/parsers.js'
import { DocumentParseError, type DocumentChunk, type DocumentErrorCode } from '../documents/types.js'

export const RETRIEVAL_SCHEMA_VERSION = 2
export const MAX_RETRIEVAL_RESULTS = 5
export const MAX_EVIDENCE_CHARACTERS = 12_000
const MAX_FTS_CANDIDATES = 40

export interface RetrievedChunk extends DocumentChunk {
  documentName: string
  location: string
  score: number
}

export interface RetrievalCatalogSink {
  setDocuments(documents: DocumentInfo[]): Promise<void>
}

export interface DocumentParserInput {
  documentId: string
  name: string
  path: string
  bytes: Uint8Array
}

export interface RetrievalIndexOptions {
  databasePath: string
  idGenerator?: () => string
  clock?: () => Date
  canonicalizePath?: (path: string) => string
  readBytes?: (path: string) => Promise<Uint8Array>
  parser?: (input: DocumentParserInput) => Promise<DocumentChunk[]>
  catalogSink?: RetrievalCatalogSink
}

interface DocumentRow {
  id: string
  canonical_path: string
  path: string
  name: string
  kind: DocumentInfo['kind']
  content_hash: string
  chunk_count: number
  added_at: string
  updated_at: string
}

interface ChunkRow {
  id: string
  document_id: string
  text: string
  title: string | null
  location: string
  kind: DocumentChunk['kind']
  page_or_slide: number | null
  section: string | null
  part: number
  part_count: number
  source_order: number
  text_hash: string
}

export class RetrievalIndex {
  private db?: DatabaseSync
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly idGenerator: () => string
  private readonly clock: () => Date
  private readonly canonicalize: (path: string) => string
  private readonly readBytes: (path: string) => Promise<Uint8Array>
  private readonly parser: (input: DocumentParserInput) => Promise<DocumentChunk[]>

  constructor(private readonly options: RetrievalIndexOptions) {
    this.idGenerator = options.idGenerator ?? randomUUID
    this.clock = options.clock ?? (() => new Date())
    this.canonicalize = options.canonicalizePath ?? canonicalDocumentPath
    this.readBytes = options.readBytes ?? readDocumentBytes
    this.parser = options.parser ?? ((input) => parseDocumentBytes(input))
  }

  async initialize(): Promise<void> {
    if (this.db) return
    this.db = new DatabaseSync(this.options.databasePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > RETRIEVAL_SCHEMA_VERSION) {
      this.close()
      throw new Error(`Document index schema ${version} is newer than supported schema ${RETRIEVAL_SCHEMA_VERSION}.`)
    }
    if (!this.tableExists('documents')) this.createSchema()
    else if (
      version < RETRIEVAL_SCHEMA_VERSION ||
      !this.columnExists('documents', 'canonical_path') ||
      !this.columnExists('chunks', 'source_order')
    ) this.migrateLegacySchema()
    else this.ensureFtsRows()
    await this.reconcileCatalog()
  }

  listDocuments(): DocumentInfo[] {
    return this.requireDb().prepare(`
      SELECT id, name, path, kind, chunk_count, added_at, updated_at
      FROM documents ORDER BY name COLLATE NOCASE, canonical_path
    `).all().map((row) => rowToDocumentInfo(row as unknown as DocumentRow))
  }

  documentTitles(): readonly string[] {
    return (this.requireDb().prepare(`
      SELECT DISTINCT title FROM chunks
      WHERE title IS NOT NULL AND trim(title) <> ''
      ORDER BY title COLLATE NOCASE
      LIMIT 100
    `).all() as Array<{ title: string }>).map((row) => row.title)
  }

  async addFiles(paths: string[]): Promise<DocumentImportResult> {
    return this.withWriteLock(async () => {
      const outcomes: DocumentImportOutcome[] = []
      for (const path of paths) outcomes.push(await this.addOne(path))
      const documents = this.listDocuments()
      await this.options.catalogSink?.setDocuments(documents)
      return { documents, outcomes }
    })
  }

  async remove(id: string): Promise<void> {
    await this.withWriteLock(async () => {
      const db = this.requireDb()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(id)
        db.prepare('DELETE FROM documents WHERE id = ?').run(id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      await this.reconcileCatalog()
    })
  }

  search(query: string, limit = MAX_RETRIEVAL_RESULTS): RetrievedChunk[] {
    const expression = buildFtsExpression(query)
    const boundedLimit = Math.min(MAX_RETRIEVAL_RESULTS, Math.max(0, Math.trunc(limit)))
    if (!expression || boundedLimit === 0) return []
    const rows = this.requireDb().prepare(`
      SELECT c.*, d.name AS document_name,
        bm25(chunks_fts, 0.0, 1.0, 4.0, 2.0, 3.0) AS lexical_rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ?
      ORDER BY lexical_rank ASC, d.name COLLATE NOCASE ASC,
        c.location COLLATE NOCASE ASC, c.id ASC
      LIMIT ?
    `).all(expression, MAX_FTS_CANDIDATES) as Array<Record<string, unknown>>

    const seenIds = new Set<string>()
    const seenText = new Set<string>()
    const results: RetrievedChunk[] = []
    for (const row of rows) {
      const id = String(row.id)
      const textKey = String(row.text_hash)
      if (seenIds.has(id) || seenText.has(textKey)) continue
      seenIds.add(id)
      seenText.add(textKey)
      results.push(rowToRetrievedChunk(row))
      if (results.length === boundedLimit) break
    }
    return results
  }

  searchDocuments(query: string): DocumentSearchHit[] {
    return this.search(query).map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      ...(chunk.title ? { title: chunk.title } : {}),
      location: chunk.location,
      kind: chunk.kind,
      preview: previewText(chunk.text)
    }))
  }

  inspectDocument(documentId: string, offset = 0, limit = 50): DocumentInspectionPage {
    const db = this.requireDb()
    const safeOffset = Math.max(0, Math.trunc(offset))
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)))
    const documentRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as unknown as DocumentRow | undefined
    if (!documentRow) throw new Error('The selected document is no longer indexed.')
    const total = Number((db.prepare('SELECT COUNT(*) AS total FROM chunks WHERE document_id = ?').get(documentId) as { total: number }).total)
    const rows = db.prepare(`
      SELECT * FROM chunks WHERE document_id = ?
      ORDER BY source_order, part, id
      LIMIT ? OFFSET ?
    `).all(documentId, safeLimit, safeOffset) as unknown as ChunkRow[]
    return {
      document: rowToDocumentInfo(documentRow), offset: safeOffset, limit: safeLimit, total,
      hasMore: safeOffset + rows.length < total,
      chunks: rows.map((row) => ({
        id: row.id, ...(row.title ? { title: row.title } : {}), location: row.location,
        kind: row.kind, text: row.text, part: row.part, partCount: row.part_count
      }))
    }
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private async addOne(path: string): Promise<DocumentImportOutcome> {
    const name = basename(path)
    try {
      const canonicalPath = this.canonicalize(path)
      const bytes = await this.readBytes(path)
      const contentHash = hashBytes(bytes)
      const db = this.requireDb()
      const existing = db.prepare('SELECT * FROM documents WHERE canonical_path = ?').get(canonicalPath) as unknown as DocumentRow | undefined
      if (existing?.content_hash === contentHash) {
        return { path, name, status: 'unchanged', documentId: existing.id }
      }

      const documentId = existing?.id ?? this.idGenerator()
      const chunks = await this.parser({ documentId, name, path, bytes })
      if (chunks.length === 0 || chunks.every((chunk) => !chunk.text.trim())) {
        throw new DocumentParseError('empty', 'The document contains no extractable text.')
      }
      validateChunks(chunks, documentId)
      const timestamp = this.clock().toISOString()
      const kind = kindForPath(path)

      db.exec('BEGIN IMMEDIATE')
      try {
        const current = db.prepare('SELECT * FROM documents WHERE canonical_path = ?').get(canonicalPath) as unknown as DocumentRow | undefined
        const changedDuringParse = Boolean(existing) !== Boolean(current) || Boolean(existing && current && (
          existing.id !== current.id || existing.content_hash !== current.content_hash || existing.updated_at !== current.updated_at
        ))
        if (changedDuringParse) {
          throw new DocumentParseError('unreadable', 'The document index changed while this file was being parsed. Import the file again.')
        }
        if (existing) {
          db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId)
          db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
          db.prepare(`UPDATE documents SET path = ?, name = ?, kind = ?, content_hash = ?,
            chunk_count = ?, updated_at = ? WHERE id = ?`).run(path, name, kind, contentHash, chunks.length, timestamp, documentId)
        } else {
          db.prepare(`INSERT INTO documents
            (id, canonical_path, path, name, kind, content_hash, chunk_count, added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            documentId, canonicalPath, path, name, kind, contentHash, chunks.length, timestamp, timestamp
          )
        }
        this.insertChunks(documentId, name, chunks)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return { path, name, status: existing ? 'updated' : 'added', documentId }
    } catch (error) {
      const safe = toDocumentError(error)
      return { path, name, status: 'failed', error: safe }
    }
  }

  private insertChunks(documentId: string, documentName: string, chunks: DocumentChunk[]): void {
    const db = this.requireDb()
    const insertChunk = db.prepare(`INSERT INTO chunks
      (id, document_id, text, title, location, kind, page_or_slide, section, part, part_count, source_order, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertFts = db.prepare(`INSERT INTO chunks_fts
      (chunk_id, text, title, location, document_name) VALUES (?, ?, ?, ?, ?)`)
    for (const [sourceOrder, chunk] of chunks.entries()) {
      const title = chunk.title?.trim() ? boundMetadata(chunk.title.trim(), 500) : null
      const location = chunkLocation(chunk)
      const textHash = normalizedTextHash(chunk.text)
      insertChunk.run(
        chunk.id, documentId, chunk.text, title, location, chunk.kind,
        chunk.pageOrSlide ?? null, chunk.section ? boundMetadata(chunk.section, 500) : null,
        chunk.part, chunk.partCount, sourceOrder, textHash
      )
      insertFts.run(chunk.id, chunk.text, title ?? '', location, documentName)
    }
  }

  private createSchema(): void {
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      createSchemaObjects(db)
      db.exec(`PRAGMA user_version=${RETRIEVAL_SCHEMA_VERSION}; COMMIT`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private migrateLegacySchema(): void {
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const legacyDocuments = db.prepare('SELECT * FROM documents').all() as Array<Record<string, unknown>>
      const legacyChunks = this.tableExists('chunks')
        ? db.prepare('SELECT rowid AS legacy_rowid, * FROM chunks ORDER BY rowid').all() as Array<Record<string, unknown>>
        : []
      const newestByPath = new Map<string, Record<string, unknown>>()
      for (const row of legacyDocuments) {
        const key = this.canonicalize(String(row.path))
        const current = newestByPath.get(key)
        if (!current || compareLegacyNewest(row, current) > 0) newestByPath.set(key, row)
      }
      const selectedIds = new Set([...newestByPath.values()].map((row) => String(row.id)))
      const documentNames = new Map([...newestByPath.values()].map((row) => [String(row.id), String(row.name)]))
      const sourceOrder = new Map<string, number>()
      const migratedIds = new Set<string>()
      const migratedChunks: Array<ChunkRow & { document_name: string }> = []
      for (const row of legacyChunks) {
        const documentId = String(row.document_id)
        if (!selectedIds.has(documentId)) continue
        const originalText = String(row.text ?? '')
        const parts = splitDocumentText(originalText)
        if (parts.length === 0) continue
        const originalId = String(row.id)
        const titleValue = row.title == null ? String(row.section ?? '') : String(row.title)
        const title = titleValue ? boundMetadata(titleValue, 500) : null
        const baseLocation = String(row.location ?? row.section ?? row.kind ?? 'Section').replace(/ \(part \d+\/\d+\)$/i, '')
        const section = row.section == null ? null : boundMetadata(String(row.section), 500)
        const pageOrSlide = row.page_or_slide == null ? null : Number(row.page_or_slide)
        const existingPart = Number(row.part ?? 1)
        const existingPartCount = Number(row.part_count ?? 1)
        for (const [partIndex, text] of parts.entries()) {
          const part = parts.length === 1 && Number.isInteger(existingPart) && existingPart > 0 ? existingPart : partIndex + 1
          const partCount = parts.length === 1 && Number.isInteger(existingPartCount) && existingPartCount >= part
            ? existingPartCount : parts.length
          const location = boundMetadata(`${baseLocation}${parts.length > 1 ? ` (part ${partIndex + 1}/${parts.length})` : ''}`, 500)
          let migratedId = parts.length === 1 ? originalId : `${originalId}:legacy-part:${partIndex + 1}`
          if (migratedIds.has(migratedId)) {
            const suffix = createHash('sha256').update(`${documentId}\0${originalId}\0${partIndex}`).digest('hex').slice(0, 16)
            migratedId = `${documentId}:legacy:${suffix}:part:${partIndex + 1}`
          }
          if (migratedIds.has(migratedId)) throw new Error('Legacy document chunks contain irreconcilable duplicate identifiers.')
          migratedIds.add(migratedId)
          migratedChunks.push({
            id: migratedId,
            document_id: documentId,
            text,
            title,
            location,
            kind: String(row.kind) as DocumentChunk['kind'],
            page_or_slide: pageOrSlide,
            section,
            part,
            part_count: partCount,
            source_order: sourceOrder.get(documentId) ?? 0,
            text_hash: normalizedTextHash(text),
            document_name: documentNames.get(documentId) ?? ''
          })
          sourceOrder.set(documentId, (sourceOrder.get(documentId) ?? 0) + 1)
        }
      }

      db.exec('DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS documents;')
      createSchemaObjects(db)
      const insertDocument = db.prepare(`INSERT INTO documents
        (id, canonical_path, path, name, kind, content_hash, chunk_count, added_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const [canonicalPath, row] of newestByPath) {
        const id = String(row.id)
        const addedAt = String(row.added_at ?? this.clock().toISOString())
        const count = migratedChunks.filter((chunk) => chunk.document_id === id).length
        insertDocument.run(
          id, canonicalPath, String(row.path), String(row.name), String(row.kind),
          String(row.hash ?? row.content_hash ?? ''), count, addedAt, String(row.updated_at ?? addedAt)
        )
      }
      const insertChunk = db.prepare(`INSERT INTO chunks
        (id, document_id, text, title, location, kind, page_or_slide, section, part, part_count, source_order, text_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const insertFts = db.prepare('INSERT INTO chunks_fts (chunk_id, text, title, location, document_name) VALUES (?, ?, ?, ?, ?)')
      for (const row of migratedChunks) {
        insertChunk.run(
          row.id, row.document_id, row.text, row.title, row.location, row.kind, row.page_or_slide,
          row.section, row.part, row.part_count, row.source_order, row.text_hash
        )
        insertFts.run(row.id, row.text, row.title ?? '', row.location, row.document_name)
      }
      db.exec(`PRAGMA user_version=${RETRIEVAL_SCHEMA_VERSION}; COMMIT`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private ensureFtsRows(): void {
    const db = this.requireDb()
    const chunkCount = Number((db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count)
    const ftsCount = Number((db.prepare('SELECT COUNT(*) AS count FROM chunks_fts').get() as { count: number }).count)
    const missingOrStale = db.prepare(`
      SELECT 1 FROM chunks c
      JOIN documents d ON d.id = c.document_id
      LEFT JOIN chunks_fts f ON f.chunk_id = c.id
      WHERE f.chunk_id IS NULL OR f.text <> c.text OR f.title <> COALESCE(c.title, '')
        OR f.location <> c.location OR f.document_name <> d.name
      LIMIT 1
    `).get()
    const orphan = db.prepare(`
      SELECT 1 FROM chunks_fts f LEFT JOIN chunks c ON c.id = f.chunk_id
      WHERE c.id IS NULL LIMIT 1
    `).get()
    if (chunkCount === ftsCount && !missingOrStale && !orphan) return
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM chunks_fts')
      db.exec(`INSERT INTO chunks_fts (chunk_id, text, title, location, document_name)
        SELECT c.id, c.text, COALESCE(c.title, ''), c.location, d.name
        FROM chunks c JOIN documents d ON d.id = c.document_id`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private tableExists(name: string): boolean {
    return Boolean(this.requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name))
  }

  private columnExists(table: string, column: string): boolean {
    return (this.requireDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column)
  }

  private async reconcileCatalog(): Promise<void> {
    await this.options.catalogSink?.setDocuments(this.listDocuments())
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('The document index has not been initialized.')
    return this.db
  }
}

export function canonicalDocumentPath(path: string): string {
  const absolute = normalize(resolve(path))
  let canonical = absolute
  try { canonical = realpathSync.native(absolute) } catch { /* Missing legacy files retain a stable absolute identity. */ }
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical
}

export function buildFtsExpression(query: string): string {
  const normalized = query.normalize('NFKC')
  const rawTerms = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const raw of rawTerms) {
    if (raw.length === 1 && !/^\p{N}$/u.test(raw) && raw !== raw.toLocaleUpperCase()) continue
    const term = raw.toLocaleLowerCase().replaceAll('"', '""')
    if (!term || seen.has(term)) continue
    seen.add(term)
    terms.push(`"${term}"`)
    if (terms.length === 24) break
  }
  return terms.join(' OR ')
}

export function serializeEvidenceChunk(chunk: RetrievedChunk): string {
  return `[${chunk.id}] ${chunk.documentName}, ${chunk.location}\n${chunk.text}`
}

export function serializeEvidenceChunks(chunks: RetrievedChunk[]): string {
  return chunks.map(serializeEvidenceChunk).join('\n\n')
}

export function selectEvidenceChunks(chunks: RetrievedChunk[], maxCharacters = MAX_EVIDENCE_CHARACTERS): RetrievedChunk[] {
  const bounded = Math.max(0, Math.trunc(maxCharacters))
  const selected: RetrievedChunk[] = []
  let used = 0
  for (const chunk of chunks) {
    const blockLength = serializeEvidenceChunk(chunk).length
    const separatorLength = selected.length ? 2 : 0
    if (used + separatorLength + blockLength > bounded) continue
    selected.push(chunk)
    used += separatorLength + blockLength
  }
  return selected
}

function createSchemaObjects(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      title TEXT,
      location TEXT NOT NULL,
      kind TEXT NOT NULL,
      page_or_slide INTEGER,
      section TEXT,
      part INTEGER NOT NULL,
      part_count INTEGER NOT NULL,
      source_order INTEGER NOT NULL,
      text_hash TEXT NOT NULL
    );
    CREATE INDEX chunks_document_id_idx ON chunks(document_id);
    CREATE INDEX chunks_text_hash_idx ON chunks(text_hash);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED, text, title, location, document_name,
      tokenize='unicode61 remove_diacritics 2'
    );
  `)
}

function rowToDocumentInfo(row: DocumentRow): DocumentInfo {
  return {
    id: row.id, name: row.name, path: row.path, kind: row.kind,
    chunkCount: Number(row.chunk_count), addedAt: row.added_at,
    ...(row.updated_at !== row.added_at ? { updatedAt: row.updated_at } : {})
  }
}

function rowToRetrievedChunk(row: Record<string, unknown>): RetrievedChunk {
  return {
    id: String(row.id), documentId: String(row.document_id), text: String(row.text),
    kind: String(row.kind) as DocumentChunk['kind'], part: Number(row.part), partCount: Number(row.part_count),
    ...(row.page_or_slide == null ? {} : { pageOrSlide: Number(row.page_or_slide) }),
    ...(row.section == null ? {} : { section: String(row.section) }),
    ...(row.title == null ? {} : { title: String(row.title) }),
    documentName: String(row.document_name), location: String(row.location), score: -Number(row.lexical_rank)
  }
}

function chunkLocation(chunk: DocumentChunk): string {
  let base: string
  if (chunk.pageOrSlide != null) {
    if (chunk.kind === 'pdfPage') base = `Page ${chunk.pageOrSlide}`
    else base = `Slide ${chunk.pageOrSlide}${chunk.kind === 'speakerNotes' ? ' notes' : ''}`
  } else base = chunk.section?.trim() || chunk.title?.trim() || 'Section'
  if (chunk.title?.trim() && !base.toLocaleLowerCase().includes(chunk.title.trim().toLocaleLowerCase())) base += ` — ${chunk.title.trim()}`
  if (chunk.partCount > 1) base += ` (part ${chunk.part}/${chunk.partCount})`
  return boundMetadata(base, 500)
}

function validateChunks(chunks: DocumentChunk[], documentId: string): void {
  const ids = new Set<string>()
  for (const chunk of chunks) {
    if (chunk.documentId !== documentId || !chunk.id || ids.has(chunk.id) || !chunk.text.trim()) {
      throw new DocumentParseError('malformed', 'The document produced invalid or duplicate text chunks.')
    }
    if (!Number.isInteger(chunk.part) || !Number.isInteger(chunk.partCount) || chunk.part < 1 || chunk.partCount < chunk.part) {
      throw new DocumentParseError('malformed', 'The document produced invalid chunk-part metadata.')
    }
    ids.add(chunk.id)
  }
}

function kindForPath(path: string): DocumentInfo['kind'] {
  switch (extname(path).toLocaleLowerCase()) {
    case '.pptx': return 'pptx'
    case '.pdf': return 'pdf'
    case '.md':
    case '.markdown': return 'markdown'
    case '.txt': return 'text'
    default: throw new DocumentParseError('unsupported_type', 'Supported document types are PPTX, PDF, Markdown, and text.')
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizedTextHash(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  return createHash('sha256').update(normalized).digest('hex')
}

function previewText(text: string): string {
  const points = Array.from(text)
  return points.length <= 320 ? text : `${points.slice(0, 317).join('').trimEnd()}...`
}

function boundMetadata(value: string, maxCodePoints: number): string {
  const normalized = value.trim()
  const points = Array.from(normalized)
  return points.length <= maxCodePoints ? normalized : `${points.slice(0, maxCodePoints - 1).join('').trimEnd()}…`
}

async function readDocumentBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new DocumentParseError('unreadable', 'The selected path is not a readable document file.')
    if (!Number.isSafeInteger(info.size) || info.size > MAX_DOCUMENT_BYTES) {
      throw new DocumentParseError('unreadable', 'The document is too large to index safely. Use a file smaller than 100 MB.')
    }
    const buffer = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset)
  } finally {
    await handle.close()
  }
}

function compareLegacyNewest(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const timestamp = String(left.updated_at ?? left.added_at ?? '').localeCompare(String(right.updated_at ?? right.added_at ?? ''))
  return timestamp || String(left.id).localeCompare(String(right.id))
}

function toDocumentError(error: unknown): { code: PublicDocumentErrorCode; message: string } {
  if (error instanceof DocumentParseError) {
    const code = publicErrorCode(error.code)
    return { code, message: error.message.slice(0, 800) }
  }
  const value = error as NodeJS.ErrnoException
  if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(value.code ?? '')) {
    return { code: 'unreadable', message: 'The document could not be read. Check that it still exists and is accessible.' }
  }
  return { code: 'malformed', message: 'The document could not be indexed because its contents were invalid.' }
}

function publicErrorCode(code: DocumentErrorCode): PublicDocumentErrorCode {
  return code
}
