import OpenAI from 'openai'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createInterface as createPrompt } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { AiService, asAiServiceError, type AiRequestMetric, type OpenAIClientLike, type TranscriptionMetric } from '../src/main/ai/service.js'
import {
  M6_ANSWER_MODEL, M6_EVALUATION_MAX_CAPTURE_SECONDS, M6_LIVE_BUDGET_USD, M6_TRANSCRIPTION_MODEL, M6BudgetLedger,
  actualAnswerCostUsd, answerMaximumCostUsd, answerMaximumRequestCostUsd, appendM6Result, assertRedactedM6Report,
  buildReferenceDocument, documentedMaximumM6CampaignCostUsd, evaluateM6AggregateGate, maximumM6CampaignCostUsd, meaningLooksCorrect, m6CorpusFingerprint,
  newM6Report, parseM6Corpus, transcriptionMaximumCostUsd, transcriptionTokenCostUsd,
  validateM6ResumeReport, type M6CaseResult, type M6CorpusCase, type M6RedactedReport
} from '../src/main/ai/m6Eval.js'
import { RetrievalIndex } from '../src/main/retrieval/index.js'
import { validatePresenterWav } from '../src/main/audio/wavValidation.js'
import type { AppSettings, DocumentInfo } from '../src/shared/contracts.js'
import type { TranscriptionUsage } from '../src/main/ai/transcription.js'
import { USAGE_PRICING_VERSION } from '../src/main/ai/pricing.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const corpusPath = join(root, 'tests', 'fixtures', 'm6-live-corpus.json')
const reportPath = join(root, 'artifacts', 'm6', 'live-report.json')
const helperPath = join(root, 'resources', 'windows-helper', 'PresenterAI.WindowsHelper.exe')

