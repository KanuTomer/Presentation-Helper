// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiErrorPanel } from '../src/renderer/aiError'

afterEach(cleanup)

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
  it.each([
    ['helper_unavailable', 'Windows audio helper unavailable'],
    ['device_unavailable', 'Audio output unavailable']
  ] as const)('routes %s recovery to Settings', (code, title) => {
    const settings = vi.fn()
    render(<AiErrorPanel error={{ code, message: 'Fix the audio setup.', retryable: false }} onRetry={() => undefined} onOpenSettings={settings} />)
    expect(screen.getByText(title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(settings).toHaveBeenCalledOnce()
  })
  it('keeps invalid audio and invalid transcript failures distinct', () => {
    const { rerender } = render(<AiErrorPanel error={{ code: 'invalid_audio', message: 'The WAV is too short.', retryable: true }} onRetry={() => undefined} onOpenSettings={() => undefined} />)
    expect(screen.getByText('Recording could not be used')).toBeTruthy()
    rerender(<AiErrorPanel error={{ code: 'invalid_transcript', message: 'No reviewer question was detected.', retryable: true }} onRetry={() => undefined} onOpenSettings={() => undefined} />)
    expect(screen.getByText('Reviewer speech was not understood')).toBeTruthy()
  })
  it('can suppress a retry when bounded audio has already been deleted', () => {
    render(<AiErrorPanel error={{ code: 'offline', message: 'Upload failed.', retryable: true }} allowRetry={false} onRetry={() => undefined} onOpenSettings={() => undefined} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
