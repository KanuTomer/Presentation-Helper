import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateM7Offline } from '../src/main/ai/m7Eval.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpus = JSON.parse(await readFile(resolve(root, 'tests/fixtures/m7-offline-corpus.json'), 'utf8')) as unknown
const report = await evaluateM7Offline(corpus)
const reportPath = resolve(root, 'artifacts/m7/m7-offline-report.json')
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ reportPath, ...report }, null, 2))
if (!report.passed) process.exitCode = 1
