import { createReadStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { win32 } from 'node:path'

export const REQUIRED_APPLICATION_TABLES = Object.freeze(['documents', 'chunks', 'chunks_fts'])
export const DELETE_ALL_SCOPES = Object.freeze([
  'session',
  'documents',
  'usage',
  'compatibility',
  'consent',
  'api-key',
  'temporary-audio',
  'settings'
])
const DELETE_ALL_SCOPE_SET = new Set(DELETE_ALL_SCOPES)

export class InstallerSmokeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'InstallerSmokeError'
    this.code = code
    if (Number.isSafeInteger(details.exitCode)) this.exitCode = details.exitCode
  }
}

export function parseInstallerSmokeArguments(values) {
  const result = {
    current: undefined,
    previous: undefined,
    report: undefined,
    previousRunId: undefined,
    previousHeadSha: undefined,
    requirePrevious: false
  }
  const seen = new Set()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (seen.has(value)) throw new InstallerSmokeError('duplicate-argument', `Duplicate installer-smoke argument: ${value}`)
    seen.add(value)
    if (value === '--require-previous') result.requirePrevious = true
    else if (value === '--current' || value === '--previous' || value === '--report' ||
             value === '--previous-run-id' || value === '--previous-head-sha') {
      const argumentValue = values[++index]
      if (!argumentValue) throw new InstallerSmokeError('missing-argument-value', `${value} requires a value.`)
      const key = value.slice(2).replace(/-([a-z])/gu, (_, character) => character.toUpperCase())
      result[key] = argumentValue
    } else throw new InstallerSmokeError('unknown-argument', `Unknown installer-smoke argument: ${value}`)
  }
  return result
}

