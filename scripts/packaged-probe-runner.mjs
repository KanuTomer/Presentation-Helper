import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export async function runPackagedProbe(argumentPrefix, timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), 'presenterai-packaged-probe-'))
  const outputPath = join(root, 'result.json')
  const unpackedExecutable = resolveExecutable(resolve(process.argv[2] ?? 'release/win-unpacked'))
  let source = 'win-unpacked'
  let execution
  try {
    try {
      execution = await runProcess(unpackedExecutable, [`${argumentPrefix}${outputPath}`], timeoutMs)
    } catch (error) {
      if (!isApplicationControlSpawnError(error)) throw error
      source = 'controlled-nsis-install'
      execution = await runFromControlledInstall(root, argumentPrefix, outputPath, timeoutMs)
    }
    const report = await readFile(outputPath, 'utf8').then(JSON.parse, () => undefined)
    return { ...execution, report, source }
  } finally {
    assertControlledRoot(root)
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
  }
}

async function runFromControlledInstall(root, argumentPrefix, outputPath, timeoutMs) {
  const installer = await latestInstaller(resolve('release'))
  const installDirectory = join(root, 'application')
  const installation = await runProcess(installer, ['/S', `/D=${installDirectory}`], 120_000)
  if (installation.exitCode !== 0) throw new Error(`Controlled NSIS probe installation exited with code ${installation.exitCode}.`)
  try {
    return await runProcess(resolveExecutable(installDirectory), [`${argumentPrefix}${outputPath}`], timeoutMs)
  } finally {
    const uninstaller = join(installDirectory, 'Uninstall PresenterAI.exe')
    if (existsSync(uninstaller)) {
      const uninstallation = await runProcess(uninstaller, ['/currentuser', '/S'], 120_000)
      if (uninstallation.exitCode !== 0) throw new Error(`Controlled NSIS probe uninstall exited with code ${uninstallation.exitCode}.`)
      await waitFor(() => !existsSync(installDirectory), 60_000)
    }
  }
}

async function latestInstaller(directory) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^PresenterAI-.+-setup\.exe$/iu.test(entry.name))
    .map((entry) => resolve(directory, entry.name))
  if (!candidates.length) throw new Error('A current PresenterAI NSIS installer is required for the Application Control fallback.')
  const ranked = await Promise.all(candidates.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })))
  ranked.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path))
  return ranked[0].path
}

function resolveExecutable(directory) {
  const executable = join(directory, 'PresenterAI.exe')
  if (!existsSync(executable)) throw new Error(`PresenterAI.exe was not found in the packaged application directory: ${directory}`)
  return executable
}

function runProcess(file, arguments_, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    let child
    try {
      child = spawn(file, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) { reject(error); return }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000) })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`Packaged probe timed out.${diagnostics(stdout, stderr)}`))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (exitCode) => { clearTimeout(timer); resolveRun({ exitCode, stdout, stderr }) })
  })
}

function isApplicationControlSpawnError(error) {
  return process.platform === 'win32' && error instanceof Error &&
    ('code' in error && (error.code === 'UNKNOWN' || error.code === 'EPERM'))
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('Timed out waiting for the controlled NSIS probe installation to be removed.')
}

function assertControlledRoot(path) {
  const target = resolve(path)
  const base = resolve(tmpdir())
  if (!target.startsWith(`${base}\\`) || !basename(target).startsWith('presenterai-packaged-probe-')) {
    throw new Error(`Refusing packaged-probe cleanup outside its controlled temporary directory: ${target}`)
  }
}

function diagnostics(stdout, stderr) {
  const details = [stdout.trim() && `stdout: ${stdout.trim()}`, stderr.trim() && `stderr: ${stderr.trim()}`].filter(Boolean)
  return details.length ? ` ${details.join(' | ')}` : ''
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else process.kill(pid, 'SIGKILL')
}

export function probeDiagnostics(stdout, stderr) { return diagnostics(stdout, stderr) }
