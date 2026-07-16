import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

if (process.platform !== 'win32') throw new Error('The NSIS installer smoke test requires Windows.')

const arguments_ = parseArguments(process.argv.slice(2))
const currentInstaller = await resolveInstaller(arguments_.current, resolve('release'))
const previousInstaller = arguments_.previous ? await resolveInstaller(arguments_.previous) : undefined
if (arguments_.requirePrevious && !previousInstaller) throw new Error('A previous successful main installer is required for the upgrade smoke test.')
if (previousInstaller && samePath(previousInstaller, currentInstaller)) throw new Error('Current and previous installer paths must be distinct files.')

const reportPath = resolve(arguments_.report ?? join('artifacts', 'installer', 'installer-lifecycle-report.json'))
if (!reportPath.toLocaleLowerCase('en-US').endsWith('.json')) throw new Error('The installer lifecycle report must be a JSON file.')
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  currentInstaller: basename(currentInstaller),
  previousInstaller: previousInstaller ? basename(previousInstaller) : null,
  previousBaselineRequired: arguments_.requirePrevious,
  ok: false,
  scenarios: []
}
let launchSequence = 0
const root = await mkdtemp(join(tmpdir(), 'presenterai-installer-smoke-'))
assertControlledRoot(root)
let failure
try {
  const clean = createScenario('clean-install')
  report.scenarios.push(clean)
  await cleanInstallScenario(root, currentInstaller, clean)
  if (previousInstaller) {
    const upgrade = createScenario('upgrade')
    report.scenarios.push(upgrade)
    await upgradeScenario(root, previousInstaller, currentInstaller, upgrade)
  }
  report.ok = true
  process.stdout.write(`PresenterAI installer smoke passed: clean install, launch, ${previousInstaller ? 'upgrade, in-app deletion, ' : ''}data preservation, and complete uninstall.\n`)
} catch (error) {
  failure = error
  report.ok = false
  report.failedScenario = report.scenarios.at(-1)?.name ?? 'setup'
  if (report.scenarios.length) {
    report.scenarios.at(-1).ok = false
    report.scenarios.at(-1).failedAfterStep = report.scenarios.at(-1).steps.at(-1)?.step ?? 'scenario-start'
  }
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  assertControlledRoot(root)
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
}
if (failure) throw failure

async function cleanInstallScenario(testRoot, installer, scenario) {
  const base = join(testRoot, scenario.name)
  const installDirectory = join(base, 'application')
  const userData = join(base, 'user-data')
  const temporaryDirectory = join(base, 'temporary')
  const sourceDocument = join(base, 'source-documents', 'source-document.txt')
  await mkdir(dirname(sourceDocument), { recursive: true })
  await writeFile(sourceDocument, 'This represents a user-owned source document.\n', 'utf8')

  await install(installer, installDirectory); pass(scenario, 'clean-install')
  await assertInstalledPayload(installDirectory); pass(scenario, 'installed-payload-present')
  const executable = await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await launchAndInitialize(executable, userData, temporaryDirectory); pass(scenario, 'initial-launch')
  await seedApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name)
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'before clean uninstall')
  pass(scenario, 'application-data-seeded')

  await uninstall(installDirectory); pass(scenario, 'uninstall')
  await assertInstallPayloadRemoved(installDirectory); pass(scenario, 'installed-payload-removed')
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'after clean uninstall')
  pass(scenario, 'application-data-preserved-on-uninstall')
}

