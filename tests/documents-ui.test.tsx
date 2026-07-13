// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PresenterAPI } from '../src/shared/contracts'
import { DocumentsView } from '../src/renderer/documents'

const document = { id: 'doc-1', name: 'deck.pptx', path: 'C:\\fixtures\\deck.pptx', kind: 'pptx' as const, chunkCount: 51, addedAt: '2026-07-13T00:00:00Z' }

function installPresenter(overrides: Partial<PresenterAPI>): void {
  Object.defineProperty(window, 'presenter', { configurable: true, value: overrides as PresenterAPI })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('documents view', () => {
  it('keeps successful siblings visible while explaining a failed import', async () => {
    const onChange = vi.fn(async () => undefined)
    installPresenter({ selectDocuments: vi.fn(async () => ({ documents: [document], outcomes: [
      { path: document.path, name: document.name, status: 'added', documentId: document.id },
      { path: 'C:\\fixtures\\locked.pdf', name: 'locked.pdf', status: 'failed', error: { code: 'password_protected', message: 'The PDF requires a password.' } }
    ] })) })
    render(<DocumentsView documents={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
    expect(await screen.findByText('deck.pptx')).toBeTruthy()
    expect(screen.getByText(/Save an unlocked copy/)).toBeTruthy()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('searches locally and inspects bounded pages', async () => {
    const searchDocuments = vi.fn(async () => [{
      chunkId: 'chunk-1', documentId: document.id, documentName: document.name, title: 'Retrieval design',
      location: 'Slide 7', kind: 'slide' as const, preview: 'SQLite FTS5 ranks local chunks.'
    }])
    const inspectDocument = vi.fn(async (_id: string, offset = 0) => ({
      document, offset, limit: 50, total: 51, hasMore: offset === 0,
      chunks: [{ id: `chunk-${offset}`, title: 'Retrieval design', location: 'Slide 7', kind: 'slide' as const, text: 'SQLite FTS5 ranks local chunks.', part: 1, partCount: 1 }]
    }))
    installPresenter({ searchDocuments, inspectDocument, removeDocument: vi.fn(async () => undefined) })
    render(<DocumentsView documents={[document]} onChange={async () => undefined} />)
    fireEvent.change(screen.getByLabelText('Search indexed content'), { target: { value: 'FTS5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locally' }))
    expect(await screen.findByText('SQLite FTS5 ranks local chunks.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Retrieval design/ }))
    expect(await screen.findByLabelText('Document inspection')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(inspectDocument).toHaveBeenLastCalledWith(document.id, 50, 50))
  })

  it('clears stale hits when the query changes or a later search fails', async () => {
    const searchDocuments = vi.fn()
      .mockResolvedValueOnce([{
        chunkId: 'chunk-1', documentId: document.id, documentName: document.name,
        location: 'Slide 7', kind: 'slide' as const, preview: 'Old-query evidence.'
      }])
      .mockRejectedValueOnce(new Error('Local index unavailable.'))
    installPresenter({ searchDocuments })
    render(<DocumentsView documents={[]} onChange={async () => undefined} />)
    const input = screen.getByLabelText('Search indexed content')
    fireEvent.change(input, { target: { value: 'old query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locally' }))
    expect(await screen.findByText('Old-query evidence.')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'new query' } })
    expect(screen.queryByText('Old-query evidence.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Search locally' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Local index unavailable.')
    expect(screen.queryByText('Old-query evidence.')).toBeNull()
  })

  it('ignores an in-flight result after the user changes the query', async () => {
    let resolveSearch!: (value: Awaited<ReturnType<PresenterAPI['searchDocuments']>>) => void
    const searchDocuments = vi.fn(() => new Promise<Awaited<ReturnType<PresenterAPI['searchDocuments']>>>((resolve) => { resolveSearch = resolve }))
    installPresenter({ searchDocuments })
    render(<DocumentsView documents={[]} onChange={async () => undefined} />)
    const input = screen.getByLabelText('Search indexed content')
    fireEvent.change(input, { target: { value: 'old query' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locally' }))
    fireEvent.change(input, { target: { value: 'new query' } })
    resolveSearch([{
      chunkId: 'old', documentId: document.id, documentName: document.name,
      location: 'Slide 1', kind: 'slide', preview: 'Late old-query result.'
    }])
    await waitFor(() => expect(searchDocuments).toHaveBeenCalledOnce())
    expect(screen.queryByText('Late old-query result.')).toBeNull()
  })
})
