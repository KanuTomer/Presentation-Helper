import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DELETE_ALL_SCOPES,
  InstallerSmokeError,
  appendRedactedDiagnostic,
  canonicalizeFailedScopes,
  createSafeInstallerReportHeader,
  deleteAllFailureCode,
  inspectLegacyReadiness,
  inspectDeleteAllResult,
  listFilesResilient,
  parseInstallerSmokeArguments,
  redactedFailureCode,
  terminateControlledProcessSet,
  validateInstallerUpgrade,
  validateCurrentLaunchResult,
  validatePreviousProvenance,
  waitForLegacyReadiness,
  waitForPayloadRemoval
} from '../scripts/installer-smoke-support.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function applicationState() {
  const directory = await mkdtemp(join(tmpdir(), 'presenter-installer-support-test-'))
  temporaryDirectories.push(directory)
  return {
    settingsPath: join(directory, 'presenterai.json'),
    databasePath: join(directory, 'documents.sqlite')
  }
}

function createExpectedDatabase(path: string) {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE chunks (id TEXT PRIMARY KEY);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, text);
  `)
  database.close()
}

function deleteAllResult(failedScopes: string[] = []) {
  const failed = new Set(failedScopes)
  return {
    ok: failedScopes.length === 0,
    scopes: DELETE_ALL_SCOPES.map((scope) => ({ scope, ok: !failed.has(scope) })),
    failedScopes
  }
}

describe('cross-version installer readiness', () => {
  it('waits for parseable settings and an integral database with every expected table', async () => {
    const paths = await applicationState()
    expect(await inspectLegacyReadiness(paths)).toMatchObject({ ready: false, state: 'waiting-for-settings' })
    await writeFile(paths.settingsPath, JSON.stringify({ settings: {} }), 'utf8')
    expect(await inspectLegacyReadiness(paths)).toMatchObject({ ready: false, state: 'waiting-for-database' })
    createExpectedDatabase(paths.databasePath)
    expect(await inspectLegacyReadiness(paths)).toEqual({
      ready: true, state: 'application-state-ready', missingTableCount: 0
    })
  })

  it('distinguishes incomplete schema from malformed settings and database state', async () => {
    const incomplete = await applicationState()
    await writeFile(incomplete.settingsPath, '{}', 'utf8')
    const database = new DatabaseSync(incomplete.databasePath)
    database.exec('CREATE TABLE documents (id TEXT PRIMARY KEY)')
    database.close()
    expect(await inspectLegacyReadiness(incomplete)).toMatchObject({
      ready: false, state: 'waiting-for-database-schema', missingTableCount: 2
    })

    const malformedSettings = await applicationState()
    await writeFile(malformedSettings.settingsPath, '{credential-material-is-not-json', 'utf8')
    await expect(inspectLegacyReadiness(malformedSettings)).rejects.toMatchObject({ code: 'malformed-settings' })

    const malformedDatabase = await applicationState()
    await writeFile(malformedDatabase.settingsPath, '{}', 'utf8')
    await writeFile(malformedDatabase.databasePath, 'not a sqlite database', 'utf8')
    await expect(inspectLegacyReadiness(malformedDatabase)).rejects.toMatchObject({ code: 'malformed-database' })
  })

  it('reports an early process exit and a bounded readiness timeout', async () => {
    await expect(waitForLegacyReadiness({
      inspect: async () => ({ ready: false, state: 'waiting-for-settings' }),
      isProcessActive: () => false,
      timeoutMs: 10,
      sleep: async () => undefined
    })).rejects.toMatchObject({ code: 'legacy-app-exited-early' })

    let clock = 0
    const states: string[] = []
    await expect(waitForLegacyReadiness({
      inspect: async () => ({ ready: false, state: 'waiting-for-database-schema' }),
      isProcessActive: () => true,
      timeoutMs: 10,
      pollMs: 5,
      now: () => clock,
      sleep: async (delay: number) => { clock += delay },
      onState: (state: { state: string }) => states.push(state.state)
    })).rejects.toMatchObject({ code: 'legacy-readiness-timeout' })
    expect(states).toEqual(['waiting-for-database-schema', 'waiting-for-database-schema'])
  })

  it('terminates only the supplied controlled process set and verifies nothing survives', async () => {
    const kills = vi.fn()
    const snapshots = [[12, 13, 13], [13], []]
    await terminateControlledProcessSet({
      listProcessIds: () => snapshots.shift() ?? [],
      killProcessTree: kills,
      sleep: async () => undefined
    })
    expect(kills.mock.calls).toEqual([[12], [13], [13]])

    await expect(terminateControlledProcessSet({
      listProcessIds: () => [99],
      killProcessTree: vi.fn(),
      attempts: 2,
      sleep: async () => undefined
    })).rejects.toMatchObject({ code: 'process-cleanup-failed' })
  })
})

describe('concurrent NSIS payload removal', () => {
  const entry = (name: string, directory = false) => ({
    name,
    isDirectory: () => directory
  })

  it('treats only a vanished root or nested directory as an empty subtree', async () => {
    const rootMissing = vi.fn(async () => {
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
    })
    expect(await listFilesResilient('C:\\controlled\\application', { readDirectory: rootMissing })).toEqual([])

    const nestedMissing = vi.fn(async (path: string) => {
      if (path.endsWith('resources')) throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
      return [entry('resources', true), entry('PresenterAI.exe')]
    })
    expect(await listFilesResilient('C:\\controlled\\application', { readDirectory: nestedMissing }))
      .toEqual(['C:\\controlled\\application\\PresenterAI.exe'])
  })

  it('propagates filesystem failures other than ENOENT', async () => {
    for (const code of ['EACCES', 'EPERM']) {
      const failure = Object.assign(new Error('blocked'), { code })
      await expect(listFilesResilient('C:\\controlled\\application', {
        readDirectory: async () => { throw failure }
      })).rejects.toBe(failure)
    }
  })

  it('keeps polling transient residual files until the payload is actually gone', async () => {
    const snapshots = [
      ['resources.pak', 'vulkan-1.dll'],
      ['vulkan-1.dll'],
      []
    ]
    let clock = 0
    const listFiles = vi.fn(async () => snapshots.shift() ?? [])
    await waitForPayloadRemoval({
      directory: 'C:\\controlled\\application',
      listFiles,
      timeoutMs: 30,
      pollMs: 5,
      now: () => clock,
      sleep: async (delay: number) => { clock += delay }
    })
    expect(listFiles).toHaveBeenCalledTimes(3)
  })

  it('fails after the real deadline when payload files persist', async () => {
    let clock = 0
    const listFiles = vi.fn(async () => ['vulkan-1.dll'])
    await expect(waitForPayloadRemoval({
      directory: 'C:\\controlled\\application',
      listFiles,
      timeoutMs: 10,
      pollMs: 5,
      now: () => clock,
      sleep: async (delay: number) => { clock += delay }
    })).rejects.toMatchObject({ code: 'payload-removal-timeout' })
    expect(listFiles).toHaveBeenCalledTimes(3)
  })
})

describe('current launch hook and diagnostic report safety', () => {
  it('accepts only an explicit successful initialization result', () => {
    expect(validateCurrentLaunchResult({ ok: true, initialized: true, ignored: 'value' })).toEqual({ ok: true, initialized: true })
    for (const value of [undefined, {}, { ok: true }, { initialized: true }, { ok: false, initialized: true }]) {
      expect(() => validateCurrentLaunchResult(value)).toThrow(InstallerSmokeError)
    }
  })

  it('records only allowlisted scalar diagnostics and a stable failure code', () => {
    const scenario: { diagnostics?: unknown[] } = {}
    appendRedactedDiagnostic(scenario, 'Current Upgrade Launch', 'Launch Failed', {
      processCount: 3,
      resultWritten: false,
      failedScopeCount: 99,
      payloadFileCount: 7,
      failedScopes: ['settings', 'documents'],
      path: 'C:\\Users\\person\\secret',
      message: 'credential-material',
      stdout: 'raw app output'
    }, () => new Date('2026-07-18T01:02:03.000Z'))
    expect(scenario.diagnostics).toEqual([{
      at: '2026-07-18T01:02:03.000Z',
      phase: 'invalid-label',
      state: 'invalid-label',
      processCount: 3,
      resultWritten: false,
      failedScopes: ['documents', 'settings'],
      failedScopeCount: 2,
      payloadFileCount: 7
    }])
    expect(JSON.stringify(scenario)).not.toMatch(/secret|raw app output|Users/u)
    expect(redactedFailureCode(new InstallerSmokeError('legacy-readiness-timeout', 'sensitive path'))).toBe('legacy-readiness-timeout')
    expect(redactedFailureCode(new Error('credential-material'))).toBe('unexpected-failure')
  })
})

describe('genuine installer upgrade identity', () => {
  const currentPath = 'C:\\build\\PresenterAI-0.2.0-beta.2-setup.exe'
  const previousPath = 'C:\\artifact\\PresenterAI-0.2.0-beta.1-setup.exe'
  const differentHashes = async (path: string) => path.includes('beta.2') ? 'a'.repeat(64) : 'b'.repeat(64)

  it('requires the package version, a strictly older baseline, and different SHA-256 bytes', async () => {
    expect(await validateInstallerUpgrade({
      currentPath, previousPath, packageVersion: '0.2.0-beta.2', hashFile: differentHashes
    })).toEqual({
      current: { fileName: 'PresenterAI-0.2.0-beta.2-setup.exe', version: '0.2.0-beta.2', sha256: 'a'.repeat(64) },
      previous: { fileName: 'PresenterAI-0.2.0-beta.1-setup.exe', version: '0.2.0-beta.1', sha256: 'b'.repeat(64) }
    })
  })

  it('rejects same-version paths, downgrades, byte-identical artifacts, malformed names, and package mismatch', async () => {
    await expect(validateInstallerUpgrade({
      currentPath, previousPath: 'D:\\other\\PresenterAI-0.2.0-beta.2-setup.exe',
      packageVersion: '0.2.0-beta.2', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'installer-version-not-upgrade' })
    await expect(validateInstallerUpgrade({
      currentPath, previousPath: 'D:\\other\\PresenterAI-0.2.0-setup.exe',
      packageVersion: '0.2.0-beta.2', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'installer-version-not-upgrade' })
    await expect(validateInstallerUpgrade({
      currentPath, previousPath, packageVersion: '0.2.0-beta.2', hashFile: async () => 'c'.repeat(64)
    })).rejects.toMatchObject({ code: 'installer-bytes-identical' })
    await expect(validateInstallerUpgrade({
      currentPath: 'C:\\build\\PresenterAI-current-setup.exe', packageVersion: '0.2.0-beta.2', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'malformed-installer-name' })
    await expect(validateInstallerUpgrade({
      currentPath, previousPath: 'D:\\other\\previous-setup.exe',
      packageVersion: '0.2.0-beta.2', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'malformed-installer-name' })
    await expect(validateInstallerUpgrade({
      currentPath, packageVersion: '0.2.0-beta.3', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'current-version-mismatch' })
    await expect(validateInstallerUpgrade({
      currentPath: 'C:\\build\\PresenterAI-0.2.0-beta.01-setup.exe', packageVersion: '0.2.0-beta.01', hashFile: differentHashes
    })).rejects.toMatchObject({ code: 'malformed-installer-name' })
  })

  it('validates complete fixed baseline provenance and rejects malformed or misplaced values', () => {
    expect(validatePreviousProvenance({
      runId: '29499040733', headSha: 'E'.repeat(40), hasPrevious: true
    })).toEqual({ workflowRunId: '29499040733', headSha: 'e'.repeat(40) })
    expect(validatePreviousProvenance({ runId: undefined, headSha: undefined, hasPrevious: true })).toBeNull()
    for (const input of [
      { runId: '0', headSha: 'a'.repeat(40), hasPrevious: true },
      { runId: '12x', headSha: 'a'.repeat(40), hasPrevious: true },
      { runId: '123', headSha: 'a'.repeat(39), hasPrevious: true },
      { runId: '123', headSha: undefined, hasPrevious: true },
      { runId: '123', headSha: 'a'.repeat(40), hasPrevious: false }
    ]) expect(() => validatePreviousProvenance(input)).toThrow(InstallerSmokeError)
  })

  it('parses provenance CLI flags once and rejects duplicates or missing values', () => {
    expect(parseInstallerSmokeArguments([
      '--current', 'current.exe', '--previous', 'previous.exe', '--require-previous',
      '--previous-run-id', '123', '--previous-head-sha', 'a'.repeat(40)
    ])).toMatchObject({
      current: 'current.exe', previous: 'previous.exe', requirePrevious: true,
      previousRunId: '123', previousHeadSha: 'a'.repeat(40)
    })
    expect(() => parseInstallerSmokeArguments(['--current'])).toThrow(InstallerSmokeError)
    expect(() => parseInstallerSmokeArguments(['--current', 'one.exe', '--current', 'two.exe'])).toThrow(InstallerSmokeError)
    expect(() => parseInstallerSmokeArguments(['--unknown'])).toThrow(InstallerSmokeError)
  })
})

describe('Delete All and fully serialized report diagnostics', () => {
  it('classifies timeout/nonzero/spawn/result failures without provider output', () => {
    expect(deleteAllFailureCode(new InstallerSmokeError('process-timeout', 'raw output'))).toBe('delete-all-timeout')
    const nonzero = new InstallerSmokeError('process-nonzero-exit', 'raw output', { exitCode: 7 })
    expect(deleteAllFailureCode(nonzero)).toBe('delete-all-nonzero-exit')
    expect(nonzero.exitCode).toBe(7)
    expect(deleteAllFailureCode(new InstallerSmokeError('process-spawn-failed', 'local path'))).toBe('delete-all-spawn-failed')
    expect(deleteAllFailureCode(new InstallerSmokeError('delete-all-invalid-result', 'raw JSON'))).toBe('delete-all-invalid-result')
    expect(deleteAllFailureCode(new Error('credential material'))).toBe('delete-all-unexpected-failure')
  })

  it('derives only bounded Delete All result metadata', async () => {
    const paths = await applicationState()
    const resultPath = join(paths.settingsPath, '..', 'delete-all-result.json')
    expect(await inspectDeleteAllResult(resultPath)).toEqual({
      resultWritten: false, failedScopes: [], failedScopeCount: 0, result: undefined
    })
    await writeFile(resultPath, JSON.stringify({
      ...deleteAllResult(['settings', 'documents']),
      message: 'credential material', path: 'C:\\Users\\person\\private'
    }), 'utf8')
    expect(await inspectDeleteAllResult(resultPath)).toMatchObject({
      resultWritten: true, failedScopes: ['documents', 'settings'], failedScopeCount: 2
    })
  })

  it('represents a failure before a scoped result with an empty safe scope list', async () => {
    const paths = await applicationState()
    const resultPath = join(paths.settingsPath, '..', 'delete-all-result.json')
    await writeFile(resultPath, JSON.stringify({
      ok: false, failedBeforeResult: true, message: 'credential material', path: 'C:\\Users\\person\\private'
    }), 'utf8')
    expect(await inspectDeleteAllResult(resultPath)).toMatchObject({
      resultWritten: true, failedScopes: [], failedScopeCount: 0
    })
  })

  it('rejects unknown, duplicate, malformed, incomplete, or inconsistent scope results', async () => {
    const invalidResults = [
      { ...deleteAllResult(), failedScopes: ['unknown-scope'] },
      { ...deleteAllResult(['documents']), failedScopes: ['documents', 'documents'] },
      { ...deleteAllResult(), failedScopes: [7] },
      { ...deleteAllResult(), scopes: deleteAllResult().scopes.slice(1) },
      { ...deleteAllResult(), scopes: [...deleteAllResult().scopes.slice(0, -1), { scope: 'unknown-scope', ok: true }] },
      { ...deleteAllResult(), scopes: [...deleteAllResult().scopes.slice(0, -1), deleteAllResult().scopes[0]] },
      { ...deleteAllResult(), scopes: deleteAllResult().scopes.map((entry, index) => index === 0 ? { ...entry, ok: 'yes' } : entry) },
      { ...deleteAllResult(['documents']), failedScopes: [] },
      { ...deleteAllResult(), ok: false },
      { ok: false, failedBeforeResult: true, failedScopes: [] },
      null,
      []
    ]
    for (const invalid of invalidResults) {
      const paths = await applicationState()
      const resultPath = join(paths.settingsPath, '..', 'delete-all-result.json')
      await writeFile(resultPath, JSON.stringify(invalid), 'utf8')
      await expect(inspectDeleteAllResult(resultPath)).rejects.toMatchObject({ code: 'delete-all-invalid-result' })
    }

    const paths = await applicationState()
    const resultPath = join(paths.settingsPath, '..', 'delete-all-result.json')
    await writeFile(resultPath, '{invalid', 'utf8')
    await expect(inspectDeleteAllResult(resultPath)).rejects.toMatchObject({ code: 'delete-all-invalid-result' })
  })

  it('canonicalizes only the fixed eight safe scope names for diagnostics', () => {
    expect(canonicalizeFailedScopes(['settings', 'api-key', 'session'])).toEqual(['session', 'api-key', 'settings'])
    for (const value of [undefined, 'documents', ['documents', 'documents'], ['documents', 'C:\\Users\\person\\private'], [null]]) {
      expect(() => canonicalizeFailedScopes(value)).toThrow(InstallerSmokeError)
    }

    const scenario: { diagnostics?: unknown[] } = {}
    expect(() => appendRedactedDiagnostic(scenario, 'delete-all', 'failed', {
      failedScopes: ['documents', 'credential material']
    })).toThrow(InstallerSmokeError)
    expect(scenario.diagnostics).toEqual([])
  })

  it('serializes only safe installer identity, provenance, lifecycle states, and scalar counts', () => {
    const scenario: { name: string; diagnostics: unknown[] } = { name: 'upgrade', diagnostics: [] }
    appendRedactedDiagnostic(scenario, 'delete-all', 'delete-all-nonzero-exit', {
      exitCode: 7, resultWritten: true, failedScopeCount: 99, failedScopes: ['api-key', 'documents'], processCount: 1,
      stdout: 'credential material', path: 'C:\\Users\\person\\private'
    }, () => new Date('2026-07-18T01:02:03.000Z'))
    const report = {
      ...createSafeInstallerReportHeader({
        generatedAt: '2026-07-18T01:02:03.000Z',
        installers: {
          current: {
            fileName: 'PresenterAI-0.2.0-beta.1-setup.exe', version: '0.2.0-beta.1', sha256: 'a'.repeat(64),
            rawPath: 'C:\\Users\\person\\private-current'
          },
          previous: {
            fileName: 'PresenterAI-0.1.0-setup.exe', version: '0.1.0', sha256: 'b'.repeat(64),
            rawPath: 'C:\\Users\\person\\private-previous'
          }
        },
        provenance: { workflowRunId: '29499040733', headSha: 'e'.repeat(40), message: 'credential material' },
        previousBaselineRequired: true
      }),
      ok: false,
      scenarios: [scenario]
    }
    const serialized = JSON.stringify(report)
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 3,
      currentInstaller: { version: '0.2.0-beta.1', sha256: 'a'.repeat(64) },
      previousBaseline: { workflowRunId: '29499040733', headSha: 'e'.repeat(40) },
      scenarios: [{ diagnostics: [{
        state: 'delete-all-nonzero-exit', exitCode: 7, resultWritten: true,
        failedScopes: ['documents', 'api-key'], failedScopeCount: 2, processCount: 1
      }] }]
    })
    expect(serialized).not.toMatch(/credential material|Users|private|stdout|path|failedScopeCount":99/u)
  })
})
