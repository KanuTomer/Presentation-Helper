import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DELETE_ALL_SCOPES,
  InstallerSmokeError,
  appendRedactedDiagnostic,
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
} from './installer-smoke-support.mjs'

if (process.platform !== 'win32') throw new Error('The NSIS installer smoke test requires Windows.')

const arguments_ = parseInstallerSmokeArguments(process.argv.slice(2))
const currentInstaller = await resolveInstaller(arguments_.current, resolve('release'))
const previousInstaller = arguments_.previous ? await resolveInstaller(arguments_.previous) : undefined
if (arguments_.requirePrevious && !previousInstaller) throw new Error('A previous successful main installer is required for the upgrade smoke test.')
if (previousInstaller && samePath(previousInstaller, currentInstaller)) throw new Error('Current and previous installer paths must be distinct files.')
const packageMetadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
const installers = await validateInstallerUpgrade({
  currentPath: currentInstaller,
  previousPath: previousInstaller,
  packageVersion: packageMetadata.version
})
const previousProvenance = validatePreviousProvenance({
  runId: arguments_.previousRunId,
  headSha: arguments_.previousHeadSha,
  hasPrevious: Boolean(previousInstaller)
})

const reportPath = resolve(arguments_.report ?? join('artifacts', 'installer', 'installer-lifecycle-report.json'))
if (!reportPath.toLocaleLowerCase('en-US').endsWith('.json')) throw new Error('The installer lifecycle report must be a JSON file.')
const report = {
  ...createSafeInstallerReportHeader({
    generatedAt: new Date().toISOString(),
    installers,
    provenance: previousProvenance,
    previousBaselineRequired: arguments_.requirePrevious
  }),
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
    report.scenarios.at(-1).failureCode = redactedFailureCode(error)
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
  await launchAndInitialize(executable, userData, temporaryDirectory, scenario, 'current-clean-launch'); pass(scenario, 'initial-launch')
  await seedApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name)
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'before clean uninstall')
  pass(scenario, 'application-data-seeded')

  await uninstall(installDirectory, scenario, 'clean-uninstall'); pass(scenario, 'uninstall')
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
  await launchLegacyAndInitialize(previousExecutable, userData, temporaryDirectory, scenario); pass(scenario, 'previous-launch')
  await seedApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name)
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'before upgrade')
  pass(scenario, 'upgrade-data-seeded')

  await install(current, installDirectory); pass(scenario, 'current-upgrade-install')
  await assertInstalledPayload(installDirectory); pass(scenario, 'upgraded-payload-present')
  const upgradedExecutable = await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await launchAndInitialize(upgradedExecutable, userData, temporaryDirectory, scenario, 'current-upgraded-launch')
  await assertSeededApplicationData(userData, temporaryDirectory, sourceDocument, scenario.name, 'after upgrade')
  pass(scenario, 'application-data-preserved-on-upgrade')

  await runPackagedDeleteAll(upgradedExecutable, userData, temporaryDirectory, deleteResult, scenario)
  pass(scenario, 'packaged-in-app-delete-all')
  await assertApplicationDataCleared(userData, temporaryDirectory, sourceDocument)
  pass(scenario, 'all-presenter-data-cleared-source-preserved')

  await uninstall(installDirectory, scenario, 'upgraded-uninstall'); pass(scenario, 'upgraded-uninstall')
  await assertInstallPayloadRemoved(installDirectory); pass(scenario, 'upgraded-payload-removed')
  await assertApplicationDataCleared(userData, temporaryDirectory, sourceDocument)
  pass(scenario, 'cleared-state-preserved-on-uninstall')
}

async function install(installer, installDirectory) {
  await mkdir(installDirectory, { recursive: true })
  await runProcess(installer, ['/S', `/D=${installDirectory}`], 120_000, 'NSIS installation')
  await requireInstalledFile(installDirectory, 'PresenterAI.exe')
}

