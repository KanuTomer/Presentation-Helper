// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStatus, PresenterAPI } from '../src/shared/contracts'
import { AnswerRenderAcknowledger, ToggleListenButton, OperationBanner, StageTimingSummary } from '../src/renderer/operationUi'

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

  it('uses one atomic action for both start and stop toggles', async () => {
    const toggle = vi.fn(async () => ({ ok: true as const }))
    installPresenter({ toggleListening: toggle })
    const { rerender } = render(<ToggleListenButton status={status()} onError={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '◉ Start listening' }))
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(1))
    rerender(<ToggleListenButton status={status({ operation: 'listening', operationKind: 'audio', operationId: 'audio-1' })} onError={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '■ Stop & answer' }))
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(2))
  })

  it('allows a fresh toggle from an error display and disables it during downstream work', async () => {
    const toggle = vi.fn(async () => ({ ok: true as const }))
    installPresenter({ toggleListening: toggle })
    const { rerender } = render(<ToggleListenButton status={status({ operation: 'error' })} onError={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '◉ Start listening' }))
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(1))
    rerender(<ToggleListenButton status={status({ operation: 'transcribing', operationKind: 'audio', operationId: 'audio-1' })} onError={() => undefined} />)
    expect((screen.getByRole('button', { name: '◉ Start listening' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('acknowledges the first rendered answer frame with its operation ID', async () => {
    const acknowledge = vi.fn(async () => undefined)
    const rendered = vi.fn()
    installPresenter({ ackAnswerVisible: acknowledge })

    render(<AnswerRenderAcknowledger operationId="audio-answer-1" onAcknowledged={rendered} onError={() => undefined} />)

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('audio-answer-1'))
    expect(rendered).toHaveBeenCalledWith('audio-answer-1')
  })

  it('surfaces typed helper/device failures from the toggle action', async () => {
    const error = { code: 'device_unavailable' as const, message: 'The selected endpoint disappeared.', retryable: true }
    installPresenter({ toggleListening: vi.fn(async () => ({ ok: false as const, error })) })
    const onError = vi.fn()
    render(<ToggleListenButton status={status()} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: '◉ Start listening' }))
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
