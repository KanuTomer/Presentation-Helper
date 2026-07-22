import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultHelper = join(root, 'resources', 'windows-helper', 'PresenterAI.WindowsHelper.exe')

export function classifySpawnError(code) {
  const normalized = String(code ?? '').toUpperCase()
  return ['UNKNOWN', 'EACCES', 'EPERM'].includes(normalized) ? 'blocked-by-policy-or-access' : 'launch-failed'
}

export function redactedSpawnOutcome(value) {
  return {
    state: value.state,
    ...(value.code ? { code: String(value.code).slice(0, 40) } : {}),
    ...(Number.isInteger(value.protocolVersion) ? { protocolVersion: value.protocolVersion } : {})
  }
}

function runPowerShell(script, environment = {}, timeout = 5_000) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, ...environment } })
  return result.status === 0 ? result.stdout.trim() : ''
}

function smartAppControlState() {
  if (process.platform !== 'win32') return 'unsupported-platform'
  const raw = runPowerShell(
    "$value=(Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState; if($null -eq $value){'unknown'}else{[string]$value}",
    {}
  )
  return ({ '0': 'off', '1': 'enforced', '2': 'evaluation' })[raw] ?? 'unknown'
}

function signatureState(helperPath) {
  if (process.platform !== 'win32' || !existsSync(helperPath)) return existsSync(helperPath) ? 'unsupported-platform' : 'missing'
  let hasCertificate
  try {
    const image = readFileSync(helperPath)
    if (image.length < 0x40 || image.toString('ascii', 0, 2) !== 'MZ') return 'unknown'
    const peOffset = image.readUInt32LE(0x3c)
    if (peOffset + 24 > image.length || image.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return 'unknown'
    const optionalOffset = peOffset + 24
    const optionalMagic = image.readUInt16LE(optionalOffset)
    const dataDirectoryOffset = optionalMagic === 0x10b
      ? optionalOffset + 96
      : optionalMagic === 0x20b
        ? optionalOffset + 112
        : 0
    if (!dataDirectoryOffset || dataDirectoryOffset + 40 > image.length) return 'unknown'
    const certificateOffset = image.readUInt32LE(dataDirectoryOffset + 32)
    const certificateSize = image.readUInt32LE(dataDirectoryOffset + 36)
    hasCertificate = certificateOffset > 0 && certificateSize > 0 && certificateOffset + certificateSize <= image.length
  } catch {
    return 'unknown'
  }
  if (!hasCertificate) return 'NotSigned'

  // App Control can prevent the child PowerShell inspection itself. The PE
  // certificate-directory result remains a read-only fallback in that case.
  const literalPath = helperPath.replaceAll("'", "''")
  return runPowerShell(
    `$signature=Get-AuthenticodeSignature -LiteralPath '${literalPath}'; [string]$signature.Status`,
    {},
    45_000
  ) || 'PresentUnverified'
}

function probeHelper(helperPath) {
  if (!existsSync(helperPath)) return Promise.resolve({ state: 'missing' })
  return new Promise((resolveProbe) => {
    let settled = false
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child && !child.killed) child.kill()
      resolveProbe(redactedSpawnOutcome(value))
    }
    const timer = setTimeout(() => finish({ state: 'timeout' }), 5_000)
    try {
      child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      finish({ state: classifySpawnError(error?.code), code: error?.code })
      return
    }
    child.once('error', (error) => finish({ state: classifySpawnError(error.code), code: error.code }))
    child.once('exit', (code) => { if (!settled) finish({ state: 'early-exit', code }) })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const event = JSON.parse(buffer.slice(0, newline))
        if (event.type === 'ready') {
          child.stdin.write(`${JSON.stringify({ type: 'shutdown', requestId: 'diagnostic-shutdown' })}\n`)
          finish({ state: 'ready', protocolVersion: Number(event.protocolVersion) })
        } else finish({ state: 'protocol-error' })
      } catch { finish({ state: 'protocol-error' }) }
    })
    child.stdin.write(`${JSON.stringify({ type: 'hello', requestId: 'diagnostic-hello', protocolVersion: 2 })}\n`)
  })
}

export async function collectCodeIntegrityEnvironment(helperPath = defaultHelper) {
  const expectedHelperPath = resolve(helperPath)
  return {
    platform: process.platform,
    smartAppControl: smartAppControlState(),
    expectedHelperPath,
    helperSignature: signatureState(expectedHelperPath),
    spawnOutcome: await probeHelper(expectedHelperPath)
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = resolve(fileURLToPath(import.meta.url))
if (invokedPath && invokedPath.toLocaleLowerCase('en-US') === modulePath.toLocaleLowerCase('en-US')) {
  const requestedPath = process.argv.find((argument) => argument.startsWith('--helper='))?.slice('--helper='.length)
  const report = await collectCodeIntegrityEnvironment(requestedPath || defaultHelper)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
