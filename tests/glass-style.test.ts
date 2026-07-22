import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('dark glass presentation', () => {
  it('uses native acrylic with a CSS fallback and never fades the entire window', async () => {
    const [windowSource, css] = await Promise.all([
      readFile(new URL('../src/main/windows/windowManager.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    ])
    expect(windowSource).toContain("backgroundMaterial: 'acrylic'")
    expect(windowSource).not.toMatch(/\.setOpacity\(/u)
    expect(windowSource).toContain('--glass-opacity:')
    expect(css).toContain('@supports not (backdrop-filter: blur(1px))')
    expect(css).toContain('var(--glass-opacity)')
  })

  it('keeps scrolling, focus, contrast, and narrow layouts integrated', async () => {
    const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    expect(css).toContain('*::-webkit-scrollbar-thumb')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media (max-width: 820px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)')
    expect(css).toContain('(forced-colors: active)')
  })

  it('gives structured code its own bounded opaque scrolling surface', async () => {
    const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.code-scroll\s*\{[^}]*max-height:420px;[^}]*overflow:auto;/u)
    expect(css).toMatch(/\.code-scroll pre, \.code-scroll code\s*\{[^}]*tab-size:2;/u)
    expect(css).toContain('background:#060811')
  })
})
