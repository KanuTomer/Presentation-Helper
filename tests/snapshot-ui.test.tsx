// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotChip, SnapshotButton } from '../src/renderer/snapshot'
import { ResponseCard } from '../src/renderer/responseCard'
import type { PresenterAPI, SolutionAssistantResponse } from '../src/shared/contracts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('snapshot attachment controls', () => {
  it('toggles a screenshot attachment without showing the image', () => {
    const onToggle = vi.fn()
    const view = render(<SnapshotButton attached={false} pending={false} disabled={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot' }))
    expect(onToggle).toHaveBeenCalledOnce()
    view.rerender(<SnapshotButton attached pending={false} disabled={false} onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: 'Snapshot ✓' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows that a screenshot is attached and can remove it', () => {
    const onRemove = vi.fn()
    render(<ScreenshotChip onRemove={onRemove} disabled={false} />)
    expect(screen.getByRole('status').textContent).toContain('Screenshot attached')
    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
  it('renders equations safely and never executes code or external LaTeX links', () => {
    const response: SolutionAssistantResponse = { responseStyle: 'solution', task: 'math', interpretedProblem: 'Solve a matrix.', explanation: 'A mathematical solution.', equations: ['\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}', '\\href{javascript:alert(1)}{unsafe}'], steps: ['Compute the determinant.'], finalResult: '−2', codeBlocks: [], clarification: '', support: 'general-technical', evidenceIssue: 'none', evidence: [] }
    const { container } = render(<ResponseCard response={response} />)
    expect(container.querySelector('math')).toBeTruthy(); expect(container.querySelector('a[href^="javascript:"]')).toBeNull(); expect(container.querySelector('script')).toBeNull()
  })
})
