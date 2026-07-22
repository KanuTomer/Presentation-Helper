import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const minimumExpectedTests = 29

export function parseHelperTestSummary(output) {
  const matches = [...String(output).matchAll(/Failed:\s*(\d+)\s*,\s*Passed:\s*(\d+)\s*,\s*Skipped:\s*(\d+)\s*,\s*Total:\s*(\d+)/giu)]
  const match = matches.at(-1)
  if (!match) return undefined
  return {
    failed: Number(match[1]),
    passed: Number(match[2]),
    skipped: Number(match[3]),
    total: Number(match[4])
  }
}

export function helperTestFailure(output, exitCode, minimum = minimumExpectedTests) {
  if (/Application Control policy has blocked|0x800711C7/iu.test(output)) {
    return 'blocked-by-smart-app-control: Windows App Control prevented the helper test assembly from loading.'
  }
  if (exitCode !== 0) return `The .NET helper test process exited with code ${exitCode}.`
  const summary = parseHelperTestSummary(output)
  if (!summary) return 'The .NET helper runner reported no test summary; zero discovered tests is a failure.'
  if (summary.failed > 0 || summary.passed < minimum || summary.total < minimum || summary.failed + summary.passed + summary.skipped !== summary.total) {
    return `The .NET helper gate requires at least ${minimum} passing tests and no failures; received ${JSON.stringify(summary)}.`
  }
  return undefined
}

async function run() {
  const args = [
    'test', 'native/PresenterAI.WindowsHelper.Tests/PresenterAI.WindowsHelper.Tests.csproj',
    '-c', 'Release'
  ]
  const child = spawn('dotnet', args, { cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text) })
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text) })
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  const failure = helperTestFailure(output, exitCode)
  if (failure) throw new Error(failure)
  process.stdout.write(`Verified at least ${minimumExpectedTests} passing .NET helper tests.\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && invokedPath.toLocaleLowerCase('en-US') === resolve(fileURLToPath(import.meta.url)).toLocaleLowerCase('en-US')) {
  await run()
}
