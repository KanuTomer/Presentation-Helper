import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateInstallerChecksums } from '../scripts/generate-installer-checksums'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('installer checksum manifest', () => {
  it('writes a SHA-256 entry for only the package-version installer', async () => {
    const directory = await createTemporaryDirectory()
    await writeFile(join(directory, 'PresenterAI-0.2.0-beta.4-setup.exe'), 'current')
    await writeFile(join(directory, 'PresenterAI-0.1.0-setup.exe'), 'previous')
    await writeFile(join(directory, 'unrelated.exe'), 'ignore me')

    const entries = await generateInstallerChecksums({ directory })
    const manifest = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')

    expect(entries.map((entry) => entry.filename)).toEqual(['PresenterAI-0.2.0-beta.4-setup.exe'])
    expect(manifest).toBe(`${digest('current')}  PresenterAI-0.2.0-beta.4-setup.exe\n`)
  })

  it('fails rather than writing an empty manifest', async () => {
    const directory = await createTemporaryDirectory()
    await mkdir(join(directory, 'nested'))
    await writeFile(join(directory, 'PresenterAI-0.1.0-setup.exe'), 'stale')

    await expect(generateInstallerChecksums({ directory })).rejects.toThrow(
      'Expected exactly one current PresenterAI installer'
    )
  })

  it('uses package metadata instead of accepting an arbitrary matching filename', async () => {
    const directory = await createTemporaryDirectory()
    const packageJson = join(directory, 'custom-package.json')
    await writeFile(packageJson, JSON.stringify({ version: '9.8.7-preview.2' }))
    await writeFile(join(directory, 'PresenterAI-0.2.0-beta.1-setup.exe'), 'stale')
    await writeFile(join(directory, 'PresenterAI-9.8.7-preview.2-setup.exe'), 'selected')

    const entries = await generateInstallerChecksums({ directory, packageJson })

    expect(entries).toEqual([{
      filename: 'PresenterAI-9.8.7-preview.2-setup.exe',
      sha256: digest('selected')
    }])
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'presenterai-checksums-'))
  temporaryDirectories.push(directory)
  return directory
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
