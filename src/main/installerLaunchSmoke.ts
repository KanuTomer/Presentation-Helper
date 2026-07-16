import { writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

export const INSTALLER_LAUNCH_SMOKE_ARGUMENT = '--presenter-installer-launch-smoke='

export function installerLaunchSmokeOutputPath(argv: string[] = process.argv): string | undefined {
  const values = argv
    .filter((argument) => argument.startsWith(INSTALLER_LAUNCH_SMOKE_ARGUMENT))
    .map((argument) => argument.slice(INSTALLER_LAUNCH_SMOKE_ARGUMENT.length))
  return values.length === 1 && isValidOutputPath(values[0]) ? values[0] : undefined
}

export async function writeInstallerLaunchSmokeResult(outputPath: string): Promise<void> {
  if (!isValidOutputPath(outputPath)) throw new Error('The installer launch smoke output must be an absolute JSON path.')
  await writeFile(outputPath, JSON.stringify({
    ok: true,
    electron: process.versions.electron,
    initialized: true
  }), { encoding: 'utf8', flag: 'wx' })
}

function isValidOutputPath(value: string | undefined): value is string {
  return Boolean(value && isAbsolute(value) && extname(value).toLocaleLowerCase('en-US') === '.json')
}
