import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FTS5_SMOKE_ARGUMENT, fts5SmokeOutputPath, runFts5Smoke } from '../src/main/ftsSmoke'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })

describe('packaged FTS5 smoke path', () => {
  it('recognizes only the dedicated command argument', () => {
    expect(fts5SmokeOutputPath(['PresenterAI.exe', `${FTS5_SMOKE_ARGUMENT}C:\\temp\\result.json`])).toBe('C:\\temp\\result.json')
    expect(fts5SmokeOutputPath(['PresenterAI.exe', '--other'])).toBeUndefined()
    expect(fts5SmokeOutputPath(['PresenterAI.exe', `${FTS5_SMOKE_ARGUMENT}relative.json`])).toBeUndefined()
    expect(fts5SmokeOutputPath(['PresenterAI.exe', `${FTS5_SMOKE_ARGUMENT}C:\\temp\\result.txt`])).toBeUndefined()
  })

  it('creates and queries an FTS5 table before writing a result', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'presenterai-fts5-unit-'))
    const output = resolve(directory, 'result.json')
    await runFts5Smoke(output)
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ ok: true })
    await expect(runFts5Smoke(resolve(directory, 'result.txt'))).rejects.toThrow(/absolute JSON path/)
  })
})
