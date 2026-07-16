import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INSTALLER_LAUNCH_SMOKE_ARGUMENT, installerLaunchSmokeOutputPath, writeInstallerLaunchSmokeResult
} from '../src/main/installerLaunchSmoke'

const temporaryPaths: string[] = []
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('packaged installer launch smoke helper', () => {
  it('accepts exactly one absolute JSON output argument', () => {
    const valid = `${INSTALLER_LAUNCH_SMOKE_ARGUMENT}C:\\temp\\launch-result.json`
    expect(installerLaunchSmokeOutputPath(['PresenterAI.exe', valid])).toBe('C:\\temp\\launch-result.json')
    expect(installerLaunchSmokeOutputPath(['PresenterAI.exe', valid, valid])).toBeUndefined()
    expect(installerLaunchSmokeOutputPath(['PresenterAI.exe', `${INSTALLER_LAUNCH_SMOKE_ARGUMENT}relative.json`])).toBeUndefined()
    expect(installerLaunchSmokeOutputPath(['PresenterAI.exe', `${INSTALLER_LAUNCH_SMOKE_ARGUMENT}C:\\temp\\result.txt`])).toBeUndefined()
  })

  it('writes a redacted successful initialization result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'presenter-launch-smoke-test-'))
    temporaryPaths.push(directory)
    const output = join(directory, 'result.json')
    await writeInstallerLaunchSmokeResult(output)
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      ok: true,
      electron: process.versions.electron,
      initialized: true
    })
  })
})
