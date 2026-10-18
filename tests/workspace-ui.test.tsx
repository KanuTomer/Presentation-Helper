// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SetupReturnConfirmation } from '../src/renderer/workspace'

afterEach(cleanup)
it('keeps the Setup warning in the renderer and requires a second deliberate action', async () => {
  const confirmSetup = vi.fn(async () => undefined), dismissSetupRequest = vi.fn(async () => undefined)
  Object.defineProperty(window, 'presenter', { configurable: true, value: { confirmSetup, dismissSetupRequest } })
  render(<SetupReturnConfirmation workspace={{ mode: 'presenter', setupRequest: 'settings' }} busy={false} onError={vi.fn()} />)
  expect(screen.getByRole('alertdialog').textContent).toContain('may appear in recordings')
  expect(confirmSetup).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stay in presenter' }))
  fireEvent.click(screen.getByRole('button', { name: 'Return to Setup' }))
  await waitFor(() => expect(confirmSetup).toHaveBeenCalledWith(false))
})
it('requires explicit cancellation when an operation is active and supports Escape', async () => {
  const confirmSetup = vi.fn(async () => undefined), dismissSetupRequest = vi.fn(async () => undefined)
  Object.defineProperty(window, 'presenter', { configurable: true, value: { confirmSetup, dismissSetupRequest } })
  render(<SetupReturnConfirmation workspace={{ mode: 'presenter', setupRequest: 'privacy' }} busy onError={vi.fn()} />)
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
  expect(dismissSetupRequest).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel operation & return' }))
  await waitFor(() => expect(confirmSetup).toHaveBeenCalledWith(true))
})
