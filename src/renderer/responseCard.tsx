import React from 'react'
import type { AssistantResponse } from '../shared/contracts'

export type EvidenceSupport = 'document-supported' | 'general' | 'evidence-unavailable'

export function evidenceSupport(response: AssistantResponse): EvidenceSupport {
  if (response.warning) return 'evidence-unavailable'
  return response.evidence.length > 0 ? 'document-supported' : 'general'
}

const labels: Record<EvidenceSupport, string> = {
  'document-supported': 'Document-supported',
  general: 'General explanation',
  'evidence-unavailable': 'Evidence unavailable'
}

export function ResponseCard({ response }: { response: AssistantResponse }): React.JSX.Element {
  const support = evidenceSupport(response)
  return <article className="response-card">
    <div className="response-labels"><span className="category">{response.category}</span><span className={`support-badge ${support}`} aria-label="Evidence support">{labels[support]}</span></div>
    <h3>SAY</h3><p className="say">{response.say}</p>
    <h3>KEY POINTS</h3><ul>{response.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul>
    <h3>IF CHALLENGED</h3><p>{response.ifChallenged}</p>
    {response.warning && <div className="warning-box"><strong>WARNING</strong><p>{response.warning}</p></div>}
    {response.evidence.length > 0 && <details><summary>{response.evidence.length} evidence source(s)</summary>{response.evidence.map((item) => <p key={item.chunkId}>{item.documentName} · {item.location}</p>)}</details>}
  </article>
}