const INSTALLER_NAME_PATTERN = /^PresenterAI-(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-setup\.exe$/u
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

export async function validateInstallerUpgrade({ currentPath, previousPath, packageVersion, hashFile = sha256File }) {
  const current = parseInstallerIdentity(currentPath)
  if (current.version !== packageVersion || !isValidSemVer(packageVersion)) {
    throw new InstallerSmokeError('current-version-mismatch', 'The current installer filename does not match package.json.')
  }
  current.sha256 = await validatedHash(hashFile, currentPath)
  if (!previousPath) return { current, previous: null }

  const previous = parseInstallerIdentity(previousPath)
  if (compareSemVer(current.version, previous.version) <= 0) {
    throw new InstallerSmokeError('installer-version-not-upgrade', 'The current installer version must be strictly greater than the previous version.')
  }
  previous.sha256 = await validatedHash(hashFile, previousPath)
  if (current.sha256 === previous.sha256) {
    throw new InstallerSmokeError('installer-bytes-identical', 'The current and previous installers must contain different bytes.')
  }
  return { current, previous }
}

export function validatePreviousProvenance({ runId, headSha, hasPrevious }) {
  const supplied = runId !== undefined || headSha !== undefined
  if (!hasPrevious && supplied) {
    throw new InstallerSmokeError('unexpected-previous-provenance', 'Previous-run provenance requires a previous installer.')
  }
  if (!supplied) return null
  if (runId === undefined || headSha === undefined) {
    throw new InstallerSmokeError('incomplete-previous-provenance', 'Both previous workflow run ID and head SHA are required together.')
  }
  if (!/^[1-9]\d{0,19}$/u.test(runId)) {
    throw new InstallerSmokeError('invalid-previous-run-id', 'The previous workflow run ID was invalid.')
  }
  if (!/^[0-9a-fA-F]{40}$/u.test(headSha)) {
    throw new InstallerSmokeError('invalid-previous-head-sha', 'The previous workflow head SHA was invalid.')
  }
  return { workflowRunId: runId, headSha: headSha.toLocaleLowerCase('en-US') }
}

export function createSafeInstallerReportHeader({ generatedAt, installers, provenance, previousBaselineRequired }) {
  return {
    schemaVersion: 3,
    generatedAt,
    currentInstaller: reportIdentity(installers.current),
    previousInstaller: installers.previous ? reportIdentity(installers.previous) : null,
    previousBaseline: provenance ? {
      workflowRunId: provenance.workflowRunId,
      headSha: provenance.headSha
    } : null,
    previousBaselineRequired: Boolean(previousBaselineRequired)
  }
}

function reportIdentity(identity) {
  return { fileName: identity.fileName, version: identity.version, sha256: identity.sha256 }
}

export function deleteAllFailureCode(error) {
  if (!(error instanceof InstallerSmokeError)) return 'delete-all-unexpected-failure'
  if (error.code === 'process-timeout') return 'delete-all-timeout'
  if (error.code === 'process-nonzero-exit') return 'delete-all-nonzero-exit'
  if (error.code === 'process-spawn-failed') return 'delete-all-spawn-failed'
  if (error.code === 'delete-all-invalid-result') return error.code
  return 'delete-all-failed'
}

export async function inspectDeleteAllResult(path) {
  if (!existsSync(path)) return { resultWritten: false, failedScopes: [], failedScopeCount: 0, result: undefined }
  try {
    const result = JSON.parse(await readFile(path, 'utf8'))
    if (isMissingDeleteAllResult(result)) {
      return { resultWritten: true, failedScopes: [], failedScopeCount: 0, result }
    }
    validateDeleteAllScopeResults(result)
    const failedScopes = canonicalizeFailedScopes(result.failedScopes)
    return { resultWritten: true, failedScopes, failedScopeCount: failedScopes.length, result }
  } catch {
    throw new InstallerSmokeError('delete-all-invalid-result', 'The packaged Delete All result was not valid JSON.')
  }
}

export function canonicalizeFailedScopes(value) {
  if (!Array.isArray(value)) throw invalidDeleteAllResult()
  const supplied = new Set()
  for (const scope of value) {
    if (typeof scope !== 'string' || !DELETE_ALL_SCOPE_SET.has(scope) || supplied.has(scope)) {
      throw invalidDeleteAllResult()
    }
    supplied.add(scope)
  }
  return DELETE_ALL_SCOPES.filter((scope) => supplied.has(scope))
}

function validateDeleteAllScopeResults(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean' || !Array.isArray(result.scopes)) {
    throw invalidDeleteAllResult()
  }
  if (result.scopes.length !== DELETE_ALL_SCOPES.length) throw invalidDeleteAllResult()

  const supplied = new Map()
  for (const entry of result.scopes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.scope !== 'string' || !DELETE_ALL_SCOPE_SET.has(entry.scope) ||
        typeof entry.ok !== 'boolean' || supplied.has(entry.scope)) {
      throw invalidDeleteAllResult()
    }
    supplied.set(entry.scope, entry.ok)
  }
  if (DELETE_ALL_SCOPES.some((scope) => !supplied.has(scope))) throw invalidDeleteAllResult()

  const failedScopes = canonicalizeFailedScopes(result.failedScopes)
  const failuresFromResults = DELETE_ALL_SCOPES.filter((scope) => supplied.get(scope) === false)
  if (JSON.stringify(failedScopes) !== JSON.stringify(failuresFromResults) || result.ok !== (failedScopes.length === 0)) {
    throw invalidDeleteAllResult()
  }
}

function isMissingDeleteAllResult(result) {
  return result && typeof result === 'object' && !Array.isArray(result) &&
    result.ok === false && result.failedBeforeResult === true &&
    result.scopes === undefined && result.failedScopes === undefined
}

function invalidDeleteAllResult() {
  return new InstallerSmokeError('delete-all-invalid-result', 'The packaged Delete All result contained invalid scope metadata.')
}

/**
 * Inspect only durable application state that predates the installer smoke
 * protocol. This is deliberately independent of any command-line hook so a
 * previous successful build can act as the upgrade baseline.
 */
