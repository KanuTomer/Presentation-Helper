import { runPackagedProbe, probeDiagnostics } from './packaged-probe-runner.mjs'

const { exitCode, stdout, stderr, report, source } = await runPackagedProbe('--presenter-helper-smoke=', 90_000)
if (exitCode !== 0) {
  throw new Error(`Packaged helper probe exited with code ${exitCode}.${report ? ` Report: ${JSON.stringify(report)}` : ''}${probeDiagnostics(stdout, stderr)}`)
}
if (!report) throw new Error(`Packaged helper probe did not write a report.${probeDiagnostics(stdout, stderr)}`)
const required = ['hook-ready', 'single-file-capture', 'bounded-capture', 'capture-limit-events', 'operation-ids']
if (report.ok !== true || report.state !== 'ready' || report.protocolVersion !== 2 || !required.every((feature) => report.features?.includes(feature))) {
  throw new Error(`Packaged helper probe returned an invalid result: ${JSON.stringify(report)}`)
}
process.stdout.write(`Packaged Electron ${report.electron} located protocol v${report.protocolVersion} helper with ${report.features.length} features (${source}).\n`)
