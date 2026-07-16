import React, { useEffect, useState } from 'react'

export const MAX_VOCABULARY_TERMS = 30
export const MAX_VOCABULARY_TERM_LENGTH = 64

function canonicalTerm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function ApprovedVocabularyEditor({ terms, onChange }: { terms: string[]; onChange(terms: string[]): Promise<void> | void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  useEffect(() => setError(''), [terms])

  const add = (): void => {
    const term = canonicalTerm(draft)
    if (!term) { setError('Enter a terminology hint first.'); return }
    if (Array.from(term).length > MAX_VOCABULARY_TERM_LENGTH) { setError(`Terms are limited to ${MAX_VOCABULARY_TERM_LENGTH} characters.`); return }
    if (terms.length >= MAX_VOCABULARY_TERMS) { setError(`Remove a term before adding more than ${MAX_VOCABULARY_TERMS}.`); return }
    if (terms.some((item) => canonicalTerm(item).toLocaleLowerCase() === term.toLocaleLowerCase())) { setError('That terminology hint is already approved.'); return }
    setDraft(''); setError(''); void onChange([...terms, term])
  }

  return <fieldset className="vocabulary-editor"><legend>Approved transcription vocabulary</legend>
    <p className="muted">Add project terms, acronyms, or names that may improve bounded-audio transcription. These hints may be sent to OpenAI only when transcribing.</p>
    <div className="actions"><input aria-label="Approved terminology hint" value={draft} onChange={(event) => { setDraft(event.target.value); setError('') }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder="e.g. PresenterAI" /><button disabled={terms.length >= MAX_VOCABULARY_TERMS} onClick={add}>Add term</button></div>
    <small>{terms.length}/{MAX_VOCABULARY_TERMS} approved terms · {MAX_VOCABULARY_TERM_LENGTH} characters maximum each</small>
    {error && <p className="field-error" role="alert">{error}</p>}
    {terms.length > 0 && <ul className="term-list" aria-label="Approved vocabulary">{terms.map((term) => <li key={term}><span>{term}</span><button aria-label={`Remove ${term}`} onClick={() => void onChange(terms.filter((item) => item !== term))}>×</button></li>)}</ul>}
  </fieldset>
}
