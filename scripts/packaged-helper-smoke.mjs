import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const unpacked = resolve(process.argv[2] ?? 'release/win-unpacked')
if (!existsSync(unpacked)) throw new Error(`Packaged application directory was not found: ${unpacked}`)
const executable = readdirSync(unpacked).find((name) => name.toLowerCase() === 'presenterai.exe')
if (!executable) throw new Error(`PresenterAI.exe was not found in the packaged application directory: ${unpacked}`)

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'presenterai-helper-'))
const outputPath = resolve(temporaryDirectory, 'result.json')
const child = spawn(resolve(unpacked, executable), [`--presenter-helper-smoke=${outputPath}`], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000) })
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`Packaged helper probe timed out.${diagnostics(stdout, stderr)}`))
    }, 90_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
  const report = await readFile(outputPath, 'utf8').then(JSON.parse, () => undefined)
  if (exitCode !== 0) throw new Error(`Packaged helper probe exited with code ${exitCode}.${report ? ` Report: ${JSON.stringify(report)}` : ''}${diagnostics(stdout, stderr)}`)
  if (!report) throw new Error(`Packaged helper probe did not write a report.${diagnostics(stdout, stderr)}`)
  const required = ['hook-ready', 'single-file-capture', 'bounded-capture', 'capture-limit-events', 'operation-ids']
  if (report.ok !== true || report.state !== 'ready' || report.protocolVersion !== 2 || !required.every((feature) => report.features?.includes(feature))) {
    throw new Error(`Packaged helper probe returned an invalid result: ${JSON.stringify(report)}`)
  }
  process.stdout.write(`Packaged Electron ${report.electron} located protocol v${report.protocolVersion} helper with ${report.features.length} features.\n`)
} finally {
  if (child.exitCode === null) killTree(child.pid)
  await rm(temporaryDirectory, { recursive: true, force: true })
}

function diagnostics(stdout, stderr) {
  const details = [stdout.trim() && `stdout: ${stdout.trim()}`, stderr.trim() && `stderr: ${stderr.trim()}`].filter(Boolean)
  return details.length ? ` ${details.join(' | ')}` : ''
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGKILL')
}