export async function inspectLegacyReadiness({ settingsPath, databasePath, databaseFactory = openReadOnlyDatabase }) {
  if (!existsSync(settingsPath)) return { ready: false, state: 'waiting-for-settings' }

  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new InstallerSmokeError('malformed-settings', 'The isolated settings file was not a JSON object.')
    }
  } catch (error) {
    if (error instanceof InstallerSmokeError) throw error
    throw new InstallerSmokeError('malformed-settings', 'The isolated settings file was not valid JSON.')
  }

  if (!existsSync(databasePath)) return { ready: false, state: 'waiting-for-database' }

  let database
  try {
    database = databaseFactory(databasePath)
    const rows = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all()
    const available = new Set(rows.map((row) => String(row.name)))
    const missingTables = REQUIRED_APPLICATION_TABLES.filter((table) => !available.has(table))
    if (missingTables.length) {
      return { ready: false, state: 'waiting-for-database-schema', missingTableCount: missingTables.length }
    }
    const integrityRows = database.prepare('PRAGMA integrity_check').all()
    const integrity = integrityRows.map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? ''))
    if (integrity.length !== 1 || integrity[0]?.toLocaleLowerCase('en-US') !== 'ok') {
      throw new InstallerSmokeError('database-integrity-failed', 'The isolated SQLite database failed its integrity check.')
    }
    return { ready: true, state: 'application-state-ready', missingTableCount: 0 }
  } catch (error) {
    if (error instanceof InstallerSmokeError) throw error
    if (isTransientDatabaseError(error)) return { ready: false, state: 'waiting-for-database-unlock' }
    throw new InstallerSmokeError('malformed-database', 'The isolated SQLite database could not be validated.')
  } finally {
    try { database?.close() } catch { /* Report the primary readiness result. */ }
  }
}

export async function waitForLegacyReadiness({
  inspect,
  isProcessActive,
  timeoutMs,
  pollMs = 250,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onState = () => undefined
}) {
  const startedAt = now()
  let lastState = 'starting'
  while (now() - startedAt < timeoutMs) {
    const readiness = await inspect()
    lastState = readiness.state
    onState(readiness)
    if (readiness.ready) return readiness
    if (!isProcessActive()) {
      throw new InstallerSmokeError('legacy-app-exited-early', 'The previous application exited before initializing its isolated state.')
    }
    await sleep(pollMs)
  }
  throw new InstallerSmokeError('legacy-readiness-timeout', `Timed out while the previous application was in state ${lastState}.`)
}

export async function terminateControlledProcessSet({
  listProcessIds,
  killProcessTree,
  attempts = 4,
  delayMs = 250,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onState = () => undefined
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const processIds = [...new Set(listProcessIds())]
    onState({ state: processIds.length ? 'process-cleanup-active' : 'process-cleanup-complete', processCount: processIds.length })
    if (!processIds.length) return
    for (const processId of processIds) killProcessTree(processId)
    await sleep(delayMs)
  }
  const remaining = [...new Set(listProcessIds())]
  if (remaining.length) {
    throw new InstallerSmokeError('process-cleanup-failed', `${remaining.length} controlled application process(es) remained after cleanup.`)
  }
}

export async function listFilesResilient(directory, { readDirectory = readdir } = {}) {
  let entries
  try {
    entries = await readDirectory(directory, { withFileTypes: true })
  } catch (error) {
    // NSIS removes the installation tree concurrently after its launcher exits.
    // A directory can therefore disappear between a parent enumeration and the
    // recursive read. Treat only that expected race as an empty subtree.
    if (isMissingPathError(error)) return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const path = win32.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFilesResilient(path, { readDirectory }))
    else files.push(path)
  }
  return files
}

export async function waitForPayloadRemoval({
  directory,
  listFiles = listFilesResilient,
  timeoutMs = 60_000,
  pollMs = 250,
  now = () => Date.now(),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
}) {
  const startedAt = now()
  while (now() - startedAt < timeoutMs) {
    const remaining = await listFiles(directory)
    if (remaining.length === 0) return
    await sleep(pollMs)
  }
  const remaining = await listFiles(directory)
  if (remaining.length === 0) return
  throw new InstallerSmokeError(
    'payload-removal-timeout',
    `The NSIS uninstaller left ${remaining.length} application payload file(s) after the removal deadline.`
  )
}

