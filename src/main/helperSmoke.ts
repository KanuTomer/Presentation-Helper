import { writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { HelperClient, HELPER_PROTOCOL_VERSION } from './audio/helperClient.js'

export const HELPER_SMOKE_ARGUMENT = '--presenter-helper-smoke='

export function helperSmokeOutputPath(argv: string[] = process.argv): string | undefined {
  const value = argv.find((argument) => argument.startsWith(HELPER_SMOKE_ARGUMENT))?.slice(HELPER_SMOKE_ARGUMENT.length)
  return value && isAbsolute(value) && extname(value).toLowerCase() === '.json' ? value : undefined
}

export async function runHelperSmoke(outputPath: string): Promise<void> {
  if (!isAbsolute(outputPath) || extname(outputPath).toLowerCase() !== '.json') throw new Error('The helper smoke output must be an absolute JSON path.')
  const helper = new HelperClient()
  try {
    if (!await helper.start() || helper.state !== 'ready') throw new Error(helper.lastError ?? 'Packaged helper did not become ready.')
    await writeFile(outputPath, JSON.stringify({
      ok: true, protocolVersion: HELPER_PROTOCOL_VERSION, state: helper.state, features: helper.features,
      electron: process.versions.electron
    }), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await writeFile(outputPath, JSON.stringify({
      ok: false,
      protocolVersion: HELPER_PROTOCOL_VERSION,
      state: helper.state,
      features: helper.features,
      electron: process.versions.electron,
      error: error instanceof Error ? error.message.slice(0, 600) : 'Packaged helper health check failed.'
    }), { encoding: 'utf8', flag: 'wx' }).catch(() => undefined)
    throw error
  } finally { await helper.stopProcess() }
}
