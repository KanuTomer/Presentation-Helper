// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canInsertTranscriptDirectly, mergeTranscriptDraft, TranscriptDraftNotice
} from '../src/renderer/transcriptDraft'
import { transcriptionDraftSchema } from '../src/shared/contracts'

const draft = {
  operationId: 'audio-2', text: 'What evidence supports the selected architecture?', durationMs: 1_250,
  endpointId: 'render-default', endpointName: 'Speakers', createdAt: '2026-07-22T00:00:00.000Z'
}

afterEach(cleanup)

describe('editable transcript drafts', () => {
  it('inserts directly only when the same capture began with an untouched empty composer', () => {
    const snapshot = { operationId: 'audio-2', text: '', revision: 3 }
    expect(canInsertTranscriptDirectly(snapshot, 'audio-2', '', 3)).toBe(true)
    expect(canInsertTranscriptDirectly(snapshot, 'audio-1', '', 3)).toBe(false)
    expect(canInsertTranscriptDirectly(snapshot, 'audio-2', 'typed meanwhile', 4)).toBe(false)
    expect(canInsertTranscriptDirectly({ ...snapshot, text: 'existing' }, 'audio-2', '', 3)).toBe(false)
  })

  it('offers Replace, Append, and Discard without modifying transcript whitespace', () => {
    const resolve = vi.fn()
    render(<TranscriptDraftNotice draft={draft} conflict onResolve={resolve} />)
    expect(screen.getByText(/1.3s from Speakers/)).toBeTruthy()
    expect(screen.getByLabelText('Recognized transcript').textContent).toBe(draft.text)
    for (const choice of ['Replace', 'Append', 'Discard'] as const) {
      fireEvent.click(screen.getByRole('button', { name: choice }))
    }
    expect(resolve.mock.calls).toEqual([['replace'], ['append'], ['discard']])
    expect(mergeTranscriptDraft('Existing text', draft.text, 'append')).toBe(`Existing text\n\n${draft.text}`)
    expect(mergeTranscriptDraft('ignored', draft.text, 'replace')).toBe(draft.text)
  })

  it('shows review guidance for a directly inserted transcript', () => {
    render(<TranscriptDraftNotice draft={draft} conflict={false} onResolve={vi.fn()} />)
    expect(screen.getByText(/review before sending/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull()
  })

  it('rejects oversized, malformed, or expanded transcript IPC payloads', () => {
    expect(transcriptionDraftSchema.safeParse({ ...draft, text: 'x'.repeat(4_001) }).success).toBe(false)
    expect(transcriptionDraftSchema.safeParse({ ...draft, durationMs: 249 }).success).toBe(false)
    expect(transcriptionDraftSchema.safeParse({ ...draft, unexpected: 'not allowed' }).success).toBe(false)
  })
})