async function main(): Promise<void> {
const rawArgs = process.argv.slice(2)
const args = new Set(rawArgs)
const preflight = args.has('--preflight')
const live = args.has('--live')
const resume = args.has('--resume')

const allowed = (arg: string): boolean => ['--preflight', '--live', '--resume'].includes(arg)
if ([preflight, live].filter(Boolean).length !== 1 || (resume && !live) || rawArgs.some((arg) => !allowed(arg))) {
  throw new Error('Use --preflight or --live [--resume]. Renderer-visible latency is recorded only by the production app campaign.')
}

const corpus = parseM6Corpus(JSON.parse(await readFile(corpusPath, 'utf8')))
const preflightMaximum = maximumM6CampaignCostUsd(corpus)
const documentedMaximum = documentedMaximumM6CampaignCostUsd(corpus)
if (preflightMaximum > M6_LIVE_BUDGET_USD) throw new Error('The M6 maximum projection exceeds its immutable budget.')

if (preflight) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    networkRequests: 0,
    corpusSize: corpus.length,
    fullPipelineSize: corpus.filter((item) => item.fullPipeline).length,
    corpusFingerprint: m6CorpusFingerprint(corpus),
    projectedMaximumUsd: Number(preflightMaximum.toFixed(6)),
    documentedWorstCaseUsd: Number(documentedMaximum.toFixed(6)),
    strictCampaignFeasible: documentedMaximum <= M6_LIVE_BUDGET_USD,
    billableExecutionEnabled: false,
    capUsd: M6_LIVE_BUDGET_USD,
    models: { transcription: M6_TRANSCRIPTION_MODEL, answer: M6_ANSWER_MODEL }
  }, null, 2)}\n`)
  process.exit(0)
}

if (documentedMaximum > M6_LIVE_BUDGET_USD) {
  throw new Error(`M6 live execution is safety-blocked: the transcription endpoint has no output-token cap, and its documented model limits project $${documentedMaximum.toFixed(6)} against the strict $${M6_LIVE_BUDGET_USD.toFixed(2)} ceiling. Revise the case count or authorize a higher cap before any API request.`)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Live M6 validation requires an interactive terminal so transcripts can be reviewed transiently without being written to a report.')
}
if (!existsSync(helperPath)) throw new Error('The Windows helper is missing. Run npm run helper:build first.')

const apiKey = process.env.OPENAI_API_KEY?.trim()
if (!apiKey) throw new Error('OPENAI_API_KEY is required only for --live mode.')
const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 })
delete process.env.OPENAI_API_KEY

let report = await loadOrCreateReport(corpus, resume)
if (report.failedIds.length) throw new Error('The saved campaign contains a failed case. Automatic reruns are forbidden; M6 remains blocked for review.')
const ledger = new M6BudgetLedger(report.budget.actualUsd)
const completed = new Set(report.results.map((item) => item.id))
const pending = corpus.filter((item) => !completed.has(item.id))
if (pending.length === 0) {
  report.aggregateGate = evaluateM6AggregateGate(report)
  await writeReport(report)
  process.stdout.write('All M6 cases are already recorded. The aggregate gate was recomputed; no API request was made.\n')
  if (!report.aggregateGate.accepted) throw new Error('M6 strict aggregate acceptance remains blocked; no case was rerun.')
  process.exit(0)
}

const workDir = join(tmpdir(), `presenterai-m6-${randomUUID()}`)
const audioDir = join(workDir, 'audio')
const referencePath = join(workDir, 'm6-reference.txt')
const databasePath = join(workDir, 'm6.sqlite')
await mkdir(audioDir, { recursive: true })
await writeFile(referencePath, buildReferenceDocument(corpus), 'utf8')

const retrieval = new RetrievalIndex({ databasePath })
const helper = new ProtocolV2Helper(helperPath)
const prompt = createPrompt({ input: process.stdin, output: process.stdout })
let documents: DocumentInfo[] = []
let transcriptionMetric: TranscriptionMetric | undefined
let answerMetric: AiRequestMetric | undefined
const settings: {
  settings: AppSettings
  documents: DocumentInfo[]
  addUsage(input: number, output: number, audio?: number): Promise<void>
  addTranscriptionUsage(usage: TranscriptionUsage, model: string): Promise<void>
} = {
  settings: {
    opacity: 0.92, clickThrough: false, modelMode: 'normal', normalModel: M6_ANSWER_MODEL,
    strongModel: 'gpt-5.6-terra', transcriptionModel: M6_TRANSCRIPTION_MODEL,
    askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
    projectSummary: '', approvedVocabulary: ['OpenTelemetry', 'PostgreSQL', 'rendezvous hashing']
  },
  documents,
  async addUsage() {},
  async addTranscriptionUsage() {}
}
const ai = new AiService({ getKey: async () => { throw new Error('The injected no-retry client must be used.') } }, settings, retrieval, {
  clientFactory: async () => client as unknown as OpenAIClientLike,
  onTranscriptionMetric: (metric) => { transcriptionMetric = metric },
  onMetric: (metric) => { answerMetric = metric }
})

let activeOperation: string | undefined
let activeAbort: AbortController | undefined
let interrupted = false
process.once('SIGINT', () => {
  interrupted = true
  activeAbort?.abort()
  if (activeOperation) void helper.cancel(activeOperation)
  prompt.close()
})

try {
  await retrieval.initialize()
  const imported = await retrieval.addFiles([referencePath])
  if (imported.outcomes[0]?.status !== 'added') throw new Error('The synthetic M6 reference document could not be indexed.')
  documents = retrieval.listDocuments()
  settings.documents = documents
  await helper.start()
  await helper.command('configureShortcut', { accelerator: 'Control+Shift+Space' }, ['shortcutConfigured'])

  process.stdout.write(`M6 live campaign: ${pending.length} unattempted cases, $${ledger.spentUsd.toFixed(6)} lifetime spend.\n`)
  if (report.results.length === 0) process.stdout.write('m6-01 is the billable preflight. The campaign stops if it fails.\n')

  for (const [pendingIndex, testCase] of pending.entries()) {
    if (interrupted) throw new Error('cancelled')
    const caseStartedAt = performance.now()
    const result = emptyResult(testCase)
    let wavPath: string | undefined
    let caseCost = 0
    let transcriptionCostAccounted = false
    let answerCostAccounted = false
    let transcriptionReserve = 0
    let answerReserve = 0
    let recoveredBudgetError: unknown
    const operationAbort = new AbortController()
    activeAbort = operationAbort
    transcriptionMetric = undefined
    answerMetric = undefined
    try {
      process.stdout.write(`\n${testCase.id}: press Control+Shift+Space once, ask the reviewer to say this sentence, then press it again:\n${testCase.expectedQuestion}\n`)
      const operationId = randomUUID()
      activeOperation = operationId
      const capture = await helper.capture(operationId, join(audioDir, `${testCase.id}.wav`), operationAbort.signal)
      activeOperation = undefined
      wavPath = capture.path
      result.timingsMs.capture = capture.durationMs
      result.timingsMs.finalization = capture.finalizationMs
      const validatedWav = await validatePresenterWav(wavPath, audioDir, {
        bytes: capture.bytes, durationMs: capture.durationMs,
        sampleRate: capture.sampleRate, channels: capture.channels
      })
      if (validatedWav.durationMs > M6_EVALUATION_MAX_CAPTURE_SECONDS * 1_000) {
        throw codedError('evaluation_clip_too_long')
      }
      result.flags.audioValid = Boolean(capture.endpointId && capture.endpointName)
      if (!result.flags.audioValid) throw codedError('invalid_audio')

      transcriptionReserve = transcriptionMaximumCostUsd(validatedWav.durationMs / 1_000)
      ledger.assertReserve(remainingMaximum(corpus, pending, pendingIndex, validatedWav.durationMs / 1_000))
      let transcription
      try {
        transcription = await ai.transcribe({ bytes: validatedWav.bytes, filename: 'reviewer.wav' }, { signal: operationAbort.signal })
      } finally {
        await unlink(wavPath).catch(() => undefined)
        result.flags.wavDeleted = !(await pathExists(wavPath))
        if (result.flags.wavDeleted) wavPath = undefined
      }
      if (!result.flags.wavDeleted) throw codedError('audio_cleanup_failed')
      result.timingsMs.transcription = transcription.latencyMs
      result.flags.transcriptionValid = true
      if (transcription.model) result.versions.returnedTranscriptionModel = transcription.model
      if (transcription.usage.type !== 'tokens') throw codedError('missing_token_usage')
      result.usage.transcriptionInputTokens = transcription.usage.inputTokens
      result.usage.transcriptionAudioTokens = transcription.usage.audioTokens
      result.usage.transcriptionOutputTokens = transcription.usage.outputTokens
      const transcriptionCost = transcriptionTokenCostUsd(transcription.usage.inputTokens, transcription.usage.outputTokens)
      caseCost += transcriptionCost
      transcriptionCostAccounted = true
      ledger.recordActual(transcriptionCost)

      const automatedMeaning = meaningLooksCorrect(transcription.text, testCase.expectedQuestion, testCase.meaningAnchors)
      if (testCase.fullPipeline) {
        ai.clearSession()
        const retrieveStarted = performance.now()
        const chunks = ai.retrieve(transcription.text, { signal: operationAbort.signal })
        result.timingsMs.retrieval = performance.now() - retrieveStarted
        if (chunks.length === 0) throw codedError('retrieval_miss')
        answerReserve = answerMaximumRequestCostUsd(transcription.text, chunks)
        ledger.assertReserve(answerReserve + remainingMaximum(corpus, pending, pendingIndex + 1))
        const generationStarted = performance.now()
        const answer = await ai.generate(transcription.text, chunks, { signal: operationAbort.signal })
        result.timingsMs.generation = performance.now() - generationStarted
        result.flags.pipelineValid = true
        result.flags.evidenceValid = answer.evidence.length > 0 && answer.evidence.every((item) => chunks.some((chunk) => chunk.id === item.chunkId))
        if (!result.flags.evidenceValid) throw codedError('invalid_evidence')
        const generatedMetric = answerMetric as AiRequestMetric | undefined
        if (!generatedMetric?.usagePresent) throw codedError('missing_answer_usage')
        result.versions.returnedAnswerModel = generatedMetric.returnedModel ?? M6_ANSWER_MODEL
        result.usage.answerInputTokens = generatedMetric.inputTokens
        result.usage.answerOutputTokens = generatedMetric.outputTokens
        result.usage.answerReasoningTokens = generatedMetric.reasoningTokens
        const answerCost = actualAnswerCostUsd(generatedMetric.inputTokens, generatedMetric.outputTokens)
        caseCost += answerCost
        answerCostAccounted = true
        ledger.recordActual(answerCost)
      }
      result.timingsMs.total = performance.now() - capture.stoppedAt
      process.stdout.write(`Transient transcript (not saved): ${transcription.text}\nAutomated meaning check: ${automatedMeaning ? 'PASS' : 'REVIEW'}\n`)
      result.flags.meaningCorrect = await askYes(prompt, 'Does the transcript preserve the intended question meaning? [y/N] ')
      result.passed = result.flags.audioValid && result.flags.transcriptionValid && result.flags.wavDeleted &&
        result.flags.pipelineValid && result.flags.evidenceValid
      const meaningMisses = report.results.filter((item) => !item.flags.meaningCorrect).length + (result.flags.meaningCorrect ? 0 : 1)
      const slowFullCases = report.results.filter((item) => item.fullPipeline && item.timingsMs.total > 5_000).length +
        (result.fullPipeline && result.timingsMs.total > 5_000 ? 1 : 0)
      if (meaningMisses > 2) {
        result.passed = false
        result.errorCode = 'meaning_gate_failed'
      } else if (result.fullPipeline && (result.timingsMs.total > 8_000 || slowFullCases > 5)) {
        result.passed = false
        result.errorCode = 'latency_gate_failed'
      }
    } catch (error) {
      const failedTranscriptionMetric = transcriptionMetric as TranscriptionMetric | undefined
      const failedAnswerMetric = answerMetric as AiRequestMetric | undefined
      if (failedTranscriptionMetric?.usage.type === 'tokens' && !transcriptionCostAccounted) {
        const cost = transcriptionTokenCostUsd(failedTranscriptionMetric.usage.inputTokens, failedTranscriptionMetric.usage.outputTokens)
        result.usage.transcriptionInputTokens = failedTranscriptionMetric.usage.inputTokens
        result.usage.transcriptionAudioTokens = failedTranscriptionMetric.usage.audioTokens
        result.usage.transcriptionOutputTokens = failedTranscriptionMetric.usage.outputTokens
        caseCost += cost; transcriptionCostAccounted = true
        try { ledger.recordActual(cost) } catch (budgetError) { recoveredBudgetError ??= budgetError }
      } else if (failedTranscriptionMetric?.requestDispatched && failedTranscriptionMetric.usage.type !== 'tokens' &&
          !transcriptionCostAccounted && transcriptionReserve > 0) {
        result.usage.unreportedUsageReserveUsd += transcriptionReserve
        caseCost += transcriptionReserve; transcriptionCostAccounted = true
        try { ledger.recordActual(transcriptionReserve) } catch (budgetError) { recoveredBudgetError ??= budgetError }
      }
      if (failedAnswerMetric?.usagePresent && !answerCostAccounted) {
        const cost = actualAnswerCostUsd(failedAnswerMetric.inputTokens, failedAnswerMetric.outputTokens)
        result.usage.answerInputTokens = failedAnswerMetric.inputTokens
        result.usage.answerOutputTokens = failedAnswerMetric.outputTokens
        result.usage.answerReasoningTokens = failedAnswerMetric.reasoningTokens
        caseCost += cost; answerCostAccounted = true
        try { ledger.recordActual(cost) } catch (budgetError) { recoveredBudgetError ??= budgetError }
      } else if (failedAnswerMetric?.requestDispatched && !failedAnswerMetric.usagePresent &&
          !answerCostAccounted && answerReserve > 0) {
        result.usage.unreportedUsageReserveUsd += answerReserve
        caseCost += answerReserve; answerCostAccounted = true
        try { ledger.recordActual(answerReserve) } catch (budgetError) { recoveredBudgetError ??= budgetError }
      }
      if (wavPath) {
        await unlink(wavPath).catch(() => undefined)
        result.flags.wavDeleted = !(await pathExists(wavPath))
      }
      result.timingsMs.total = performance.now() - caseStartedAt
      result.errorCode = safeErrorCode(recoveredBudgetError ?? error)
      result.passed = false
    }
    result.estimatedCostUsd = caseCost
    activeAbort = undefined
    activeOperation = undefined
    report = appendM6Result(report, result)
    report.budget.actualUsd = ledger.spentUsd
    await writeReport(report)
    process.stdout.write(`${testCase.id}: ${result.passed ? 'PASS' : `FAIL (${result.errorCode})`}; lifetime $${ledger.spentUsd.toFixed(6)}\n`)
    if (!result.passed) throw new Error(`M6 stopped after ${testCase.id}; no case was retried.`)
  }

  report.aggregateGate = evaluateM6AggregateGate(report)
  await writeReport(report)
  const gate = report.aggregateGate
  process.stdout.write(`\nCampaign complete. Transcription ${gate.transcriptionValidCount}/20; meaning ${gate.meaningCorrectCount}/20; pipeline ${gate.fullPipelineValidCount}/10; renderer-confirmed stop-to-visible p50 ${gate.stopToAnswerP50Ms.toFixed(0)} ms; p95 ${gate.stopToAnswerP95Ms.toFixed(0)} ms; cost $${ledger.spentUsd.toFixed(6)}.\n`)
  if (!gate.flags.latency) process.stdout.write('Visible-latency acceptance remains manual: import ten operation-scoped renderer acknowledgements before M6 sign-off.\n')
  if (!gate.accepted) throw new Error('M6 strict aggregate acceptance failed. The redacted report records the blocking gate flags; no case was rerun.')
} finally {
  activeOperation = undefined
  activeAbort?.abort()
  activeAbort = undefined
  await helper.stop().catch(() => undefined)
  prompt.close()
  retrieval.close()
  await rm(workDir, { recursive: true, force: true })
}
}

interface ProtocolMessage {
  type: string
  requestId?: string
  operationId?: string
  code?: string
  message?: string
  protocolVersion?: number
  shortcutReady?: boolean
  features?: string[]
  path?: string
  durationMs?: number
  bytes?: number
  sampleRate?: number
  channels?: number
  endpointId?: string
  endpointName?: string
}

interface CaptureResult {
  path: string
  durationMs: number
  bytes: number
  sampleRate: number
  channels: number
  endpointId: string
  endpointName: string
  finalizationMs: number
  stoppedAt: number
}

class ProtocolV2Helper {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, { terminal: Set<string>; resolve(value: ProtocolMessage): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private events = new Map<string, Array<{ resolve(value: ProtocolMessage): void; reject(error: Error): void }>>()
  private stderr = ''
  constructor(private readonly executable: string) {}

  async start(): Promise<void> {
    this.child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-2_000) })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    this.child.once('exit', () => this.rejectAll(codedError('helper_unavailable')))
    this.child.once('error', () => this.rejectAll(codedError('helper_unavailable')))
    const hello = await this.command('hello', { protocolVersion: 2 }, ['ready'], 60_000)
    const required = ['wasapi-system-loopback', 'device-selection', 'hold-shortcut', 'pcm16k-mono', 'hook-ready', 'single-file-capture', 'bounded-capture', 'capture-limit-events', 'operation-ids']
    if (hello.protocolVersion !== 2 || hello.shortcutReady !== true || required.some((feature) => !hello.features?.includes(feature))) {
      throw codedError('helper_unavailable')
    }
  }

  async capture(operationId: string, path: string, signal: AbortSignal): Promise<CaptureResult> {
    process.stdout.write('Waiting for the first listening-toggle press...\n')
    const firstDown = this.waitEvent('shortcutDown', 300_000, signal)
    let secondDown: ReturnType<ProtocolV2Helper['waitEvent']> | undefined
    try {
      await firstDown.promise
      if (signal.aborted) throw codedError('cancelled')
      // Install the second-down waiter before helper startup finishes so a
      // rapid stop press is latched. Key-up remains a native rearm/autorepeat
      // event and deliberately has no evaluator action.
      secondDown = this.waitEvent('shortcutDown', 390_000, signal)
      const started = await this.command('startCapture', { operationId, path }, ['captureStarted'], 10_000)
      if (started.operationId !== operationId) throw codedError('stale_helper_reply')
      process.stdout.write('LISTENING — press the listening toggle again when the reviewer finishes.\n')
      await secondDown.promise
      const stoppedAt = performance.now()
      const stopped = await this.command('stopCapture', { operationId, terminalReason: 'stopped' }, ['captureStopped'], 20_000)
      const finalizationMs = performance.now() - stoppedAt
      if (stopped.operationId !== operationId) throw codedError('stale_helper_reply')
      return {
        path: String(stopped.path ?? ''), durationMs: Number(stopped.durationMs ?? 0), bytes: Number(stopped.bytes ?? 0),
        sampleRate: Number(stopped.sampleRate ?? 0), channels: Number(stopped.channels ?? 0),
        endpointId: String(stopped.endpointId ?? ''), endpointName: String(stopped.endpointName ?? ''),
        finalizationMs, stoppedAt
      }
    } finally {
      firstDown.dispose()
      secondDown?.dispose()
    }
  }

  async cancel(operationId: string): Promise<void> {
    await this.command('cancel', { operationId }, ['captureCancelled'], 5_000).catch(() => undefined)
  }

  async stop(): Promise<void> {
    if (!this.child) return
    await this.command('shutdown', {}, ['shutdownComplete'], 2_000).catch(() => undefined)
    this.child.kill()
    this.child = undefined
  }

  command(type: string, payload: Record<string, unknown>, terminal: string[], timeoutMs = 15_000): Promise<ProtocolMessage> {
    if (!this.child?.stdin.writable) return Promise.reject(codedError('helper_unavailable'))
    const requestId = randomUUID()
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        rejectPromise(codedError('capture_timeout'))
      }, timeoutMs)
      this.pending.set(requestId, { terminal: new Set(terminal), resolve: resolvePromise, reject: rejectPromise, timer })
      this.child!.stdin.write(`${JSON.stringify({ type, requestId, ...payload })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(requestId); rejectPromise(codedError('helper_unavailable'))
      })
    })
  }

  private waitEvent(type: string, timeoutMs: number, signal: AbortSignal): { promise: Promise<ProtocolMessage>; dispose(): void } {
    let cancel = (): void => undefined
    const promise = new Promise<ProtocolMessage>((resolvePromise, rejectPromise) => {
      let settled = false
      const waiter = {
        resolve: (value: ProtocolMessage): void => finish(undefined, value),
        reject: (error: Error): void => finish(error)
      }
      const remove = (): void => {
        const current = this.events.get(type) ?? []
        const remaining = current.filter((listener) => listener !== waiter)
        if (remaining.length) this.events.set(type, remaining); else this.events.delete(type)
        signal.removeEventListener('abort', abort)
      }
      const finish = (error?: Error, value?: ProtocolMessage): void => {
        if (settled) return
        settled = true; clearTimeout(timer); remove()
        if (error) rejectPromise(error); else resolvePromise(value!)
      }
      const timer = setTimeout(() => finish(codedError('capture_timeout')), timeoutMs)
      const abort = (): void => finish(codedError('cancelled'))
      this.events.set(type, [...(this.events.get(type) ?? []), waiter])
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      cancel = () => finish(codedError('cancelled'))
    })
    return {
      promise,
      dispose: () => {
        // Mark a deliberate rejection handled even when the caller never
        // reached the corresponding await (for example Down timed out first).
        void promise.catch(() => undefined)
        cancel()
      }
    }
  }

  private onLine(line: string): void {
    let message: ProtocolMessage
    try { message = JSON.parse(line) as ProtocolMessage }
    catch { this.rejectAll(codedError('helper_unavailable')); return }
    if (!message || typeof message.type !== 'string') { this.rejectAll(codedError('helper_unavailable')); return }
    if (message.requestId) {
      const waiter = this.pending.get(message.requestId)
      if (waiter && (waiter.terminal.has(message.type) || message.type === 'error')) {
        clearTimeout(waiter.timer); this.pending.delete(message.requestId)
        if (message.type === 'error') waiter.reject(codedError(message.code ?? 'helper_error'))
        else waiter.resolve(message)
      }
    }
    const listeners = this.events.get(message.type)
    const listener = listeners?.shift()
    if (listeners?.length === 0) this.events.delete(message.type)
    listener?.resolve(message)
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.pending.clear()
    const eventWaiters = [...this.events.values()].flat()
    this.events.clear()
    for (const waiter of eventWaiters) waiter.reject(error)
  }
}

