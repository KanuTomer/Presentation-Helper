import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const unpacked = resolve(process.argv[2] ?? 'release/win-unpacked')
if (!existsSync(unpacked)) throw new Error(`Packaged application directory was not found: ${unpacked}`)
const executable = readdirSync(unpacked).find((name) => name.toLowerCase() === 'presenterai.exe')
if (!executable) throw new Error(`PresenterAI.exe was not found in the packaged application directory: ${unpacked}`)

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'presenterai-fts5-'))
const outputPath = resolve(temporaryDirectory, 'result.json')
const child = spawn(resolve(unpacked, executable), [`--presenter-fts5-smoke=${outputPath}`], {
  stdio: 'ignore', windowsHide: true
})
try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged FTS5 probe timed out.')) }, 30_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
  if (exitCode !== 0) throw new Error(`Packaged FTS5 probe exited with code ${exitCode}.`)
  const report = JSON.parse(await readFile(outputPath, 'utf8'))
  if (report.ok !== true || !report.electron) throw new Error('Packaged FTS5 probe returned an invalid result.')
  process.stdout.write(`Packaged Electron ${report.electron} exposes SQLite ${report.sqlite ?? 'unknown'} with FTS5.\n`)
} finally {
  if (child.exitCode === null) child.kill()
  await rm(temporaryDirectory, { recursive: true, force: true })
}
