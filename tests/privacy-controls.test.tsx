// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ListeningConsentPanel,
  PrivacyDisclosure,
  RetentionControls,
  TransmissionPreviewPanel,
  UsageEstimatePanel,
  type RetentionActions
} from '../src/renderer/privacyControls'

let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('privacy controls', () => {
  it('persists only the required listening disclosure version', async () => {
    const accept = vi.fn()
    render(<ListeningConsentPanel consent={{ requiredVersion: 2, satisfied: false }} onAccept={accept} />)
    fireEvent.click(screen.getByRole('button', { name: /enable hold-to-listen/i }))
    await waitFor(() => expect(accept).toHaveBeenCalledWith(2))
  })

  it('acknowledges a visible operation-scoped preview after two frames', async () => {
    const rendered = vi.fn()
    render(<TransmissionPreviewPanel preview={{
      operationId: 'op-7', stage: 'response', rollingTurnCount: 1, includesProjectSummary: false,
      chunks: [{ chunkId: 'chunk-1', documentName: 'brief.pdf', title: 'Limits', location: 'page 4', text: 'The documented limit is five concurrent reviewers.' }]
    }} onRendered={rendered} />)
    expect(screen.getByText(/brief.pdf/)).toBeTruthy()
    expect(rendered).not.toHaveBeenCalled()
    await act(async () => { frames.shift()?.(1); frames.shift()?.(2) })
    expect(rendered).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveBeenCalledWith('op-7', 'response')
  })

  it('discloses retention, DPAPI limitations, and approximate INR pricing', () => {
    render(<><PrivacyDisclosure /><UsageEstimatePanel usage={{ estimatedUsd: 0.1, pricingVersion: 'prices-v2', requestCount: 3, unpricedRequestCount: 1, inrPerUsd: 85 }} /></>)
    expect(screen.getByText(/up to 30 days/i)).toBeTruthy()
    expect(screen.getByText(/same user/i)).toBeTruthy()
    expect(screen.getByText('≈ ₹8.50 INR')).toBeTruthy()
    expect(screen.getByText(/1 request is unpriced/i)).toBeTruthy()
  })

  it('requires the exact phrase and never describes source documents as deleted', async () => {
    const actions: RetentionActions = {
      clearSession: vi.fn(), clearUsage: vi.fn(), clearCompatibility: vi.fn(), clearDocuments: vi.fn(), deleteApiKey: vi.fn(),
      deleteAllData: vi.fn().mockResolvedValue({ ok: true })
    }
    render(<RetentionControls actions={actions} />)
    expect(screen.getByText(/never your original/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all local PresenterAI data' }))
    const confirmButton = screen.getByRole('button', { name: 'Delete all' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Delete all confirmation'), { target: { value: 'delete all' } })
    expect(confirmButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Delete all confirmation'), { target: { value: 'DELETE ALL' } })
    fireEvent.click(confirmButton)
    await waitFor(() => expect(actions.deleteAllData).toHaveBeenCalledTimes(1))
  })

  it('renders mixed per-scope delete-all results without hiding partial failure', async () => {
    const actions: RetentionActions = {
      clearSession: vi.fn(), clearUsage: vi.fn(), clearCompatibility: vi.fn(), clearDocuments: vi.fn(), deleteApiKey: vi.fn(),
      deleteAllData: vi.fn().mockResolvedValue({
        ok: false,
        message: '1 local-data scope could not be cleared.',
        results: [
          { scope: 'session', ok: true },
          { scope: 'documents', ok: false, message: 'SQLite index remained locked.' }
        ]
      })
    }
    render(<RetentionControls actions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete all local PresenterAI data' }))
    fireEvent.change(screen.getByLabelText('Delete all confirmation'), { target: { value: 'DELETE ALL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 local-data scope could not be cleared.'))
    expect(screen.getByText('session: cleared')).toBeTruthy()
    expect(screen.getByText('documents: SQLite index remained locked.')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Confirm deletion of all local data' })).toBeTruthy()
  })

  it('disables every retention action during active work', () => {
    const noOp = vi.fn().mockResolvedValue(undefined)
    render(<RetentionControls busy actions={{ clearSession: noOp, clearUsage: noOp, clearCompatibility: noOp, clearDocuments: noOp, deleteApiKey: noOp, deleteAllData: noOp }} />)
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Finish or cancel/i)).toBeTruthy()
  })
})