async function upgradeScenario(testRoot, previous, current, scenario) {
  const base = join(testRoot, scenario.name)
  const installDirectory = join(base, 'application')
  const userData = join(base, 'user-data')
  const temporaryDirectory = join(base, 'temporary')
  const sourceDocument = join(base, 'source-documents', 'project-brief.md')
  const deleteResult = join(base, 'delete-all-result.json')
  await mkdir(dirname(sourceDocument), { recursive: true })
  await writeFile(sourceDocument, '# User-owned project brief\nThis file must survive upgrade and uninstall.\n', 'utf8')

  await install(previous, installDirectory); pass(scenario, 'previous-install')
  const previousExecutable = await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await launchAndInitialize(previousExecutable, userData, temporaryDirectory); pass(scenario, 'previous-launch')
  await seedApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name)
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'before upgrade')
  pass(scenario, 'upgrade-data-seeded')

  await install(current, installDirectory); pass(scenario, 'current-upgrade-install')
  await assertInstalledPayload(installDirectory); pass(scenario, 'upgraded-payload-present')
  const upgradedExecutable = await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await launchAndInitialize(upgradedExecutable, userData, temporaryDirectory)
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'after upgrade')
  pass(scenario, 'application-data-preserved-on-upgrade')

  const deletion = await runPackagedDeleteAll(upgradedExecutable, userData, temporaryDirectory, deleteResult)
  assertDeleteAllResult(deletion); pass(scenario, 'packaged-in-app-delete-all')
  await assertApplicationDataCleared(userData, temporaryDirectory, sourceDocument)
  pass(scenario, 'all-presenter-data-cleared-source-preserved')

  await uninstall(installDirectory); pass(scenario, 'upgraded-uninstall')
  await assertInstallPayloadRemoved(installDirectory); pass(scenario, 'upgraded-payload-removed')
  await assertApplicationDataCleared(userData, temporaryDirectory, sourceDocument)
  pass(scenario, 'cleared-state-preserved-on-uninstall')
}

async function install(installer, installDirectory) {
  await mkdir(installDirectory, { recursive: true })
  await runProcess(installer, ['/S', `/D=${installDirectory}`], 120_000, 'NSIS installation')
  await requireInstalledFile(installDirectory, 'PresenterAI.exe')
}

async function uninstall(installDirectory) {
  const activeProcessIds = processesUnderDirectory(installDirectory)
  if (activeProcessIds.length) {
    throw new Error(`Refusing to uninstall while ${activeProcessIds.length} controlled application process(es) remain active.`)
  }
  const uninstaller = await requireInstalledFile(installDirectory, 'Uninstall PresenterAI.exe')
  // Mirrors electron-builder's registered QuietUninstallString for this
  // per-user package. Without /currentuser, MultiUser.nsh can resolve a
  // different install context and exit successfully without removing payload.
  await runProcess(uninstaller, ['/currentuser', '/S'], 120_000, 'NSIS uninstall')
  try {
    await waitFor(async () => !existsSync(installDirectory) || (await listFiles(installDirectory)).length === 0,
      60_000, 'the complete installed application payload to be removed')
  } catch {
    const remaining = (await listFiles(installDirectory)).map((path) => relative(installDirectory, path))
    throw new Error(`The NSIS uninstaller left ${remaining.length} application payload file(s): ${remaining.slice(0, 12).join(', ') || '(none)'}.`)
  }
}

async function assertInstalledPayload(installDirectory) {
  await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await requireInstalledFile(installDirectory, 'app.asar')
  await requireInstalledFile(installDirectory, 'PresenterAI.WindowsHelper.exe')
}

async function assertInstallPayloadRemoved(installDirectory) {
  if (!existsSync(installDirectory)) return
  const remaining = await listFiles(installDirectory)
  if (remaining.length) throw new Error(`The uninstaller left ${remaining.length} application payload file(s) behind.`)
}

async function launchAndInitialize(executable, userData, temporaryDirectory) {
  await mkdir(userData, { recursive: true })
  await mkdir(temporaryDirectory, { recursive: true })
  const resultPath = join(dirname(userData), `launch-result-${++launchSequence}.json`)
  try {
    await runProcess(executable, [`--presenter-installer-launch-smoke=${resultPath}`], 90_000,
      'packaged application launch and graceful shutdown',
      smokeEnvironment(userData, temporaryDirectory, { PRESENTERAI_INSTALLER_SMOKE: '1' }))
    await waitFor(
      () => processesUnderDirectory(dirname(executable)).length === 0,
      15_000,
      'the packaged application and bundled helper to stop before installer mutation'
    )
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    if (result.ok !== true || result.initialized !== true) throw new Error('The packaged application did not report completed initialization.')
    if (!existsSync(join(userData, 'presenterai.json')) || !existsSync(join(userData, 'documents.sqlite'))) {
      throw new Error('The packaged application exited without initializing its isolated local data.')
    }
  } catch (error) {
    const readiness = existsSync(resultPath) ? 'written' : 'not written'
    await terminateProcessesUnderDirectory(dirname(executable))
    throw new Error(`${error instanceof Error ? error.message : 'Packaged launch failed.'} The initialization result was ${readiness}.`)
  }
}

