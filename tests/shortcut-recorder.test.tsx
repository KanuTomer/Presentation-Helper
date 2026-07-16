// @vitest-environment jsdom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceleratorFromKeyboardEvent,
  DEFAULT_SHORTCUTS,
  ShortcutRecorder,
  ShortcutSettingsPanel
} from '../src/renderer/shortcutRecorder'

afterEach(cleanup)

describe('shortcut recorder', () => {
  it('canonicalizes the supported keyboard subset', () => {
    expect(acceleratorFromKeyboardEvent({ key: ' ', ctrlKey: true, shiftKey: true, altKey: false })).toBe('Control+Shift+Space')
    expect(acceleratorFromKeyboardEvent({ key: 'f24', ctrlKey: false, shiftKey: false, altKey: true })).toBe('Alt+F24')
    expect(acceleratorFromKeyboardEvent({ key: 'Control', ctrlKey: true, shiftKey: false, altKey: false })).toBeUndefined()
    expect(() => acceleratorFromKeyboardEvent({ key: 'x', ctrlKey: false, shiftKey: false, altKey: false })).toThrow(/modifier/i)
    expect(() => acceleratorFromKeyboardEvent({ key: 'Enter', ctrlKey: true, shiftKey: false, altKey: false })).toThrow(/Space/i)
  })

  it('records a combination, ignores autorepeat, and cancels with Escape', async () => {
    const commit = vi.fn()
    render(<ShortcutRecorder label="Ask" value="Control+Space" onCommit={commit} />)
    const record = screen.getByRole('button', { name: 'Record Ask shortcut' })
    fireEvent.click(record)
    fireEvent.keyDown(record, { key: 'H', ctrlKey: true, shiftKey: true, repeat: true })
    expect(commit).not.toHaveBeenCalled()
    fireEvent.keyDown(record, { key: 'Escape' })
    expect(screen.getByText(/recording cancelled/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Record Ask shortcut' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel recording Ask shortcut' }), { key: 'H', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(commit).toHaveBeenCalledWith('Control+Shift+H'))
  })

  it('keeps the emergency combination reserved and surfaces registration errors', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('The shortcut conflicts with another action.'))
    render(<ShortcutRecorder label="Ask" value="Control+Space" onCommit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Record Ask shortcut' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel recording Ask shortcut' }), { key: 'i', ctrlKey: true, shiftKey: true })
    expect(screen.getByText(/reserved/i)).toBeTruthy()
    expect(commit).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel recording Ask shortcut' }), { key: 'a', ctrlKey: true })
    await waitFor(() => expect(screen.getByText(/conflicts/i)).toBeTruthy())
  })

  it('restores all defaults in one patch', () => {
    const changed = vi.fn()
    function Harness(): React.JSX.Element {
      const [shortcuts, setShortcuts] = useState({ askShortcut: 'Alt+A', hideShortcut: 'Alt+H', listenShortcut: 'Alt+Space' })
      return <ShortcutSettingsPanel {...shortcuts} onChange={(patch) => { changed(patch); setShortcuts((current) => ({ ...current, ...patch })) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    expect(changed).toHaveBeenCalledWith(DEFAULT_SHORTCUTS)
    expect(screen.getByLabelText('Ask shortcut').textContent).toBe(DEFAULT_SHORTCUTS.askShortcut)
  })
})
