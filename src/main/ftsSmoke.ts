import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

export const FTS5_SMOKE_ARGUMENT = '--presenter-fts5-smoke='

function isValidOutputPath(value: string | undefined): value is string {
  return Boolean(value && isAbsolute(value) && extname(value).toLowerCase() === '.json')
}

export function fts5SmokeOutputPath(argv: string[] = process.argv): string | undefined {
  const value = argv.find((argument) => argument.startsWith(FTS5_SMOKE_ARGUMENT))?.slice(FTS5_SMOKE_ARGUMENT.length)
  return isValidOutputPath(value) ? value : undefined
}

export async function runFts5Smoke(outputPath: string): Promise<void> {
  if (!isValidOutputPath(outputPath)) throw new Error('The FTS5 smoke output must be an absolute JSON path.')
  const database = new DatabaseSync(':memory:')
  try {
    database.exec("CREATE VIRTUAL TABLE evidence USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')")
    database.prepare('INSERT INTO evidence(title, body) VALUES (?, ?)').run('PresenterAI retrieval', 'Packaged Electron exposes SQLite FTS5')
    const row = database.prepare("SELECT title FROM evidence WHERE evidence MATCH 'packaged AND electron AND fts5'").get() as { title?: string } | undefined
    if (row?.title !== 'PresenterAI retrieval') throw new Error('FTS5 query did not return the known fixture row.')
    await writeFile(outputPath, JSON.stringify({ ok: true, electron: process.versions.electron, sqlite: process.versions.sqlite ?? 'unknown' }), { encoding: 'utf8', flag: 'wx' })
  } finally { database.close() }
}
