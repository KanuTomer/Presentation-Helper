// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantResponse } from '../src/shared/contracts'
import type { PresenterCommand } from '../src/shared/presenterShortcuts'
import { blankStatus } from '../src/renderer/appState'
import { PresenterApp } from '../src/renderer/presenter'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const answer: AssistantResponse = {
  responseStyle: 'developer', support: 'general-technical', evidenceIssue: 'none', summary: 'Two blocks.',
  codeBlocks: [{ language: 'ts', code: 'export const first = 1' }, { language: 'ts', code: 'export const second = 2' }],
  implementationNotes: ['Note.'], caveats: [], evidence: []
}

async function harness(hasKey = true, operation: string = 'idle') {
  let command: (value: PresenterCommand) => void = () => undefined
  const noop = vi.fn(() => () => undefined)
  const presenter = {
    getStatus: vi.fn(async () => ({ ...blankStatus, operation, workspace: { mode: 'presenter' } })),
    getSettings: vi.fn(async () => undefined), listDocuments: vi.fn(async () => []),
    getApiKeyStatus: vi.fn(async () => ({ configured: hasKey, masked: hasKey, protection: 'windows-dpapi' as const })),
    getUsage: vi.fn(async () => undefined),
    onStatus: noop, onFocusAsk: noop, onGlassDisplay: noop, onTranscriptDraft: noop, onError: noop,
    getGlassDisplay: vi.fn(async () => ({ x: 0, y: 0, width: 1920, height: 1080 })),
    onPresenterCommand: vi.fn((callback: (value: PresenterCommand) => void) => { command = callback; return () => undefined }),
    ask: vi.fn(async () => ({ ok: true, response: answer })),
    askAboutScreen: vi.fn(async () => ({ ok: true, response: answer })),
    cancel: vi.fn(async () => ({ ok: true })),
    attachScreenshot: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000000', expiresAt: new Date(Date.now() + 600_000).toISOString() })),
    discardScreenshot: vi.fn(async () => undefined),
    copyCode: vi.fn(async () => undefined)
  }
  Object.defineProperty(window, 'presenter', { configurable: true, value: presenter })
  render(<PresenterApp />)
  const box = await screen.findByPlaceholderText('Ask a question…')
  await waitFor(() => expect(presenter.getApiKeyStatus).toHaveBeenCalled())
  const run = (value: PresenterCommand) => act(() => { command(value) })
  return { presenter, box, run }
}

describe('presenter keyboard commands', () => {
  it('sends only when the Send button would be enabled', async () => {
    const h = await harness()
    await h.run('send')
    expect(h.presenter.ask).not.toHaveBeenCalled() // nothing typed or attached
    fireEvent.change(h.box, { target: { value: 'Explain the cache.' } })
    await h.run('send')
    await waitFor(() => expect(h.presenter.ask).toHaveBeenCalledWith('Explain the cache.', 'code'))
  })

  it('does not send without an API key', async () => {
    const h = await harness(false)
    fireEvent.change(h.box, { target: { value: 'Explain the cache.' } })
    await h.run('send')
    expect(h.presenter.ask).not.toHaveBeenCalled()
  })

  it('switches format, attaches a snapshot, folds, and copies code blocks in turn', async () => {
    const h = await harness()
    await h.run('format')
    expect(screen.getByRole('button', { name: 'Presenter', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await h.run('snapshot')
    await screen.findByText(/Screenshot attached/)
    expect(h.presenter.attachScreenshot).toHaveBeenCalledOnce()

    await h.run('fold') // no answer yet: ignored
    await h.run('copy')
    expect(h.presenter.copyCode).not.toHaveBeenCalled()

    await h.run('snapshot') // remove the attachment again
    expect(h.presenter.discardScreenshot).toHaveBeenCalledOnce()
    fireEvent.change(h.box, { target: { value: 'Write two exports.' } })
    await h.run('format')
    await h.run('send')
    await screen.findByText('Two blocks.')
    await h.run('copy'); await h.run('copy'); await h.run('copy')
    expect(h.presenter.copyCode.mock.calls.map(([code]) => code)).toEqual(['export const first = 1', 'export const second = 2', 'export const first = 1'])
    await h.run('fold')
    expect(screen.queryByText('Two blocks.')).toBeNull()
    await h.run('fold')
    expect(screen.getByText('Two blocks.')).toBeTruthy()
  })

  it('submits once when Send is pressed twice before main reports busy', async () => {
    const h = await harness()
    let finish!: (value: unknown) => void
    h.presenter.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }) as never)
    fireEvent.change(h.box, { target: { value: 'Explain the cache.' } })
    await h.run('send'); await h.run('send')
    expect(h.presenter.ask).toHaveBeenCalledOnce()
    await act(async () => { finish({ ok: true, response: answer }) })
    await screen.findByText('Two blocks.')
  })

  it('retries a screenshot question with a fresh screenshot', async () => {
    const h = await harness()
    h.presenter.askAboutScreen.mockResolvedValueOnce({ ok: false, error: { code: 'rate_limit', message: 'Slow down.', retryable: true } } as never)
    await h.run('snapshot'); await screen.findByText(/Screenshot attached/)
    fireEvent.change(h.box, { target: { value: 'Why PostgreSQL?' } })
    await h.run('send'); await screen.findByText('Slow down.')
    await h.run('retry')
    await screen.findByText('Two blocks.')
    expect(h.presenter.attachScreenshot).toHaveBeenCalledTimes(2)
    expect(h.presenter.askAboutScreen).toHaveBeenCalledTimes(2)
    expect(h.presenter.ask).not.toHaveBeenCalled()
  })

  it('cancels only while a request is running', async () => {
    const idle = await harness()
    await idle.run('cancel'); expect(idle.presenter.cancel).not.toHaveBeenCalled()
    cleanup()
    const busy = await harness(true, 'generating')
    fireEvent.change(busy.box, { target: { value: 'Explain the cache.' } }) // with text, only busy disables Send
    await waitFor(() => expect(document.querySelector('.composer-send')?.hasAttribute('disabled')).toBe(true))
    await busy.run('cancel'); expect(busy.presenter.cancel).toHaveBeenCalledOnce()
  })

  it('briefly marks the control a shortcut pressed', async () => {
    const h = await harness()
    await h.run('format')
    await waitFor(() => expect(document.querySelector('.shell')?.getAttribute('data-flash')).toBe('format'))
  })
})
