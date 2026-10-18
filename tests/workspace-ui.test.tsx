// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SetupReturnConfirmation, useWorkspaceAcknowledgement } from '../src/renderer/workspace'

afterEach(cleanup)
it('acknowledges the committed hidden workspace during layout without waiting for a painted frame', () => {
  const acknowledgeWorkspace = vi.fn(async () => undefined)
  Object.defineProperty(window, 'presenter', { configurable: true, value: { acknowledgeWorkspace } })
  const atLayout: number[] = []
  const onError = vi.fn()
  function HiddenWorkspace({ id }: { id?: string }) {
    useWorkspaceAcknowledgement(id, onError)
    useLayoutEffect(() => {
      expect(document.querySelector('[data-workspace-id]')?.getAttribute('data-workspace-id')).toBe(id ?? '')
      atLayout.push(acknowledgeWorkspace.mock.calls.length)
    }, [id])
    return <section hidden data-workspace-id={id ?? ''} />
  }
  const view = render(<HiddenWorkspace id="enter-1" />)
  expect(atLayout).toEqual([1])
  view.rerender(<HiddenWorkspace id="enter-1" />)
  expect(acknowledgeWorkspace).toHaveBeenCalledTimes(1)
  view.rerender(<HiddenWorkspace id="leave-2" />)
  expect(atLayout).toEqual([1, 2])
  expect(acknowledgeWorkspace).toHaveBeenLastCalledWith('leave-2')
  view.rerender(<HiddenWorkspace />)
  expect(acknowledgeWorkspace).toHaveBeenCalledTimes(2)
})
it('reports acknowledgement failure, but ignores a rejection from an expired transition', async () => {
  let reject!: (error: Error) => void
  const acknowledgeWorkspace = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  Object.defineProperty(window, 'presenter', { configurable: true, value: { acknowledgeWorkspace } })
  const onError = vi.fn()
  function Workspace({ id }: { id?: string }) { useWorkspaceAcknowledgement(id, onError); return null }
  const view = render(<Workspace id="expired" />)
  const rejectExpired = reject
  view.rerender(<Workspace id="current" />)
  rejectExpired(new Error('Old transition failed'))
  await Promise.resolve()
  expect(onError).not.toHaveBeenCalled()
  reject(new Error('Workspace acknowledgement failed'))
  await waitFor(() => expect(onError).toHaveBeenCalledWith({ code: 'unknown', message: 'Workspace acknowledgement failed', retryable: false }))
})
it('keeps the Setup warning in the renderer and requires a second deliberate action', async () => {
  const confirmSetup = vi.fn(async () => undefined), dismissSetupRequest = vi.fn(async () => undefined)
  Object.defineProperty(window, 'presenter', { configurable: true, value: { confirmSetup, dismissSetupRequest } })
  render(<SetupReturnConfirmation workspace={{ mode: 'presenter', transition: 'idle', setupRequest: 'settings' }} busy={false} onError={vi.fn()} />)
  expect(screen.getByRole('alertdialog').textContent).toContain('may appear in recordings')
  expect(confirmSetup).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stay in presenter' }))
  fireEvent.click(screen.getByRole('button', { name: 'Return to Setup' }))
  await waitFor(() => expect(confirmSetup).toHaveBeenCalledWith(false))
})
it('requires explicit cancellation when an operation is active and supports Escape', async () => {
  const confirmSetup = vi.fn(async () => undefined), dismissSetupRequest = vi.fn(async () => undefined)
  Object.defineProperty(window, 'presenter', { configurable: true, value: { confirmSetup, dismissSetupRequest } })
  render(<SetupReturnConfirmation workspace={{ mode: 'presenter', transition: 'idle', setupRequest: 'privacy' }} busy onError={vi.fn()} />)
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
  expect(dismissSetupRequest).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel operation & return' }))
  await waitFor(() => expect(confirmSetup).toHaveBeenCalledWith(true))
})
