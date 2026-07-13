import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocumentChunk, DocumentChunkKind } from '../src/main/documents/types.js'
import { MAX_EVIDENCE_CHARACTERS, MAX_RETRIEVAL_RESULTS, RetrievalIndex } from '../src/main/retrieval/index.js'

const CORPUS_VERSION = 'm4-retrieval-v1'
const REQUIRED_CASES = 50
const REQUIRED_PASSES = 43
const EXPECTED_DISTRIBUTION = { pptx: 15, pdf: 15, markdown: 10, text: 10 } as const

type Format = keyof typeof EXPECTED_DISTRIBUTION
interface CorpusChunk {
  sourceKey: string
  kind: DocumentChunkKind
  pageOrSlide?: number
  section?: string
  title?: string
  text: string
}
interface CorpusDocument { format: Format; path: string; chunks: CorpusChunk[] }
interface CorpusCase { id: string; format: Format; question: string; expectedChunkIds: string[] }
interface Corpus { version: string; documents: CorpusDocument[]; cases: CorpusCase[] }

async function main(): Promise<void> {
  const root = process.cwd()
  const corpus = JSON.parse(await readFile(join(root, 'tests', 'fixtures', 'm4-retrieval-corpus.json'), 'utf8')) as Corpus
  validateCorpus(corpus)
  const scratch = await mkdtemp(join(tmpdir(), 'presenterai-m4-eval-'))
  const reportPath = join(root, 'artifacts', 'm4', 'm4-retrieval-report.json')
  const documentByPath = new Map(corpus.documents.map((document) => [document.path, document]))
  const ids = corpus.documents.map((document) => `doc-${document.format}`)
  let idIndex = 0
  const index = new RetrievalIndex({
    databasePath: join(scratch, 'retrieval.sqlite'),
    idGenerator: () => ids[idIndex++] ?? `unexpected-${idIndex}`,
    clock: () => new Date('2026-07-13T00:00:00.000Z'),
    canonicalizePath: (path) => path.toLocaleLowerCase(),
    readBytes: async (path) => new TextEncoder().encode(JSON.stringify(documentByPath.get(path)?.chunks ?? [])),
    parser: async (input) => {
      const document = documentByPath.get(input.path)
      if (!document) throw new Error('Unknown evaluation document.')
      return document.chunks.map((source): DocumentChunk => ({
        id: `${input.documentId}:${source.sourceKey}:part:1`, documentId: input.documentId,
        text: source.text, kind: source.kind, part: 1, partCount: 1,
        ...(source.pageOrSlide == null ? {} : { pageOrSlide: source.pageOrSlide }),
        ...(source.section == null ? {} : { section: source.section }),
        ...(source.title == null ? {} : { title: source.title })
      }))
    }
  })

  try {
    await index.initialize()
    const ingestion = await index.addFiles(corpus.documents.map((document) => document.path))
    if (ingestion.outcomes.some((outcome) => outcome.status !== 'added')) {
      throw new Error('Offline evaluation fixtures did not ingest cleanly.')
    }

    const formatStats = Object.fromEntries(Object.keys(EXPECTED_DISTRIBUTION).map((format) => [format, { total: 0, passed: 0 }])) as Record<Format, { total: number; passed: number }>
    const failedCaseIds: string[] = []
    const ranks: number[] = []
    for (const testCase of corpus.cases) {
      const results = index.search(testCase.question, MAX_RETRIEVAL_RESULTS)
      const rank = results.findIndex((chunk) => testCase.expectedChunkIds.includes(chunk.id))
      const passed = rank >= 0
      formatStats[testCase.format].total += 1
      if (passed) {
        formatStats[testCase.format].passed += 1
        ranks.push(rank + 1)
      } else failedCaseIds.push(testCase.id)
    }

    const passedCases = REQUIRED_CASES - failedCaseIds.length
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      corpusVersion: corpus.version,
      configuration: {
        retrieval: 'SQLite FTS5/BM25', topK: MAX_RETRIEVAL_RESULTS,
        evidenceCharacterBudget: MAX_EVIDENCE_CHARACTERS,
        embeddings: false, externalRequests: false
      },
      gates: {
        totalCases: REQUIRED_CASES, requiredPasses: REQUIRED_PASSES, passedCases,
        recallAtFive: passedCases / REQUIRED_CASES,
        passed: passedCases >= REQUIRED_PASSES
      },
      rankSummary: {
        topOne: ranks.filter((rank) => rank === 1).length,
        meanSuccessfulRank: ranks.length ? Number((ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length).toFixed(3)) : null
      },
      formats: formatStats,
      failedCaseIds
    }
    await mkdir(join(root, 'artifacts', 'm4'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`M4 offline retrieval: ${passedCases}/${REQUIRED_CASES} answer-bearing chunks found in the top five.`)
    console.log(`Redacted report: ${reportPath}`)
    if (!report.gates.passed) {
      console.error(`Recall gate failed. Failed case IDs: ${failedCaseIds.join(', ')}`)
      process.exitCode = 1
    }
  } finally {
    index.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

function validateCorpus(corpus: Corpus): void {
  if (corpus.version !== CORPUS_VERSION) throw new Error(`Expected corpus ${CORPUS_VERSION}.`)
  if (corpus.cases.length !== REQUIRED_CASES) throw new Error(`Expected exactly ${REQUIRED_CASES} retrieval cases.`)
  const caseIds = new Set<string>()
  const chunkIds = new Set<string>()
  const documentFormats = new Set<Format>()
  for (const document of corpus.documents) {
    if (documentFormats.has(document.format)) throw new Error(`Duplicate ${document.format} evaluation document.`)
    documentFormats.add(document.format)
    for (const source of document.chunks) chunkIds.add(`doc-${document.format}:${source.sourceKey}:part:1`)
  }
  for (const format of Object.keys(EXPECTED_DISTRIBUTION) as Format[]) {
    if (!documentFormats.has(format)) throw new Error(`Missing ${format} evaluation document.`)
    const count = corpus.cases.filter((testCase) => testCase.format === format).length
    if (count !== EXPECTED_DISTRIBUTION[format]) throw new Error(`Expected ${EXPECTED_DISTRIBUTION[format]} ${format} cases, received ${count}.`)
  }
  for (const testCase of corpus.cases) {
    if (!testCase.id || caseIds.has(testCase.id)) throw new Error(`Duplicate or empty case ID: ${testCase.id}`)
    caseIds.add(testCase.id)
    if (!testCase.question.trim() || testCase.expectedChunkIds.length === 0) throw new Error(`Incomplete case: ${testCase.id}`)
    if (testCase.expectedChunkIds.some((id) => !chunkIds.has(id))) throw new Error(`Case ${testCase.id} references an unknown chunk.`)
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'M4 offline evaluation failed.')
  process.exitCode = 1
})