async function uninstall(installDirectory, scenario, phase) {
  const activeProcessIds = processesUnderDirectory(installDirectory)
  if (activeProcessIds.length) {
    throw new Error(`Refusing to uninstall while ${activeProcessIds.length} controlled application process(es) remain active.`)
  }
  const uninstaller = await requireInstalledFile(installDirectory, 'Uninstall PresenterAI.exe')
  appendRedactedDiagnostic(scenario, phase, 'uninstall-starting', {
    processCount: activeProcessIds.length,
    payloadFileCount: (await listFilesResilient(installDirectory)).length
  })
  // Mirrors electron-builder's registered QuietUninstallString for this
  // per-user package. Without /currentuser, MultiUser.nsh can resolve a
  // different install context and exit successfully without removing payload.
  await runProcess(uninstaller, ['/currentuser', '/S'], 120_000, 'NSIS uninstall')
  appendRedactedDiagnostic(scenario, phase, 'uninstaller-exited', {
    payloadFileCount: (await listFilesResilient(installDirectory)).length
  })
  try {
    await waitForPayloadRemoval({ directory: installDirectory })
    appendRedactedDiagnostic(scenario, phase, 'payload-removal-complete', { payloadFileCount: 0 })
  } catch (error) {
    if (!(error instanceof InstallerSmokeError) || error.code !== 'payload-removal-timeout') throw error
    const remaining = (await listFilesResilient(installDirectory)).map((path) => relative(installDirectory, path))
    appendRedactedDiagnostic(scenario, phase, 'payload-removal-timeout', { payloadFileCount: remaining.length })
    throw new InstallerSmokeError(
      'payload-removal-timeout',
      `The NSIS uninstaller left ${remaining.length} application payload file(s): ${remaining.slice(0, 12).join(', ') || '(none)'}.`
    )
  }
}

async function assertInstalledPayload(installDirectory) {
  await requireInstalledFile(installDirectory, 'PresenterAI.exe')
  await requireInstalledFile(installDirectory, 'app.asar')
  await requireInstalledFile(installDirectory, 'PresenterAI.WindowsHelper.exe')
}

async function assertInstallPayloadRemoved(installDirectory) {
  if (!existsSync(installDirectory)) return
  const remaining = await listFilesResilient(installDirectory)
  if (remaining.length) throw new Error(`The uninstaller left ${remaining.length} application payload file(s) behind.`)
}

