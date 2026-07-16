import { writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import type { DeleteAllLocalDataResult } from '../shared/contracts.js'

export const DELETE_ALL_SMOKE_ARGUMENT = '--presenter-delete-all-smoke='

function isValidOutputPath(value: string | undefined): value is string {
  return Boolean(value && isAbsolute(value) && extname(value).toLocaleLowerCase('en-US') === '.json')
}

export function deleteAllSmokeOutputPath(argv: string[] = process.argv): string | undefined {
  const values = argv
    .filter((argument) => argument.startsWith(DELETE_ALL_SMOKE_ARGUMENT))
    .map((argument) => argument.slice(DELETE_ALL_SMOKE_ARGUMENT.length))
  return values.length === 1 && isValidOutputPath(values[0]) ? values[0] : undefined
}

export function isControlledInstallerSmokeInvocation(
  userData: string | undefined,
  temporaryDirectory: string | undefined,
  outputPath: string | undefined
): boolean {
  if (!userData || !temporaryDirectory || !isValidOutputPath(outputPath)) return false
  const userDataPath = resolve(userData)
  const temporaryPath = resolve(temporaryDirectory)
  const scenarioDirectory = dirname(userDataPath)
  return basename(userDataPath).toLocaleLowerCase('en-US') === 'user-data' &&
    basename(temporaryPath).toLocaleLowerCase('en-US') === 'temporary' &&
    dirname(temporaryPath) === scenarioDirectory &&
    dirname(resolve(outputPath)) === scenarioDirectory &&
    basename(dirname(scenarioDirectory)).toLocaleLowerCase('en-US').startsWith('presenterai-installer-smoke-')
}

export async function runDeleteAllSmoke(
  outputPath: string,
  deleteAll: () => Promise<DeleteAllLocalDataResult>
): Promise<void> {
  if (!isValidOutputPath(outputPath)) throw new Error('The Delete All smoke output must be an absolute JSON path.')
  let outcome: DeleteAllLocalDataResult | undefined
  try {
    outcome = await deleteAll()
    await writeResult(outputPath, outcome)
    if (!outcome.ok) throw new Error('The packaged Delete All operation reported one or more failed scopes.')
  } catch (error) {
    if (!outcome) {
      await writeFile(outputPath, JSON.stringify({ ok: false, failedBeforeResult: true }), {
        encoding: 'utf8', flag: 'wx'
      }).catch(() => undefined)
    }
    throw error
  }
}

async function writeResult(outputPath: string, outcome: DeleteAllLocalDataResult): Promise<void> {
  await writeFile(outputPath, JSON.stringify({
    ok: outcome.ok,
    scopes: outcome.results.map(({ scope, ok }) => ({ scope, ok })),
    failedScopes: outcome.results.filter(({ ok }) => !ok).map(({ scope }) => scope)
  }), { encoding: 'utf8', flag: 'wx' })
}
