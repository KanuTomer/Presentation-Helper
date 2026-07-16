// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStatus, PresenterAPI } from '../src/shared/contracts'
import { AnswerRenderAcknowledger, HoldToListenButton, OperationBanner, StageTimingSummary } from '../src/renderer/operationUi'

function status(patch: Partial<AppStatus> = {}): AppStatus {
  return {
    operation: 'idle', operationTimings: {}, listening: false, audioSource: 'Windows default output', temporaryAudioExists: false,
    helperAvailable: true, helperState: 'ready', audioDevices: [], shortcutWarnings: [],
    capture: { requested: true, electronReported: true, verifiedResults: [] }, ...patch
  }
}

function installPresenter(overrides: Partial<PresenterAPI>): void {
  Object.defineProperty(window, 'presenter', { configurable: true, value: overrides as PresenterAPI })
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(10); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('audio operation UI', () => {
  it.each([
    ['starting_capture', 'STARTING SYSTEM AUDIO'],
    ['finalizing', 'FINALIZING RECORDING'],
    ['transcribing', 'TRANSCRIBING'],
    ['retrieving', 'RETRIEVING EVIDENCE'],
    ['generating', 'GENERATING RESPONSE'],
    ['cancelling', 'CANCELLING']
  ] as const)('renders the %s stage without claiming to be listening', (operation, label) => {
    render(<OperationBanner status={status({ operation })} elapsedMs={0} onCancel={() => undefined} onError={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain(label)
    expect(screen.queryByText(/LISTENING/)).toBeNull()
  })

  it('shows the actual endpoint and acknowledges the first listening frame once per operation', async () => {
    const acknowledge = vi.fn(async () => undefined)
    installPresenter({ ackListeningIndicator: acknowledge })
    const first = status({
      operation: 'listening', operationId: 'audio-1', operationKind: 'audio', listening: true,
      activeAudioEndpoint: { id: 'speakers', name: 'Desk speakers', isDefault: true }
    })
    const { rerender } = render(<OperationBanner status={first} elapsedMs={1_250} onCancel={() => undefined} onError={() => undefined} />)
    expect(screen.getByRole('status').textContent).toContain('LISTENING · Desk speakers · 1.3s')
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('audio-1'))
    rerender(<OperationBanner status={{ ...first, operationTimings: { listeningMs: 1_250 } }} elapsedMs={1_300} onCancel={() => undefined} onError={() => undefined} />)
    expect(acknowledge).toHaveBeenCalledTimes(1)
    rerender(<OperationBanner status={{ ...first, operationId: 'audio-2' }} elapsedMs={0} onCancel={() => undefined} onError={() => undefined} />)
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('audio-2'))
  })

  it('latches a rapid pointer release by sending start and stop exactly once', async () => {
    const start = vi.fn(async () => ({ ok: true as const })); const stop = vi.fn(async () => ({ ok: true as const }))
    installPresenter({ startListening: start, stopListening: stop })
    render(<HoldToListenButton status={status()} onError={() => undefined} />)
    const button = screen.getByRole('button', { name: '◉ Hold to listen' })
    fireEvent.pointerDown(button, { pointerId: 7 }); fireEvent.pointerUp(button, { pointerId: 7 }); fireEvent.pointerUp(button, { pointerId: 7 })
    await waitFor(() => { expect(start).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce() })
  })

  it('clears a held-pointer latch after an external terminal transition', async () => {
    const start = vi.fn(async () => ({ ok: true as const }))
    const stop = vi.fn(async () => ({ ok: true as const }))
    installPresenter({ startListening: start, stopListening: stop })
    const { rerender } = render(<HoldToListenButton status={status()} onError={() => undefined} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: '◉ Hold to listen' }), { pointerId: 8 })
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    rerender(<HoldToListenButton status={status({ operation: 'listening', operationKind: 'audio', operationId: 'audio-1' })} onError={() => undefined} />)
    rerender(<HoldToListenButton status={status({ operation: 'finalizing', operationKind: 'audio', operationId: 'audio-1' })} onError={() => undefined} />)
    rerender(<HoldToListenButton status={status()} onError={() => undefined} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: '◉ Hold to listen' }), { pointerId: 9 })
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  })

  it('acknowledges the first rendered answer frame with its operation ID', async () => {
    const acknowledge = vi.fn(async () => undefined)
    const rendered = vi.fn()
    installPresenter({ ackAnswerVisible: acknowledge })

    render(<AnswerRenderAcknowledger operationId="audio-answer-1" onAcknowledged={rendered} onError={() => undefined} />)

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('audio-answer-1'))
    expect(rendered).toHaveBeenCalledWith('audio-answer-1')
  })

  it('surfaces typed helper/device failures from the hold action', async () => {
    const error = { code: 'device_unavailable' as const, message: 'The selected endpoint disappeared.', retryable: true }
    installPresenter({ startListening: vi.fn(async () => ({ ok: false as const, error })), stopListening: vi.fn(async () => ({ ok: true as const })) })
    const onError = vi.fn()
    render(<HoldToListenButton status={status()} onError={onError} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: '◉ Hold to listen' }), { pointerId: 1 })
    await waitFor(() => expect(onError).toHaveBeenCalledWith(error))
  })

  it('renders bounded stage and first-frame latency measurements', () => {
    render(<StageTimingSummary timings={{ captureStartMs: 84, transcriptionMs: 1_250, totalMs: 3_800 }} indicatorLatencyMs={112} />)
    expect(screen.getByText('84 ms')).toBeTruthy()
    expect(screen.getByText('112 ms')).toBeTruthy()
    expect(screen.getByText('1.25 s')).toBeTruthy()
    expect(screen.getByText('3.80 s')).toBeTruthy()
  })
})
