// @vitest-environment jsdom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovedVocabularyEditor, MAX_VOCABULARY_TERMS } from '../src/renderer/vocabularyEditor'

function Harness({ initial = [], changed = () => undefined }: { initial?: string[]; changed?(terms: string[]): void }): React.JSX.Element {
  const [terms, setTerms] = useState(initial)
  return <ApprovedVocabularyEditor terms={terms} onChange={(next) => { setTerms(next); changed(next) }} />
}

afterEach(cleanup)

describe('approved transcription vocabulary', () => {
  it('normalizes, adds, and removes an approved term', () => {
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    fireEvent.change(screen.getByLabelText('Approved terminology hint'), { target: { value: '  PresenterAI   helper  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add term' }))
    expect(screen.getByText('PresenterAI helper')).toBeTruthy()
    expect(changed).toHaveBeenLastCalledWith(['PresenterAI helper'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove PresenterAI helper' }))
    expect(changed).toHaveBeenLastCalledWith([])
  })

  it('rejects case-insensitive duplicates and terms longer than 64 Unicode characters', () => {
    render(<Harness initial={['PresenterAI']} />)
    const input = screen.getByLabelText('Approved terminology hint')
    fireEvent.change(input, { target: { value: 'presenterai' } }); fireEvent.click(screen.getByRole('button', { name: 'Add term' }))
    expect(screen.getByRole('alert').textContent).toContain('already approved')
    fireEvent.change(input, { target: { value: '🙂'.repeat(65) } }); fireEvent.click(screen.getByRole('button', { name: 'Add term' }))
    expect(screen.getByRole('alert').textContent).toContain('64 characters')
  })

  it('enforces the thirty-term limit in the editor', () => {
    render(<Harness initial={Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `term-${index + 1}`)} />)
    expect(screen.getByText('30/30 approved terms · 64 characters maximum each')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add term' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
