// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiErrorPanel } from '../src/renderer/aiError'

describe('AI error recovery UI', () => {
  it('routes invalid-key failures to Settings without offering a blind retry', () => {
    const settings = vi.fn(); const retry = vi.fn()
    render(<AiErrorPanel error={{ code: 'invalid_key', message: 'Invalid key.', retryable: false }} onRetry={retry} onOpenSettings={settings} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(settings).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
  it('offers retry only for retryable failures and exposes the typed code', () => {
    const retry = vi.fn()
    const { container } = render(<AiErrorPanel error={{ code: 'offline', message: 'Offline.', retryable: true }} onRetry={retry} onOpenSettings={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce(); expect(container.querySelector('[data-error-code="offline"]')).not.toBeNull()
  })
  it('renders output-budget exhaustion as a distinct actionable error', () => {
    const { container } = render(<AiErrorPanel error={{ code: 'output_limit', message: 'Response budget exhausted.', retryable: true }} onRetry={() => undefined} onOpenSettings={() => undefined} />)
    expect(within(container).getByText('Response budget exhausted')).toBeTruthy()
    expect(within(container).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
