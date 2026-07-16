import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DELETE_ALL_SMOKE_ARGUMENT, deleteAllSmokeOutputPath, isControlledInstallerSmokeInvocation, runDeleteAllSmoke
} from '../src/main/deleteAllSmoke'

const temporaryPaths: string[] = []
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('packaged Delete All smoke helper', () => {
  it('accepts exactly one absolute JSON output argument', () => {
    const valid = `${DELETE_ALL_SMOKE_ARGUMENT}C:\\temp\\delete-result.json`
    expect(deleteAllSmokeOutputPath(['PresenterAI.exe', valid])).toBe('C:\\temp\\delete-result.json')
    expect(deleteAllSmokeOutputPath(['PresenterAI.exe', valid, valid])).toBeUndefined()
    expect(deleteAllSmokeOutputPath(['PresenterAI.exe', `${DELETE_ALL_SMOKE_ARGUMENT}relative.json`])).toBeUndefined()
    expect(deleteAllSmokeOutputPath(['PresenterAI.exe', `${DELETE_ALL_SMOKE_ARGUMENT}C:\\temp\\result.txt`])).toBeUndefined()
  })

  it('permits destructive smoke mode only inside the controlled installer profile', () => {
    const root = 'C:\\Temp\\presenterai-installer-smoke-1234'
    const scenario = join(root, 'upgrade')
    expect(isControlledInstallerSmokeInvocation(
      join(scenario, 'user-data'), join(scenario, 'temporary'), join(scenario, 'delete-result.json')
    )).toBe(true)
    expect(isControlledInstallerSmokeInvocation(
      'C:\\Users\\person\\AppData\\Roaming\\PresenterAI', join(scenario, 'temporary'), join(scenario, 'delete-result.json')
    )).toBe(false)
    expect(isControlledInstallerSmokeInvocation(
      join(scenario, 'user-data'), join(scenario, 'temporary'), 'C:\\Temp\\elsewhere.json'
    )).toBe(false)
  })

  it('writes only redacted per-scope outcomes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'presenter-delete-smoke-test-'))
    temporaryPaths.push(directory)
    const output = join(directory, 'result.json')
    await runDeleteAllSmoke(output, async () => ({
      ok: true,
      results: [
        { scope: 'documents', ok: true },
        { scope: 'api-key', ok: true }
      ]
    }))
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      ok: true,
      scopes: [
        { scope: 'documents', ok: true },
        { scope: 'api-key', ok: true }
      ],
      failedScopes: []
    })
  })
})
