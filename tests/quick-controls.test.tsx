// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerFormatAfterSubmission, ClickThroughBanner, CopilotQuickControls } from '../src/renderer/quickControls'

afterEach(cleanup)

describe('Copilot quick controls', () => {
  it('returns every one-request Presenter override to Code', () => {
    expect(answerFormatAfterSubmission()).toBe('code')
  })

  it('keeps Code visible and locks answer-style changes while a request runs', () => {
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      answerStyleDisabled
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={vi.fn()}
    />)
    expect((screen.getByRole('button', { name: 'Presenter' }) as HTMLButtonElement).disabled).toBe(true)
    const code = screen.getByRole('button', { name: '</> Code' }) as HTMLButtonElement
    expect(code.disabled).toBe(true)
    expect(code.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Code selected and embeds submission actions in one command bar', () => {
    const onFormat = vi.fn()
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      onAnswerFormatChange={onFormat}
      onSetClickThrough={vi.fn()}
    >
      <button type="button">Generate code</button>
      <button type="button">Start listening</button>
    </CopilotQuickControls>)
    expect(screen.getByRole('button', { name: '</> Code' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('slider', { name: 'Neon intensity' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate code' }).closest('.command-actions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start listening' }).closest('.command-actions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Presenter' }))
    expect(onFormat).toHaveBeenCalledWith('presenter')
  })

  it('requires confirmation and shows both recovery methods before enabling', async () => {
    const setClickThrough = vi.fn().mockResolvedValue(undefined)
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={setClickThrough}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable click-through' }))
    const dialog = screen.getByRole('alertdialog')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(dialog.textContent).toContain('Ctrl+Shift+I')
    expect(dialog.textContent).toContain('Tray → Show PresenterAI')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable click-through' }))
    expect(setClickThrough).toHaveBeenCalledWith(true)
  })

  it('cancels confirmation with Escape and returns focus to its trigger', () => {
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={vi.fn()}
    />)
    const trigger = screen.getByRole('button', { name: 'Enable click-through' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    return new Promise<void>((resolve) => {
      window.setTimeout(() => {
        expect(document.activeElement).toBe(trigger)
        resolve()
      }, 0)
    })
  })

  it('traps Tab and Shift+Tab inside the click-through confirmation', () => {
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable click-through' }))
    const dialog = screen.getByRole('alertdialog')
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const enable = within(dialog).getByRole('button', { name: 'Enable click-through' })

    enable.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)

    cancel.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(enable)
  })

  it('refuses an unsafe enable and retains a visible active recovery banner', () => {
    const { rerender } = render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: false, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: false }}
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={vi.fn()}
    />)
    expect((screen.getByRole('button', { name: 'Click-through unavailable' }) as HTMLButtonElement).disabled).toBe(true)

    rerender(<ClickThroughBanner status={{ enabled: true, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }} />)
    expect(screen.getByRole('status').textContent).toContain('CLICK-THROUGH ON · Ctrl+Shift+I')
  })

  it('contains a rejected disable after the parent surfaces the actionable error', async () => {
    const setClickThrough = vi.fn().mockRejectedValue(new Error('Persistence unavailable.'))
    render(<CopilotQuickControls
      answerFormat="code"
      clickThrough={{ enabled: true, recoveryShortcut: 'Control+Shift+I', recoveryAvailable: true }}
      onAnswerFormatChange={vi.fn()}
      onSetClickThrough={setClickThrough}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Click-through on' }))
    await Promise.resolve()
    expect(setClickThrough).toHaveBeenCalledWith(false)
  })
})
