import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('hybrid liquid-glass presentation', () => {
  it('combines a shadowless transparent window, Acrylic, and a neon-only material control', async () => {
    const [windowSource, css] = await Promise.all([
      readFile(new URL('../src/main/windows/windowManager.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    ])
    expect(windowSource).toContain("backgroundMaterial: 'acrylic'")
    expect(windowSource).toContain('hasShadow: false')
    expect(windowSource).toContain('roundedCorners: true')
    expect(windowSource).not.toMatch(/\.setOpacity\(/u)
    expect(css).toContain('--neon-intensity:')
    expect(css).toContain('@supports not (backdrop-filter: blur(1px))')
    expect(css).toContain('var(--neon-intensity)')
    expect(css).not.toContain('var(--glass-tint)')
    expect(css).toContain('.liquid-glass-layer')
  })

  it('keeps one height-constrained content scroller with input and accessibility support', async () => {
    const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    expect(css).toMatch(/html, body, #root\s*\{[^}]*height:100%;[^}]*min-height:0;[^}]*overflow:hidden;/u)
    expect(css).toMatch(/\.shell\s*\{[^}]*height:100%;[^}]*min-height:0;[^}]*overflow:hidden;/u)
    expect(css).toMatch(/\.content\s*\{[^}]*min-height:0;[^}]*overflow-x:hidden;[^}]*overflow-y:auto;[^}]*touch-action:pan-x pan-y;/u)
    expect(css).toMatch(/\.tabs\s*\{[^}]*overflow-x:auto;[^}]*overflow-y:hidden;/u)
    expect(css).toContain('*::-webkit-scrollbar-thumb')
    expect(css).toContain('*::-webkit-scrollbar-button { display:none;')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media (max-width: 820px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)')
    expect(css).toContain('(forced-colors: active)')
    expect(css).toContain('.liquid-glass--context-lost')
  })

  it('clips the refractive tint to the same rounded renderer edge without nested frosting', async () => {
    const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    expect(css).toContain('--window-radius: 24px')
    expect(css).toMatch(/#root\s*\{[^}]*clip-path:inset\(0 round var\(--window-radius\)\);/u)
    expect(css).toMatch(/\.shell\s*\{[^}]*border-radius:var\(--window-radius\);[^}]*clip-path:inset\(0 round var\(--window-radius\)\);/u)
    expect(css).toContain('linear-gradient(116deg')
    expect(css).toContain('repeating-linear-gradient(127deg')
    expect(css).toContain('.liquid-glass-layer { z-index:0;')
    expect(css).not.toMatch(/\.question-box, \.response-card, fieldset, \.document, \.usage\s*\{[^}]*backdrop-filter/u)
  })

  it('gives structured code its own bounded opaque scrolling surface', async () => {
    const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.code-scroll\s*\{[^}]*max-height:420px;[^}]*overflow:auto;[^}]*overscroll-behavior-y:auto;[^}]*touch-action:pan-x pan-y;/u)
    expect(css).toMatch(/\.code-scroll pre, \.code-scroll code\s*\{[^}]*tab-size:2;/u)
    expect(css).toContain('background:#060811')
  })
})
