// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantResponse } from '../src/shared/contracts'
import { ResponseCard, evidenceSupport } from '../src/renderer/responseCard'

const base: AssistantResponse = {
  category: 'FACTUAL', say: 'A concise answer.', keyPoints: ['One', 'Two', 'Three'],
  ifChallenged: 'Explain the evidence boundary.', evidence: []
}

afterEach(cleanup)

describe('response evidence badges', () => {
  it('distinguishes supported, general, and unavailable evidence', () => {
    expect(evidenceSupport(base)).toBe('general')
    const { rerender } = render(<ResponseCard response={base} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('General explanation')
    const unavailable = { ...base, warning: 'No project evidence is available.' }
    expect(evidenceSupport(unavailable)).toBe('evidence-unavailable')
    rerender(<ResponseCard response={unavailable} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('Evidence unavailable')
    const supported = { ...base, evidence: [{ chunkId: 'chunk-1', documentName: 'deck.pptx', location: 'Slide 7' }] }
    expect(evidenceSupport(supported)).toBe('document-supported')
    rerender(<ResponseCard response={supported} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('Document-supported')
    expect(evidenceSupport({ ...supported, warning: 'The supplied evidence conflicts.' })).toBe('evidence-unavailable')
  })
})
