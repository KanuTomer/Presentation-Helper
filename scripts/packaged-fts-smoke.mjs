import { runPackagedProbe, probeDiagnostics } from './packaged-probe-runner.mjs'

const { exitCode, stdout, stderr, report, source } = await runPackagedProbe('--presenter-fts5-smoke=', 30_000)
if (exitCode !== 0) throw new Error(`Packaged FTS5 probe exited with code ${exitCode}.${probeDiagnostics(stdout, stderr)}`)
if (report?.ok !== true || !report.electron) throw new Error('Packaged FTS5 probe returned an invalid result.')
process.stdout.write(`Packaged Electron ${report.electron} exposes SQLite ${report.sqlite ?? 'unknown'} with FTS5 (${source}).\n`)
