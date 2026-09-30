// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotButton } from '../src/renderer/snapshot'
import { ResponseCard } from '../src/renderer/responseCard'
import type { PresenterAPI, SolutionAssistantResponse } from '../src/shared/contracts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function harness(canSend = true) {
  const captureSnapshot = vi.fn(async () => ({ id: 'snapshot-id', monitorId: '1', width: 100, height: 100, bytes: 20, dataUrl: 'data:image/png;base64,eA==', expiresAt: new Date(Date.now() + 600000).toISOString() }))
  const solveSnapshot = vi.fn(async () => ({ ok: false, error: { code: 'offline', message: 'Offline.', retryable: true } }))
  const discardSnapshot = vi.fn(async () => undefined)
  window.presenter = { listSnapshotMonitors: vi.fn(async () => [{ id: '1', current: true, name: 'Monitor', width: 100, height: 100 }]), captureSnapshot, solveSnapshot, discardSnapshot } as unknown as PresenterAPI
  render(<SnapshotButton disabled={false} canSend={canSend} sessionId="session" onResponse={vi.fn()} onError={vi.fn()} />)
  return { captureSnapshot, solveSnapshot, discardSnapshot }
}
describe('explicit screenshot preview', () => {
  it('ignores a late capture after New Session and keeps images out of the new session', async () => {
    let resolve!: (value: unknown) => void
    window.presenter = { listSnapshotMonitors: async () => [], captureSnapshot: () => new Promise((accept) => { resolve = accept }), discardSnapshot: vi.fn(async () => undefined) } as unknown as PresenterAPI
    const props = { disabled: false, canSend: false, onResponse: vi.fn(), onError: vi.fn() }
    const view = render(<SnapshotButton {...props} sessionId="old" />)
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    view.rerender(<SnapshotButton {...props} sessionId="new" />)
    resolve({ id: 'old-image', dataUrl: 'data:image/png;base64,eA==', expiresAt: new Date(Date.now() + 600000).toISOString() })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Snapshot' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('allows keyless preview and Retake but blocks Send, then restores focus on Escape', async () => {
    const h = harness(false)
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    const dialog = await screen.findByRole('dialog')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(h.solveSnapshot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retake' }))
    await waitFor(() => expect(h.captureSnapshot).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Snapshot' }))
    expect(dialog.isConnected).toBe(false)
  })
  it('never dispatches before Send and has no crop or prompt control', async () => {
    const h = harness(); fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    await screen.findByRole('dialog'); expect(h.solveSnapshot).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button', { name: /crop/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await waitFor(() => expect(h.solveSnapshot).toHaveBeenCalledWith('snapshot-id'))
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('Discard clears the image without a model call', async () => {
    const h = harness(); fireEvent.click(screen.getByRole('button', { name: 'Snapshot' })); await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(h.discardSnapshot).toHaveBeenCalled(); expect(h.solveSnapshot).not.toHaveBeenCalled()
  })
  it('renders equations safely and never executes code or external LaTeX links', () => {
    const response: SolutionAssistantResponse = { responseStyle: 'solution', task: 'math', interpretedProblem: 'Solve a matrix.', explanation: 'A mathematical solution.', equations: ['\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}', '\\href{javascript:alert(1)}{unsafe}'], steps: ['Compute the determinant.'], finalResult: '−2', codeBlocks: [], clarification: '', support: 'general-technical', evidenceIssue: 'none', evidence: [] }
    const { container } = render(<ResponseCard response={response} />)
    expect(container.querySelector('math')).toBeTruthy(); expect(container.querySelector('a[href^="javascript:"]')).toBeNull(); expect(container.querySelector('script')).toBeNull()
  })
})
