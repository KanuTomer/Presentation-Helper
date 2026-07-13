import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DocumentInfo } from '../../shared/contracts.js'
import type { DocumentChunk } from '../documents/types.js'
import { documentKind, documentName, parseDocument } from '../documents/parsers.js'
import type { SettingsStore } from '../settings/store.js'

export interface RetrievedChunk extends DocumentChunk { documentName: string; location: string; score: number }

export class RetrievalIndex {
  private db?: DatabaseSync
  constructor(private store: SettingsStore) {}
  initialize(): void {
    this.db = new DatabaseSync(join(app.getPath('userData'), 'documents.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, text TEXT NOT NULL, location TEXT NOT NULL, kind TEXT NOT NULL, page_or_slide INTEGER, section TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, text, location, document_name, tokenize='unicode61 remove_diacritics 2');
    `)
  }
  async addFiles(paths: string[]): Promise<DocumentInfo[]> {
    const docs = [...this.store.documents]
    for (const path of paths) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex')
      const existing = this.db!.prepare('SELECT id FROM documents WHERE hash = ?').get(hash) as { id: string } | undefined
      if (existing) continue
      const id = randomUUID(); const chunks = await parseDocument(path, id); const addedAt = new Date().toISOString()
      this.db!.exec('BEGIN')
      try {
        this.db!.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(id, documentName(path), path, documentKind(path), hash, addedAt)
        const insertChunk = this.db!.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)')
        const insertFts = this.db!.prepare('INSERT INTO chunks_fts VALUES (?, ?, ?, ?)')
        for (const chunk of chunks) {
          const location = chunk.pageOrSlide ? `${chunk.kind === 'pdfPage' ? 'Page' : 'Slide'} ${chunk.pageOrSlide}${chunk.kind === 'speakerNotes' ? ' notes' : ''}` : chunk.section ?? chunk.kind
          insertChunk.run(chunk.id, id, chunk.text, location, chunk.kind, chunk.pageOrSlide ?? null, chunk.section ?? null)
          insertFts.run(chunk.id, chunk.text, location, documentName(path))
        }
        this.db!.exec('COMMIT')
      } catch (error) { this.db!.exec('ROLLBACK'); throw error }
      docs.push({ id, name: documentName(path), path, kind: documentKind(path), chunkCount: chunks.length, addedAt })
    }
    await this.store.setDocuments(docs); return docs
  }
  async remove(id: string): Promise<void> {
    const chunkIds = this.db!.prepare('SELECT id FROM chunks WHERE document_id = ?').all(id) as Array<{ id: string }>
    const delFts = this.db!.prepare('DELETE FROM chunks_fts WHERE id = ?')
    this.db!.exec('BEGIN'); try {
      chunkIds.forEach(({ id: chunkId }) => delFts.run(chunkId))
      this.db!.prepare('DELETE FROM chunks WHERE document_id = ?').run(id); this.db!.prepare('DELETE FROM documents WHERE id = ?').run(id); this.db!.exec('COMMIT')
    } catch (error) { this.db!.exec('ROLLBACK'); throw error }
    await this.store.setDocuments(this.store.documents.filter((doc) => doc.id !== id))
  }
  search(query: string, limit = 5): RetrievedChunk[] {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 16) ?? []
    if (!terms.length) return []
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const rows = this.db!.prepare(`SELECT c.*, d.name AS document_name, bm25(chunks_fts, 0, 1.0, 0.4, 0.6) AS score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.id JOIN documents d ON d.id = c.document_id WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`).all(expression, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id), documentId: String(row.document_id), text: String(row.text), kind: String(row.kind) as DocumentChunk['kind'],
      pageOrSlide: row.page_or_slide == null ? undefined : Number(row.page_or_slide), section: row.section == null ? undefined : String(row.section),
      documentName: String(row.document_name), location: String(row.location), score: Number(row.score)
    }))
  }
  close(): void { this.db?.close() }
}