async function runPackagedDeleteAll(executable, userData, temporaryDirectory, outputPath) {
  const argument = `--presenter-delete-all-smoke=${outputPath}`
  await runProcess(executable, [argument], 90_000, 'packaged in-app Delete All',
    smokeEnvironment(userData, temporaryDirectory, { PRESENTERAI_INSTALLER_SMOKE: '1' }))
  return JSON.parse(await readFile(outputPath, 'utf8'))
}

async function seedApplicationData(userData, temporaryDirectory, sourceDocument, scenario) {
  const settingsPath = join(userData, 'presenterai.json')
  const stored = JSON.parse(await readFile(settingsPath, 'utf8'))
  const now = '2026-01-02T03:04:05.000Z'
  const documentId = `installer-smoke-${scenario}`
  stored.schemaVersion = 2
  stored.settings = { ...stored.settings, projectSummary: `installer-smoke:${scenario}`, inrPerUsd: 83 }
  stored.windowBounds = { x: 11, y: 22, width: 555, height: 666 }
  stored.captureResults = [{
    id: `capture-${scenario}`, path: 'Snipping Tool', captureAppVersion: 'smoke',
    controlResult: 'overlay-visible', protectedResult: 'overlay-absent', testedAt: now, notes: 'synthetic installer smoke',
    environment: { windowsBuild: 'smoke', presenterVersion: 'smoke', electronVersion: 'smoke', gpu: 'smoke', monitorCount: 1 }
  }]
  stored.usage = {
    inputTokens: 10, outputTokens: 5, audioMinutes: 0,
    transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
    estimatedUsd: 0.00004, pricingVersion: 'openai-2026-07-16'
  }
  stored.usageRecords = [{
    id: `usage-${scenario}`, timestamp: now, endpoint: 'responses', requestedModel: 'gpt-5.6-luna',
    returnedModel: 'gpt-5.6-luna', inputTokens: 10, outputTokens: 5,
    pricingVersion: 'openai-2026-07-16', priced: true, estimatedUsd: 0.00004
  }]
  stored.usageRollups = []
  stored.privacyConsent = { acceptedVersion: 2, acceptedAt: now }

  const database = new DatabaseSync(join(userData, 'documents.sqlite'))
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
    database.prepare(`INSERT OR REPLACE INTO documents
      (id, canonical_path, path, name, kind, content_hash, chunk_count, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(documentId, canonicalPath(sourceDocument), sourceDocument, basename(sourceDocument), 'text', hash('source'), 1, now, now)
    database.prepare(`INSERT OR REPLACE INTO chunks
      (id, document_id, text, title, location, kind, page_or_slide, section, part, part_count, source_order, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${documentId}:chunk`, documentId, `Indexed ${scenario} evidence`, 'Installer lifecycle', 'Section: Installer lifecycle',
        'text', null, 'Installer lifecycle', 1, 1, 0, hash(`Indexed ${scenario} evidence`))
    database.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(`${documentId}:chunk`)
    database.prepare('INSERT INTO chunks_fts (chunk_id, text, title, location, document_name) VALUES (?, ?, ?, ?, ?)')
      .run(`${documentId}:chunk`, `Indexed ${scenario} evidence`, 'Installer lifecycle', 'Section: Installer lifecycle', basename(sourceDocument))
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally { database.close() }
  stored.documents = [{
    id: documentId, name: basename(sourceDocument), path: sourceDocument, kind: 'text', chunkCount: 1, addedAt: now
  }]
  await writeFile(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  await writeFile(join(userData, 'openai-key.bin'), Buffer.from('synthetic-encrypted-ciphertext'), { flag: 'wx' })
  await writeFile(join(userData, 'openai-key.meta.json'), JSON.stringify({ schemaVersion: 1, updatedAt: now }), { flag: 'wx' })
  const audioDirectory = join(temporaryDirectory, 'PresenterAI-audio')
  await mkdir(audioDirectory, { recursive: true })
  await writeFile(join(audioDirectory, `presenterai-${scenario}.wav`), Buffer.from('synthetic-wav'), { flag: 'wx' })
}

async function assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario, stage) {
  const stored = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
  if (stored.settings?.projectSummary !== `installer-smoke:${scenario}` || stored.settings?.inrPerUsd !== 83) {
    throw new Error(`The seeded settings were not preserved ${stage}.`)
  }
  if (!stored.windowBounds || stored.captureResults?.length !== 1 || stored.usageRecords?.length !== 1 || stored.privacyConsent?.acceptedVersion !== 2) {
    throw new Error(`The seeded M8 local state was not preserved ${stage}.`)
  }
  for (const path of [
    join(userData, 'openai-key.bin'), join(userData, 'openai-key.meta.json'),
    join(temporaryDirectory, 'PresenterAI-audio', `presenterai-${scenario}.wav`), sourceDocument
  ]) if (!existsSync(path)) throw new Error(`${basename(path)} was unexpectedly removed ${stage}.`)
  const counts = databaseCounts(join(userData, 'documents.sqlite'))
  if (counts.documents !== 1 || counts.chunks !== 1 || counts.fts !== 1) {
    throw new Error(`The seeded SQLite/FTS index was not preserved ${stage}.`)
  }
}

async function assertApplicationDataCleared(userData, temporaryDirectory, sourceDocument) {
  if (!existsSync(sourceDocument)) throw new Error('Delete All or uninstall removed the user-owned source document.')
  const stored = JSON.parse(await readFile(join(userData, 'presenterai.json'), 'utf8'))
  if (stored.settings?.projectSummary !== '' || stored.settings?.inrPerUsd !== undefined || stored.windowBounds !== undefined ||
      stored.captureResults?.length !== 0 || stored.usageRecords?.length !== 0 || stored.usageRollups?.length !== 0 ||
      stored.privacyConsent !== undefined || stored.documents?.length !== 0) {
    throw new Error('Delete All did not restore settings, consent, compatibility, usage, bounds, and catalog defaults.')
  }
  if (stored.usage?.inputTokens !== 0 || stored.usage?.outputTokens !== 0 || stored.usage?.estimatedUsd !== 0) {
    throw new Error('Delete All did not clear aggregate usage.')
  }
  for (const path of [
    join(userData, 'openai-key.bin'), join(userData, 'openai-key.meta.json')
  ]) if (existsSync(path)) throw new Error(`${basename(path)} remained after Delete All.`)
  const ownedAudio = existsSync(join(temporaryDirectory, 'PresenterAI-audio'))
    ? (await readdir(join(temporaryDirectory, 'PresenterAI-audio'))).filter((name) => name.toLocaleLowerCase('en-US').endsWith('.wav'))
    : []
  if (ownedAudio.length) throw new Error('PresenterAI-owned temporary WAVs remained after Delete All.')
  const counts = databaseCounts(join(userData, 'documents.sqlite'))
  if (counts.documents !== 0 || counts.chunks !== 0 || counts.fts !== 0) throw new Error('Delete All left SQLite or FTS rows behind.')
}

function assertDeleteAllResult(result) {
  const expected = ['session', 'documents', 'usage', 'compatibility', 'consent', 'api-key', 'temporary-audio', 'settings']
  if (result?.ok !== true || result.failedScopes?.length !== 0 || !Array.isArray(result.scopes)) {
    throw new Error('The packaged in-app Delete All operation did not report success.')
  }
  if (JSON.stringify(result.scopes.map(({ scope, ok }) => `${scope}:${ok}`)) !== JSON.stringify(expected.map((scope) => `${scope}:true`))) {
    throw new Error('The packaged in-app Delete All result omitted or failed a required scope.')
  }
}

function databaseCounts(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      documents: Number(database.prepare('SELECT COUNT(*) AS count FROM documents').get().count),
      chunks: Number(database.prepare('SELECT COUNT(*) AS count FROM chunks').get().count),
      fts: Number(database.prepare('SELECT COUNT(*) AS count FROM chunks_fts').get().count)
    }
  } finally { database.close() }
}

async function requireInstalledFile(rootDirectory, expectedName) {
  const found = await findFile(rootDirectory, expectedName)
  if (!found) throw new Error(`${expectedName} was not found beneath the controlled install directory.`)
  return found
}

async function findFile(directory, expectedName) {
  if (!existsSync(directory)) return undefined
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(path, expectedName)
      if (nested) return nested
    } else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US') === expectedName.toLocaleLowerCase('en-US')) return path
  }
  return undefined
}

async function listFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else files.push(path)
  }
  return files
}

async function resolveInstaller(input, fallbackDirectory) {
  const candidate = input && resolve(input)
  if (candidate && existsSync(candidate) && (await stat(candidate)).isFile()) return validateInstaller(candidate)
  const directory = candidate ?? fallbackDirectory
  if (!existsSync(directory) || !(await stat(directory)).isDirectory()) throw new Error(`Installer path was not found: ${directory}`)
  const installers = (await readdir(directory, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && /^PresenterAI-.+-setup\.exe$/i.test(entry.name))
    .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name))
  if (installers.length === 0) throw new Error(`No PresenterAI NSIS installer was found beneath ${directory}.`)
  const withTimes = await Promise.all(installers.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })))
  withTimes.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path))
  return validateInstaller(withTimes[0].path)
}

function validateInstaller(path) {
  if (!isAbsolute(path) || !path.toLocaleLowerCase('en-US').endsWith('.exe')) throw new Error(`Installer must be an absolute .exe path: ${path}`)
  return path
}

function parseArguments(values) {
  const result = { current: undefined, previous: undefined, report: undefined, requirePrevious: false }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--require-previous') result.requirePrevious = true
    else if (value === '--current' || value === '--previous' || value === '--report') {
      const path = values[++index]
      if (!path) throw new Error(`${value} requires a path.`)
      result[value.slice(2)] = path
    } else throw new Error(`Unknown installer-smoke argument: ${value}`)
  }
  return result
}

async function runProcess(file, arguments_, timeoutMs, label, environment = process.env) {
  const child = spawn(file, arguments_, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000) })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { killTree(child.pid); reject(new Error(`${label} timed out.${diagnostics(stdout, stderr)}`)) }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
  if (exitCode !== 0) throw new Error(`${label} exited with code ${exitCode}.${diagnostics(stdout, stderr)}`)
}

async function waitFor(predicate, timeoutMs, description) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function smokeEnvironment(userData, temporaryDirectory, additions = {}) {
  return {
    ...process.env,
    PRESENTERAI_E2E_USER_DATA: userData,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    ...additions
  }
}

function assertControlledRoot(path) {
  const base = resolve(tmpdir())
  const target = resolve(path)
  const childPath = relative(base, target)
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath) || !basename(target).startsWith('presenterai-installer-smoke-')) {
    throw new Error(`Refusing cleanup outside a controlled PresenterAI smoke directory: ${target}`)
  }
}

function createScenario(name) { return { name, ok: true, steps: [] } }
function pass(scenario, step) { scenario.steps.push({ step, ok: true }) }
function canonicalPath(path) { return resolve(path).toLocaleLowerCase('en-US') }
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function samePath(left, right) { return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US') }
function diagnostics(stdout, stderr) {
  const details = [stdout.trim() && `stdout: ${stdout.trim()}`, stderr.trim() && `stderr: ${stderr.trim()}`].filter(Boolean)
  return details.length ? ` ${details.join(' | ')}` : ''
}
function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

async function terminateProcessesUnderDirectory(directory) {
  assertControlledInstallDirectory(directory)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const processIds = processesUnderDirectory(directory)
    if (!processIds.length) return
    for (const pid of processIds) killTree(pid)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
}

function processesUnderDirectory(directory) {
  assertControlledInstallDirectory(directory)
  const script = [
    "$root = [IO.Path]::GetFullPath($env:PRESENTERAI_SMOKE_PROCESS_ROOT).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    'Get-Process -ErrorAction SilentlyContinue | ForEach-Object {',
    '  try { $candidate = $_.Path } catch { $candidate = $null }',
    '  if ($candidate -and [IO.Path]::GetFullPath($candidate).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $_.Id }',
    '}'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PRESENTERAI_SMOKE_PROCESS_ROOT: resolve(directory) }
  })
  if (result.status !== 0) throw new Error('Unable to inspect the controlled installer process tree.')
  return result.stdout.split(/\r?\n/u)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value !== process.pid)
}

function assertControlledInstallDirectory(directory) {
  const base = resolve(tmpdir())
  let cursor = resolve(directory)
  const childPath = relative(base, cursor)
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath)) {
    throw new Error(`Refusing process cleanup outside the temporary directory: ${cursor}`)
  }
  while (relative(base, cursor) && cursor !== base) {
    if (basename(cursor).startsWith('presenterai-installer-smoke-')) return
    cursor = dirname(cursor)
  }
  throw new Error(`Refusing process cleanup outside a controlled PresenterAI smoke directory: ${directory}`)
}