function emptyResult(testCase: M6CorpusCase): M6CaseResult {
  return {
    id: testCase.id, fullPipeline: testCase.fullPipeline, passed: false,
    flags: { audioValid: false, transcriptionValid: false, meaningCorrect: false, wavDeleted: false, pipelineValid: !testCase.fullPipeline, evidenceValid: !testCase.fullPipeline },
    versions: {
      helperProtocol: 2, requestedTranscriptionModel: M6_TRANSCRIPTION_MODEL,
      ...(testCase.fullPipeline ? { requestedAnswerModel: M6_ANSWER_MODEL } : {}),
      pricing: USAGE_PRICING_VERSION
    },
    timingsMs: { capture: 0, finalization: 0, transcription: 0, total: 0 },
    usage: {
      transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0,
      answerInputTokens: 0, answerOutputTokens: 0, answerReasoningTokens: 0,
      unreportedUsageReserveUsd: 0
    },
    estimatedCostUsd: 0
  }
}

function remainingMaximum(corpus: readonly M6CorpusCase[], pending: readonly M6CorpusCase[], pendingIndex: number, currentDurationSeconds?: number): number {
  return pending.slice(pendingIndex).reduce((total, item, index) => total +
    transcriptionMaximumCostUsd(index === 0 && currentDurationSeconds !== undefined ? currentDurationSeconds : undefined) +
    (item.fullPipeline ? answerMaximumCostUsd(corpus, item) : 0), 0)
}

async function loadOrCreateReport(cases: readonly M6CorpusCase[], resumeExisting: boolean): Promise<M6RedactedReport> {
  if (!(await pathExists(reportPath))) return newM6Report(cases)
  if (!resumeExisting) throw new Error('An M6 report already exists. Use --resume to continue only unattempted cases; completed or failed cases are never rerun.')
  return validateM6ResumeReport(JSON.parse(await readFile(reportPath, 'utf8')), cases)
}

async function writeReport(value: M6RedactedReport): Promise<void> {
  assertRedactedM6Report(value)
  await mkdir(dirname(reportPath), { recursive: true })
  const temporary = `${reportPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, reportPath)
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function askYes(prompt: ReturnType<typeof createPrompt>, message: string): Promise<boolean> {
  return (await prompt.question(message)).trim().toLocaleLowerCase() === 'y'
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code).slice(0, 80)
  }
  return asAiServiceError(error).code
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

await main()
