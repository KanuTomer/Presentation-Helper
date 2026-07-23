// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, AssistantResponse } from '../src/shared/contracts'

vi.mock('../src/renderer/liquidGlass', () => ({
  LiquidGlassLayer: () => <div data-testid="liquid-glass" />
}))

import { App, blankStatus } from '../src/renderer/src'

const settings: AppSettings = {
  neonIntensity: 0.65, clickThrough: false, modelMode: 'normal',
  normalModel: 'gpt-5.6-luna', strongModel: 'gpt-5.6-terra',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H',
  listenShortcut: 'Control+Shift+Space', projectSummary: '',
  approvedVocabulary: [], sessionBudgetUsd: 0.25
}

const presenterResponse: AssistantResponse = {
  responseStyle: 'presenter', category: 'QUESTION',
  support: 'general-technical', evidenceIssue: 'none',
  say: 'A presenter response.', keyPoints: ['One.', 'Two.', 'Three.'],
  ifChallenged: 'State the limitation.', evidence: []
}

const developerResponse: AssistantResponse = {
  responseStyle: 'developer', support: 'general-technical', evidenceIssue: 'none',
  summary: 'A developer response.',
  codeBlocks: [{ language: 'ts', code: 'export const value = 1' }],
  implementationNotes: ['Use the typed result.'], evidence: []
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('renderer answer-format bridge', () => {
  it('submits one Presenter override, keeps Code visible while busy, then submits Code', async () => {
    const first = deferred<{ ok: true; response: AssistantResponse }>()
    let statusListener: ((status: typeof blankStatus) => void) | undefined
    const ask = vi.fn()
      .mockImplementationOnce(() => {
        statusListener?.({ ...blankStatus, operation: 'generating', operationKind: 'typed' })
        return first.promise
      })
      .mockResolvedValueOnce({ ok: true, response: developerResponse })
    const noopSubscription = vi.fn(() => () => undefined)
    const presenter = {
      getStatus: vi.fn(async () => blankStatus),
      getSettings: vi.fn(async () => settings),
      listDocuments: vi.fn(async () => []),
      getApiKeyStatus: vi.fn(async () => ({
        configured: true, masked: true, protection: 'windows-dpapi' as const
      })),
      getUsage: vi.fn(async () => ({
        summary: {
          inputTokens: 0, outputTokens: 0, audioMinutes: 0,
          transcriptionInputTokens: 0, transcriptionAudioTokens: 0,
          transcriptionOutputTokens: 0, estimatedUsd: 0,
          pricingVersion: 'openai-2026-07-16'
        },
        recent: [], rollups: []
      })),
      onStatus: vi.fn((listener: (status: typeof blankStatus) => void) => {
        statusListener = listener
        return () => undefined
      }),
      onFocusAsk: noopSubscription,
      onOpenSettings: noopSubscription,
      onOpenPrivacy: noopSubscription,
      onTranscriptDraft: noopSubscription,
      onError: noopSubscription,
      ask
    }
    Object.defineProperty(window, 'presenter', { configurable: true, value: presenter })

    render(<App />)
    const question = await screen.findByPlaceholderText('Ask a reviewer question…')
    fireEvent.change(question, { target: { value: 'Explain this architecture.' } })
    await waitFor(() => expect((screen.getByRole('button', { name: /Generate code/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Presenter', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /Ask presenter/ }))

    expect(ask).toHaveBeenNthCalledWith(1, 'Explain this architecture.', 'presenter')
    expect(screen.getByRole('button', { name: '</> Code' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('button', { name: '</> Code' }) as HTMLButtonElement).disabled).toBe(true)

    first.resolve({ ok: true, response: presenterResponse })
    await screen.findByText('A presenter response.')
    fireEvent.change(question, { target: { value: 'Write the TypeScript implementation.' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate code/ }))

    await waitFor(() => expect(ask).toHaveBeenNthCalledWith(2, 'Write the TypeScript implementation.', 'code'))
    await screen.findByText('A developer response.')
    expect(screen.getByRole('button', { name: '</> Code' }).getAttribute('aria-pressed')).toBe('true')
  })
})
