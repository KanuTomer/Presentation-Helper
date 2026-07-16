import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('renderer and secret boundary', () => {
  it('does not grant the renderer network access to OpenAI', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8')
    expect(html).not.toContain('api.openai.com')
  })
  it('exposes key write/status operations but no raw-key read operation', async () => {
    const [preload, contracts] = await Promise.all([
      readFile('src/preload/index.ts', 'utf8'), readFile('src/shared/contracts.ts', 'utf8')
    ])
    expect(preload).toContain('getApiKeyStatus')
    expect(preload).not.toMatch(/getRawApiKey|readApiKey/)
    expect(contracts).not.toMatch(/getRawApiKey|readApiKey/)
  })
  it('does not retain raw API-key input in React state or renderer snapshots', async () => {
    const renderer = await readFile('src/renderer/src.tsx', 'utf8')
    expect(renderer).toContain('ref={keyInput}')
    expect(renderer).not.toMatch(/useState\s*\([^)]*(?:sk-|api.?key)/iu)
    expect(renderer).not.toMatch(/\[\s*key\s*,\s*setKey\s*\]/u)
  })
})
