import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore, SNAPSHOT_EXPIRY_MS, SNAPSHOT_MAX_BYTES } from '../src/main/snapshots/store'
import { AiService, type AiSettingsProvider, type OpenAIClientLike } from '../src/main/ai/service'
import { solutionResponseSchema } from '../src/shared/contracts'
import { snapshotResponseJsonSchema, SNAPSHOT_QUESTION } from '../src/main/ai/snapshotPrompt'
import { MODEL_REGISTRY } from '../src/shared/models'

afterEach(() => vi.useRealTimers())
function frames() {
  const bytes = Buffer.from('synthetic-screen')
  const capture = vi.fn(async () => ({ bytes: Buffer.from(bytes), width: 1920, height: 1080, mime: 'image/png' as const }))
  const store = new SnapshotStore({ monitors: () => [{ id: '1', name: 'One', current: false, width: 1920, height: 1080 }, { id: '2', name: 'Two', current: true, width: 1920, height: 1080 }], capture })
  return { store, capture }
}
const solution = { task: 'math', interpretedProblem: 'Solve x² = 4.', explanation: 'Take both square roots.', equations: ['x^2=4', 'x=\\pm2'], steps: ['Take the square root of both sides.'], finalResult: 'x = ±2', codeBlocks: [], clarification: '', support: 'general-technical', evidenceIssue: 'none', warning: null, evidence: [] }
describe('memory-only screen snapshots', () => {
  it('selects the overlay monitor by default and permits explicit selection', async () => {
    const h = frames(); const signal = new AbortController().signal
    const first = await h.store.capture(undefined, signal); expect(first.monitorId).toBe('2')
    const second = await h.store.capture('1', signal); expect(second.id).not.toBe(first.id)
    expect(() => h.store.get(first.id)).toThrow(/expired/); expect(h.store.get(second.id).id).toBe(second.id); h.store.clear()
  })
  it('clears images on discard, cancellation and expiration', async () => {
    vi.useFakeTimers(); const h = frames(); const signal = new AbortController().signal
    const first = await h.store.capture(undefined, signal); h.store.clear(); expect(() => h.store.get(first.id)).toThrow()
    const second = await h.store.capture(undefined, signal); vi.advanceTimersByTime(SNAPSHOT_EXPIRY_MS); expect(() => h.store.get(second.id)).toThrow()
    const aborted = new AbortController(); aborted.abort(); await expect(h.store.capture(undefined, aborted.signal)).rejects.toThrow()
  })
  it('rejects disconnected displays and oversized images', async () => {
    const h = frames(); await expect(h.store.capture('missing', new AbortController().signal)).rejects.toThrow(/unavailable/)
    h.capture.mockResolvedValueOnce({ bytes: Buffer.alloc(SNAPSHOT_MAX_BYTES + 1), width: 1920, height: 1080, mime: 'image/png' })
    await expect(h.store.capture(undefined, new AbortController().signal)).rejects.toThrow(/8 MiB/)
  })
  it.each(['formula', 'subscript', 'matrix', 'code', 'compiler-error', 'ambiguous', 'unreadable'])('validates synthetic %s response fixtures', (kind) => {
    const value = kind === 'code' || kind === 'compiler-error'
      ? { ...solution, task: 'code', codeBlocks: [{ language: 'tsx', title: 'answer.tsx', code: 'const result = 2;\n' }] }
      : kind === 'ambiguous' || kind === 'unreadable'
        ? { ...solution, task: 'clarification', steps: [], finalResult: '', clarification: 'Which of the two visible problems should I solve?' }
        : { ...solution, equations: [kind === 'matrix' ? '\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}' : kind === 'subscript' ? 'a_{n+1}=2a_n' : 'x^2=4'] }
    const local = { ...value, warning: undefined }; expect(solutionResponseSchema.safeParse(local).success).toBe(true)
  })
  it('requires clarification and valid math steps, and keeps strict provider fields required', () => {
    expect(solutionResponseSchema.safeParse({ ...solution, warning: undefined, steps: [] }).success).toBe(false)
    expect(snapshotResponseJsonSchema.required).toContain('warning')
  })
})
describe('screenshot Responses requests', () => {
  function harness(output = solution) {
    const create = vi.fn(async () => ({ output_text: JSON.stringify(output), model: 'gpt-6-luna', usage: { input_tokens: 50, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } } }))
    const settings: AiSettingsProvider = { settings: { neonIntensity: .65, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-6-luna', strongModel: 'gpt-6.1-sol', transcriptionModel: 'gpt-4o-mini-transcribe', askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space', projectSummary: 'Reference context', approvedVocabulary: [] }, documents: [], addUsage: vi.fn(async () => undefined), addTranscriptionUsage: vi.fn(async () => undefined), recordUsage: vi.fn(async () => undefined) }
    const client: OpenAIClientLike = { models: { list: vi.fn() }, responses: { create }, audio: { transcriptions: { create: vi.fn() } } }
    return { ai: new AiService({ getKey: vi.fn() }, settings, { search: () => [] }, { clientFactory: async () => client }), create }
  }
  it('sends one image request with context and no output cap; math overrides Code', async () => {
    const h = harness(); const chunks = h.ai.retrieveSnapshot(SNAPSHOT_QUESTION, new AbortController().signal)
    const result = await h.ai.generate(SNAPSHOT_QUESTION, chunks, { answerFormat: 'code', snapshotDataUrl: 'data:image/png;base64,c2NyZWVu' })
    expect(result).toMatchObject({ responseStyle: 'solution', task: 'math' }); expect(h.create).toHaveBeenCalledTimes(1)
    const request = h.create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({ model: 'gpt-6-luna', store: false, reasoning: { effort: 'medium' } })
    expect(request).not.toHaveProperty('max_output_tokens')
    expect(JSON.stringify(request.input)).toContain('input_image'); expect(JSON.stringify(request.input)).toContain('Reference context')
  })
  it('rejects forged screenshot document citations', async () => {
    const h = harness({ ...solution, support: 'document-supported', evidence: [{ chunkId: 'forged', documentName: 'fake', location: 'page 1' }] } as typeof solution)
    await expect(h.ai.generate(SNAPSHOT_QUESTION, [], { snapshotDataUrl: 'data:image/png;base64,eA==' })).rejects.toMatchObject({ code: 'malformed_response' })
  })
  it('all registry models support images, structured output and medium reasoning', () => {
    expect(MODEL_REGISTRY).toHaveLength(6)
    for (const model of MODEL_REGISTRY) { expect(model.imageInput && model.structuredOutputs).toBe(true); expect(model.reasoning).toContain('medium') }
  })
  it('the strict snapshot schema requires nullable code titles instead of optional provider fields', () => {
    const codeBlocks = snapshotResponseJsonSchema.properties!.codeBlocks as { items: { required: string[] } }
    expect(codeBlocks.items.required).toEqual(['language', 'title', 'code'])
  })
})