async function launchLegacyAndInitialize(executable, userData, temporaryDirectory, scenario) {
  await mkdir(userData, { recursive: true })
  await mkdir(temporaryDirectory, { recursive: true })
  const installDirectory = dirname(executable)
  const { settingsPath, databasePath } = applicationStatePaths(userData)
  appendRedactedDiagnostic(scenario, 'previous-launch', 'process-starting')

  let exited = false
  let spawnError
  const child = spawn(executable, [], {
    env: smokeEnvironment(userData, temporaryDirectory),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  // Drain both streams so a noisy older build cannot block on a full pipe. No
  // process output is persisted because it can contain machine-local paths.
  child.stdout.resume()
  child.stderr.resume()
  child.once('error', (error) => { spawnError = error; exited = true })
  child.once('exit', () => { exited = true })
  appendRedactedDiagnostic(scenario, 'previous-launch', 'process-started', { processCount: 1 })

  let lastReadinessState
  try {
    await waitForLegacyReadiness({
      inspect: () => inspectLegacyReadiness({ settingsPath, databasePath }),
      isProcessActive: () => !spawnError && (!exited || processesUnderDirectory(installDirectory).length > 0),
      timeoutMs: 90_000,
      onState: (readiness) => {
        if (readiness.state === lastReadinessState) return
        lastReadinessState = readiness.state
        appendRedactedDiagnostic(scenario, 'previous-launch', readiness.state, {
          missingTableCount: readiness.missingTableCount,
          settingsWritten: existsSync(settingsPath),
          databaseWritten: existsSync(databasePath)
        })
      }
    })
    // The durable files are created before the legacy startup chain finishes.
    // Require a short stable interval so schema creation alone is not mistaken
    // for a fully running tray application.
    await new Promise((resolveWait) => setTimeout(resolveWait, 750))
    if (spawnError || (exited && processesUnderDirectory(installDirectory).length === 0)) {
      throw new InstallerSmokeError('legacy-app-exited-early', 'The previous application exited immediately after creating its isolated state.')
    }
    const stableReadiness = await inspectLegacyReadiness({ settingsPath, databasePath })
    if (!stableReadiness.ready) {
      throw new InstallerSmokeError('legacy-state-unstable', 'The previous application state did not remain readable during startup.')
    }
    appendRedactedDiagnostic(scenario, 'previous-launch', 'legacy-state-ready', {
      settingsWritten: true,
      databaseWritten: true
    })

    await terminateControlledProcessesUnderDirectory(installDirectory, scenario, 'previous-launch')
    await waitFor(
      () => processesUnderDirectory(installDirectory).length === 0,
      15_000,
      'the previous packaged application and bundled helper to stop before upgrade'
    )
    appendRedactedDiagnostic(scenario, 'previous-launch', 'processes-stopped', { processCount: 0 })

    const reopened = await inspectLegacyReadiness({ settingsPath, databasePath })
    if (!reopened.ready) {
      throw new InstallerSmokeError('legacy-state-reopen-failed', 'The previous application state could not be reopened after shutdown.')
    }
    appendRedactedDiagnostic(scenario, 'previous-launch', 'database-reopened')
  } catch (error) {
    appendRedactedDiagnostic(scenario, 'previous-launch', 'launch-failed', {
      processCount: processesUnderDirectory(installDirectory).length,
      settingsWritten: existsSync(settingsPath),
      databaseWritten: existsSync(databasePath)
    })
    try { await terminateControlledProcessesUnderDirectory(installDirectory, scenario, 'previous-launch-cleanup') } catch { /* Preserve primary failure. */ }
    if (spawnError) throw new InstallerSmokeError('legacy-spawn-failed', 'The previous packaged application could not be started.')
    throw error
  }
}

async function launchAndInitialize(executable, userData, temporaryDirectory, scenario, phase) {
  await mkdir(userData, { recursive: true })
  await mkdir(temporaryDirectory, { recursive: true })
  const resultPath = join(dirname(userData), `launch-result-${++launchSequence}.json`)
  const { settingsPath, databasePath } = applicationStatePaths(userData)
  appendRedactedDiagnostic(scenario, phase, 'process-starting', { resultWritten: false })
  try {
    await runProcess(executable, [`--presenter-installer-launch-smoke=${resultPath}`], 90_000,
      'packaged application launch and graceful shutdown',
      smokeEnvironment(userData, temporaryDirectory, { PRESENTERAI_INSTALLER_SMOKE: '1' }))
    appendRedactedDiagnostic(scenario, phase, 'process-exited', {
      processCount: processesUnderDirectory(dirname(executable)).length,
      resultWritten: existsSync(resultPath)
    })
    await waitFor(
      () => processesUnderDirectory(dirname(executable)).length === 0,
      15_000,
      'the packaged application and bundled helper to stop before installer mutation'
    )
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    validateCurrentLaunchResult(result)
    appendRedactedDiagnostic(scenario, phase, 'launch-result-validated', { resultWritten: true })
    const readiness = await inspectLegacyReadiness({ settingsPath, databasePath })
    if (!readiness.ready) {
      throw new InstallerSmokeError('current-state-not-ready', 'The current packaged application exited without fully initializing its isolated local data.')
    }
    appendRedactedDiagnostic(scenario, phase, 'application-state-ready', {
      processCount: 0,
      resultWritten: true,
      settingsWritten: true,
      databaseWritten: true
    })
  } catch (error) {
    const readiness = existsSync(resultPath) ? 'written' : 'not written'
    appendRedactedDiagnostic(scenario, phase, 'launch-failed', {
      processCount: processesUnderDirectory(dirname(executable)).length,
      resultWritten: existsSync(resultPath),
      settingsWritten: existsSync(settingsPath),
      databaseWritten: existsSync(databasePath)
    })
    await terminateControlledProcessesUnderDirectory(dirname(executable), scenario, `${phase}-cleanup`)
    if (error instanceof InstallerSmokeError) throw error
    throw new InstallerSmokeError('current-launch-failed', `${error instanceof Error ? error.message : 'Packaged launch failed.'} The initialization result was ${readiness}.`)
  }
}

function applicationStatePaths(userData) {
  return {
    settingsPath: join(userData, 'presenterai.json'),
    databasePath: join(userData, 'documents.sqlite')
  }
}

async function runPackagedDeleteAll(executable, userData, temporaryDirectory, outputPath, scenario) {
  const argument = `--presenter-delete-all-smoke=${outputPath}`
  const installDirectory = dirname(executable)
  appendRedactedDiagnostic(scenario, 'delete-all', 'process-starting', {
    processCount: 0,
    resultWritten: false,
    failedScopes: []
  })
  let failure
  let result
  try {
    await runProcess(executable, [argument], 90_000, 'packaged in-app Delete All',
      smokeEnvironment(userData, temporaryDirectory, { PRESENTERAI_INSTALLER_SMOKE: '1' }))
    const inspected = await inspectDeleteAllResult(outputPath)
    if (!inspected.resultWritten) {
      throw new InstallerSmokeError('delete-all-invalid-result', 'The packaged Delete All operation did not write a result.')
    }
    try { assertDeleteAllResult(inspected.result) } catch {
      throw new InstallerSmokeError('delete-all-invalid-result', 'The packaged Delete All result omitted or failed a required scope.')
    }
    result = inspected.result
    appendRedactedDiagnostic(scenario, 'delete-all', 'result-validated', {
      processCount: processesUnderDirectory(installDirectory).length,
      resultWritten: true,
      failedScopes: inspected.failedScopes
    })
  } catch (error) {
    let inspected = { resultWritten: existsSync(outputPath), failedScopes: [], failedScopeCount: 0 }
    try { inspected = await inspectDeleteAllResult(outputPath) } catch { /* Invalid output is represented by the stable failure code. */ }
    const code = deleteAllFailureCode(error)
    appendRedactedDiagnostic(scenario, 'delete-all', code, {
      exitCode: error instanceof InstallerSmokeError ? error.exitCode : undefined,
      processCount: processesUnderDirectory(installDirectory).length,
      resultWritten: inspected.resultWritten,
      failedScopes: inspected.failedScopes
    })
    failure = new InstallerSmokeError(code, 'The packaged in-app Delete All validation failed.')
  }

  try {
    await terminateControlledProcessesUnderDirectory(installDirectory, scenario, 'delete-all-cleanup')
  } catch {
    appendRedactedDiagnostic(scenario, 'delete-all', 'delete-all-process-cleanup-failed', {
      processCount: processesUnderDirectory(installDirectory).length,
      resultWritten: existsSync(outputPath)
    })
    failure ??= new InstallerSmokeError('delete-all-process-cleanup-failed', 'Controlled Delete All processes remained active.')
  }
  if (failure) throw failure
  return result
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
  const migrated = stage === 'after upgrade'
  const settingsPreserved = stored.settings?.projectSummary === `installer-smoke:${scenario}` && (migrated
    ? stored.schemaVersion === 4 && stored.settings?.inrPerUsd === undefined && stored.settings?.opacity === undefined &&
      stored.settings?.glassTint === 0.42 && stored.settings?.sessionBudgetUsd === 0.25
    : stored.settings?.inrPerUsd === 83)
  if (!settingsPreserved) {
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
  if (stored.schemaVersion !== 4 || stored.settings?.projectSummary !== '' || stored.settings?.inrPerUsd !== undefined ||
      stored.settings?.opacity !== undefined || stored.settings?.glassTint !== 0.42 || stored.settings?.sessionBudgetUsd !== 0.25 || stored.windowBounds !== undefined ||
      stored.captureResults?.length !== 0 || stored.usageRecords?.length !== 0 || stored.usageRollups?.length !== 0 ||
      stored.privacyConsent !== undefined || stored.documents?.length !== 0 || stored.sessionBudget?.actualUsd !== 0 ||
      stored.sessionBudget?.reservations?.length !== 0) {
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
  if (result?.ok !== true || result.failedScopes?.length !== 0 || !Array.isArray(result.scopes)) {
    throw new Error('The packaged in-app Delete All operation did not report success.')
  }
  if (JSON.stringify(result.scopes.map(({ scope, ok }) => `${scope}:${ok}`)) !== JSON.stringify(DELETE_ALL_SCOPES.map((scope) => `${scope}:true`))) {
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

async function runProcess(file, arguments_, timeoutMs, label, environment = process.env) {
  const child = spawn(file, arguments_, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000) })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new InstallerSmokeError('process-timeout', `${label} timed out.${diagnostics(stdout, stderr)}`))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new InstallerSmokeError('process-spawn-failed', `${label} could not be started.`))
    })
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
  if (exitCode !== 0) {
    throw new InstallerSmokeError(
      'process-nonzero-exit',
      `${label} exited with code ${exitCode}.${diagnostics(stdout, stderr)}`,
      { exitCode }
    )
  }
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

function createScenario(name) { return { name, ok: true, steps: [], diagnostics: [] } }
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

async function terminateControlledProcessesUnderDirectory(directory, scenario, phase) {
  assertControlledInstallDirectory(directory)
  await terminateControlledProcessSet({
    listProcessIds: () => processesUnderDirectory(directory),
    killProcessTree: killTree,
    onState: ({ state, processCount }) => appendRedactedDiagnostic(scenario, phase, state, { processCount })
  })
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