export function validateCurrentLaunchResult(value) {
  if (!value || typeof value !== 'object' || value.ok !== true || value.initialized !== true) {
    throw new InstallerSmokeError('current-launch-invalid-result', 'The current packaged application did not report completed initialization.')
  }
  return { ok: true, initialized: true }
}

const ALLOWED_DIAGNOSTIC_FIELDS = new Set([
  'exitCode', 'missingTableCount', 'payloadFileCount', 'processCount', 'resultWritten', 'settingsWritten', 'databaseWritten'
])

export function appendRedactedDiagnostic(scenario, phase, state, fields = {}, now = () => new Date()) {
  if (!scenario.diagnostics) scenario.diagnostics = []
  const diagnostic = { at: now().toISOString(), phase: safeLabel(phase), state: safeLabel(state) }
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_DIAGNOSTIC_FIELDS.has(key)) continue
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) diagnostic[key] = value
  }
  if (Object.hasOwn(fields, 'failedScopes')) {
    diagnostic.failedScopes = canonicalizeFailedScopes(fields.failedScopes)
    diagnostic.failedScopeCount = diagnostic.failedScopes.length
  }
  scenario.diagnostics.push(diagnostic)
  return diagnostic
}

export function redactedFailureCode(error) {
  return error instanceof InstallerSmokeError ? error.code : 'unexpected-failure'
}

function openReadOnlyDatabase(path) {
  return new DatabaseSync(path, { readOnly: true })
}

function parseInstallerIdentity(path) {
  const fileName = win32.basename(path)
  const match = INSTALLER_NAME_PATTERN.exec(fileName)
  if (!match?.[1] || !isValidSemVer(match[1])) {
    throw new InstallerSmokeError('malformed-installer-name', 'The installer filename did not contain a supported PresenterAI SemVer.')
  }
  return { fileName, version: match[1], sha256: '' }
}

function compareSemVer(left, right) {
  const leftMatch = SEMVER_PATTERN.exec(left)
  const rightMatch = SEMVER_PATTERN.exec(right)
  if (!leftMatch || !rightMatch) throw new InstallerSmokeError('malformed-installer-version', 'An installer version was not valid SemVer.')
  for (let index = 1; index <= 3; index += 1) {
    const leftNumber = BigInt(leftMatch[index])
    const rightNumber = BigInt(rightMatch[index])
    if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
  }
  const leftPrerelease = leftMatch[4]
  const rightPrerelease = rightMatch[4]
  if (leftPrerelease === undefined && rightPrerelease !== undefined) return 1
  if (leftPrerelease !== undefined && rightPrerelease === undefined) return -1
  if (leftPrerelease === undefined || rightPrerelease === undefined) return 0
  const leftIdentifiers = leftPrerelease.split('.')
  const rightIdentifiers = rightPrerelease.split('.')
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const leftIdentifier = leftIdentifiers[index]
    const rightIdentifier = rightIdentifiers[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function isValidSemVer(value) {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return false
  const prerelease = match[4]
  return prerelease === undefined || prerelease.split('.').every((identifier) => {
    return !/^\d+$/u.test(identifier) || identifier === '0' || !identifier.startsWith('0')
  })
}

async function validatedHash(hashFile, path) {
  const value = await hashFile(path)
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new InstallerSmokeError('invalid-installer-hash', 'Installer hashing returned an invalid SHA-256 value.')
  return value
}

async function sha256File(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function isTransientDatabaseError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return code === 'ERR_SQLITE_ERROR' && /(?:locked|busy)/iu.test(error instanceof Error ? error.message : '')
}

function isMissingPathError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function safeLabel(value) {
  const normalized = String(value).toLocaleLowerCase('en-US')
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(normalized) ? normalized : 'invalid-label'
}
