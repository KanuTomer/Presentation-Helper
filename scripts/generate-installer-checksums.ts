import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const installerPattern = /^PresenterAI-.+-setup\.exe$/i

export interface InstallerChecksumOptions {
  directory?: string
  output?: string
  packageJson?: string
}

export interface InstallerChecksumEntry {
  filename: string
  sha256: string
}

export async function generateInstallerChecksums(
  options: InstallerChecksumOptions = {}
): Promise<InstallerChecksumEntry[]> {
  const directory = resolve(options.directory ?? 'release')
  const output = resolve(options.output ?? resolve(directory, 'SHA256SUMS.txt'))
  const packageVersion = await readPackageVersion(resolve(options.packageJson ?? 'package.json'))
  const expectedFilename = `PresenterAI-${packageVersion}-setup.exe`
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && installerPattern.test(entry.name))
    .filter((entry) => entry.name.localeCompare(expectedFilename, 'en-US', { sensitivity: 'base' }) === 0)

  if (candidates.length !== 1 || candidates[0]?.name !== expectedFilename) {
    throw new Error(`Expected exactly one current PresenterAI installer: ${resolve(directory, expectedFilename)}.`)
  }

  const entries = [{
    filename: expectedFilename,
    sha256: await sha256(resolve(directory, expectedFilename))
  }]

  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    `${entries.map((entry) => `${entry.sha256}  ${entry.filename}`).join('\n')}\n`,
    'utf8'
  )
  return entries
}

async function readPackageVersion(path: string): Promise<string> {
  let packageJson: unknown
  try {
    packageJson = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`Package metadata could not be read from ${path}.`)
  }
  const version = packageJson && typeof packageJson === 'object' && 'version' in packageJson
    ? (packageJson as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`Package metadata contains an invalid version in ${path}.`)
  }
  return version
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolveHash)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const entries = await generateInstallerChecksums(options)
  process.stdout.write(`Wrote SHA256SUMS.txt for ${entries.length} PresenterAI installer(s).\n`)
}

function parseArguments(values: string[]): InstallerChecksumOptions {
  const options: InstallerChecksumOptions = {}
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]
    if (argument !== '--directory' && argument !== '--output' && argument !== '--package-json') {
      throw new Error(`Unknown checksum argument: ${argument}`)
    }
    const value = values[++index]
    if (!value) throw new Error(`${argument} requires a path.`)
    if (argument === '--directory') options.directory = value
    else if (argument === '--output') options.output = value
    else options.packageJson = value
  }
  return options
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
