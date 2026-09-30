// @vitest-environment jsdom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { QuietGlassLayer } from '../src/renderer/quietGlass'

afterEach(cleanup)
it('uses an inert static rim without animation or graphics resources', () => {
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
  const { container, rerender } = render(<QuietGlassLayer />)
  rerender(<QuietGlassLayer />)
  expect(container.querySelector('.quiet-glass-layer')?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('canvas')).toBeNull()
  expect(context).not.toHaveBeenCalled()
  context.mockRestore()
})
it('keeps stable reading tokens and removes luminous blending and weak fallback rules', () => {
  const css = readFileSync('src/renderer/style.css', 'utf8')
  expect(css).toContain('--glass-panel: rgb(11 16 32 / .94)')
  expect(css).toContain('--glass-surface: rgb(9 14 26 / .97)')
  expect(css).not.toMatch(/mix-blend-mode|@supports not|liquid-glass-layer/)
  expect(css).toContain('--text-secondary: #BCC6DB')
})
