import React, { useRef, useState } from 'react'
import type {
  DocumentImportOutcome, DocumentInfo, DocumentInspectionPage, DocumentSearchHit
} from '../shared/contracts'

const errorGuidance: Record<string, string> = {
  unsupported_type: 'Choose a PPTX, PDF, Markdown, or UTF-8 text file.',
  unreadable: 'Check that the file still exists and that PresenterAI can read it.',
  malformed: 'The file structure is invalid. Export a fresh copy and try again.',
  encrypted: 'Encrypted files are not supported. Export an unencrypted copy.',
  password_protected: 'Password-protected PDFs are not supported. Save an unlocked copy.',
  empty: 'No searchable text was found. Image-only files require OCR, which is not included yet.'
}

export function DocumentsView({ documents, onChange }: { documents: DocumentInfo[]; onChange(): Promise<void> }): React.JSX.Element {
  const [outcomes, setOutcomes] = useState<DocumentImportOutcome[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DocumentSearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [inspection, setInspection] = useState<DocumentInspectionPage>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRequest = useRef(0)

  const add = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.presenter.selectDocuments()
      setOutcomes(result.outcomes)
      await onChange()
    } catch (value) { setError((value as Error).message || 'Document import failed.') }
    finally { setBusy(false) }
  }

  const search = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault(); setError('')
    if (!query.trim()) { setHits([]); setSearched(false); return }
    const requestId = ++searchRequest.current
    setHits([]); setSearched(false); setBusy(true)
    try {
      const results = await window.presenter.searchDocuments(query)
      if (searchRequest.current === requestId) { setHits(results); setSearched(true) }
    } catch (value) {
      if (searchRequest.current === requestId) {
        setHits([]); setSearched(false); setError((value as Error).message || 'Local search failed.')
      }
    }
    finally { setBusy(false) }
  }

  const inspect = async (documentId: string, offset = 0): Promise<void> => {
    setBusy(true); setError('')
    try { setInspection(await window.presenter.inspectDocument(documentId, offset, 50)) }
    catch (value) { setError((value as Error).message || 'Document inspection failed.') }
    finally { setBusy(false) }
  }

  return <div className="stack documents-view">
    <div className="section-heading"><div><h2>Local documents</h2><p>Search and inspect the local index. Only selected evidence chunks are sent to OpenAI when you ask a question.</p></div><button className="primary" disabled={busy} onClick={() => void add()}>Add files</button></div>

    {error && <div className="notice danger" role="alert">{error}</div>}
    {outcomes.length > 0 && <section aria-label="Import outcomes" className="import-outcomes">
      <h3>LAST IMPORT</h3>
      {outcomes.map((outcome, index) => <div className={`import-outcome ${outcome.status}`} key={`${outcome.path}:${index}`}>
        <div><strong>{outcome.name}</strong><small>{outcome.status}</small></div>
        {outcome.error && <p><span>{outcome.error.message}</span> {errorGuidance[outcome.error.code]}</p>}
      </div>)}
    </section>}

    <form className="document-search" onSubmit={(event) => void search(event)}>
      <label htmlFor="document-search">Search indexed content</label>
      <div className="actions"><input id="document-search" value={query} maxLength={500} onChange={(event) => { searchRequest.current += 1; setQuery(event.target.value); setHits([]); setSearched(false); setError('') }} placeholder="Try an acronym, slide title, filename, or quoted fact" /><button disabled={busy || !query.trim()} type="submit">Search locally</button></div>
    </form>

    {searched && hits.length > 0 && <section className="search-results" aria-label="Document search results"><h3>TOP LOCAL MATCHES</h3>{hits.map((hit) => <button className="search-hit" key={hit.chunkId} onClick={() => void inspect(hit.documentId)}>
      <span><strong>{hit.title || hit.documentName}</strong><small>{hit.documentName} · {hit.location}</small></span><p>{hit.preview}</p>
    </button>)}</section>}
    {searched && !busy && hits.length === 0 && <p className="muted search-empty">No local matches. Try exact project terminology, an acronym, title, or filename.</p>}

    <section aria-label="Indexed documents" className="stack">
      {documents.length === 0 ? <div className="notice">No documents indexed. Add PPTX, PDF, Markdown, or UTF-8 text files.</div> : documents.map((doc) => <div className="document" key={doc.id}><button className="document-main" onClick={() => void inspect(doc.id)}><strong>{doc.name}</strong><small>{doc.kind.toUpperCase()} · {doc.chunkCount} chunks</small></button><button onClick={async () => { setError(''); try { await window.presenter.removeDocument(doc.id); if (inspection?.document.id === doc.id) setInspection(undefined); await onChange() } catch (value) { setError((value as Error).message || 'Document removal failed.') } }}>Remove</button></div>)}
    </section>

    {inspection && <section className="inspection" aria-label="Document inspection">
      <div className="section-heading"><div><h2>{inspection.document.name}</h2><p>{inspection.total} indexed chunks · showing {inspection.total === 0 ? 0 : inspection.offset + 1}–{Math.min(inspection.offset + inspection.chunks.length, inspection.total)}</p></div><button onClick={() => setInspection(undefined)}>Close</button></div>
      {inspection.chunks.map((chunk) => <article className="inspection-chunk" key={chunk.id}><div><strong>{chunk.title || chunk.location}</strong><small>{chunk.location} · {chunk.kind}{chunk.partCount > 1 ? ` · part ${chunk.part}/${chunk.partCount}` : ''}</small></div><p>{chunk.text}</p></article>)}
      <div className="inspection-pagination"><button disabled={busy || inspection.offset === 0} onClick={() => void inspect(inspection.document.id, Math.max(0, inspection.offset - inspection.limit))}>Previous</button><button disabled={busy || !inspection.hasMore} onClick={() => void inspect(inspection.document.id, inspection.offset + inspection.limit)}>Next</button></div>
    </section>}
  </div>
}
