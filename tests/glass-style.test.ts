import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('Setup and presenter styling', () => {
  it('keeps Setup opaque and lets presenter surfaces show the glass behind them', async () => {
    const css = await read('../src/renderer/style.css')
    const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
    expect(block(':root[data-view="setup"] {')).toMatch(/--surface: #[0-9a-f]{6};/u)
    expect(block(':root[data-view="presenter"] {')).toMatch(/--surface: rgb\(255 255 255 \/ \.\d+\);/u)
    expect(block('.code-block-card {')).not.toContain('box-shadow')
  })

  it('drops the live glass for reduced transparency and forced colours', async () => {
    const css = await read('../src/renderer/style.css')
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)[^@]*\.liquid-glass \{ display: none; \}/u)
    expect(css).toMatch(/@media \(forced-colors: active\)[^@]*\.liquid-glass \{ display: none; \}/u)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
