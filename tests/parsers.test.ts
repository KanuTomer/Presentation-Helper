import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseDocument } from '../src/main/documents/parsers'

let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

describe('local text parsers', () => {
  it('preserves markdown sections and source labels', async () => {
    directory = await mkdtemp(join(tmpdir(), 'presenterai-test-'))
    const path = join(directory, 'project.md')
    await writeFile(path, '# Method\nGenetic algorithm details.\n\n## Results\nNo superiority claim.', 'utf8')
    const chunks = await parseDocument(path, 'doc-1')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.section).toBe('Method')
    expect(chunks[1]?.text).toContain('No superiority claim')
  })
})
