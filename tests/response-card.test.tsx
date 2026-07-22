// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantResponse } from '../src/shared/contracts'
import { ResponseCard, evidenceSupport } from '../src/renderer/responseCard'

const base: AssistantResponse = {
  category: 'FACTUAL', support: 'general-technical', evidenceIssue: 'none',
  say: 'A concise answer.', keyPoints: ['One', 'Two', 'Three'],
  ifChallenged: 'Explain the evidence boundary.', evidence: []
}

afterEach(cleanup)

describe('response evidence badges', () => {
  it('distinguishes supported, general, and unavailable evidence', () => {
    expect(evidenceSupport(base)).toBe('general-technical')
    const { rerender } = render(<ResponseCard response={base} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('General technical explanation')
    const unavailable: AssistantResponse = {
      ...base, support: 'unsupported-project-claim', evidenceIssue: 'missing',
      warning: 'No project evidence is available.'
    }
    expect(evidenceSupport(unavailable)).toBe('unsupported-project-claim')
    rerender(<ResponseCard response={unavailable} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('Project evidence unavailable')
    const supported: AssistantResponse = {
      ...base, support: 'document-supported',
      evidence: [{ chunkId: 'chunk-1', documentName: 'deck.pptx', location: 'Slide 7' }]
    }
    expect(evidenceSupport(supported)).toBe('document-supported')
    rerender(<ResponseCard response={supported} />)
    expect(screen.getByLabelText('Evidence support').textContent).toBe('Document-supported')
    expect(evidenceSupport({ ...supported, warning: 'A supplemental caution.' })).toBe('document-supported')
  })
})

describe('structured code cards', () => {
  it('renders inert highlighted code with exact whitespace and copies the original source', async () => {
    const code = 'export function SearchDropdown() {\n  const unsafe = "<script>alert(1)</script>"\n\n  return unsafe\n}\n'
    const copy = vi.fn(async () => undefined)
    const { container } = render(<ResponseCard
      response={{ ...base, codeBlocks: [{ language: 'tsx', title: 'SearchDropdown.tsx', code }] }}
      onCopyCode={copy}
    />)

    expect(screen.getByText('tsx')).toBeTruthy()
    expect(screen.getByText('SearchDropdown.tsx')).toBeTruthy()
    expect(screen.getByLabelText('SearchDropdown.tsx (tsx) source').textContent).toBe(code)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[dangerouslySetInnerHTML]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy SearchDropdown.tsx (tsx)' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(code))
    expect(await screen.findByText('Code copied.')).toBeTruthy()
  })

  it('renders multiple blocks before the presenter key points and disables copying without a narrow handler', () => {
    const { container } = render(<ResponseCard response={{
      ...base,
      codeBlocks: [
        { language: 'tsx', title: 'Component.tsx', code: 'export const Component = () => null' },
        { language: 'css', title: 'component.css', code: '.component { display: block; }' }
      ]
    }} />)
    expect(screen.getAllByRole('region')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(2)
    for (const button of screen.getAllByRole('button', { name: /^Copy / })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }

    const firstCode = container.querySelector('.code-block-card')
    const keyPoints = Array.from(container.querySelectorAll('h3')).find((heading) => heading.textContent === 'KEY POINTS')
    expect(firstCode?.compareDocumentPosition(keyPoints!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
