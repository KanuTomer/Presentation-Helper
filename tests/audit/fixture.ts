import type { AppSettings, AppStatus, AssistantResponse, DocumentInfo, PresenterAPI } from '../../src/shared/contracts'
import '../../src/renderer/style.css'

// Renderer-only bridge. No Electron, filesystem, credentials, or provider client.
const callbacks = new Map<string, Set<(value?: unknown) => void>>()
const subscribe = (name: string, callback: (value?: unknown) => void) => {
  const group = callbacks.get(name) ?? new Set(); group.add(callback); callbacks.set(name, group)
  return () => group.delete(callback)
}
const emit = (name: string, value?: unknown) => callbacks.get(name)?.forEach((callback) => callback(value))
let settings: AppSettings = {
  neonIntensity: .65, clickThrough: false, modelMode: 'normal', normalModel: 'gpt-6-luna', strongModel: 'gpt-6.1-sol',
  normalReasoning: 'medium', strongReasoning: 'medium', transcriptionModel: 'gpt-4o-mini-transcribe',
  askShortcut: 'Control+Space', hideShortcut: 'Control+Shift+H', listenShortcut: 'Control+Shift+Space',
  projectSummary: 'Synthetic offline test project.', approvedVocabulary: []
}
let status: AppStatus
let scenario = 'presenter'
let snapshotCounter = 0
const document: DocumentInfo = { id: 'synthetic-document', name: 'Synthetic evidence and intentionally long document name.md', path: 'synthetic://evidence.md', kind: 'markdown', chunkCount: 60, addedAt: '2026-09-30T00:00:00Z' }
const evidence = [{ chunkId: 'synthetic-1', documentName: document.name, location: 'Section 1' }]
const responses: Record<string, AssistantResponse> = {
  presenter: { responseStyle: 'presenter', category: 'QUESTION', say: 'This is a synthetic presenter answer used to assess readability. '.repeat(22), keyPoints: ['Remember the main observation.', 'Check the source before making a claim.', 'State the remaining limitation.'], ifChallenged: 'The fixture demonstrates rendering only, not generated-answer quality.', support: 'document-supported', evidenceIssue: 'none', evidence },
  code: { responseStyle: 'developer', summary: 'Two synthetic files demonstrate independent code scrolling and exact indentation.', codeBlocks: [{ language: 'tsx', title: 'SearchDropdown.tsx', code: '// Wide sample: ' + 'long code line '.repeat(22) + '\n' + Array.from({ length: 65 }, (_, n) => `  const line${n} = '${'synthetic '.repeat(5)}';`).join('\n') }, { language: 'css', title: 'dropdown.css', code: '.dropdown {\n  display: grid;\n  gap: 8px;\n}' }], implementationNotes: ['This code is inert.', 'Copy retains the exact source whitespace.'], caveats: ['Synthetic code is not a working implementation.'], support: 'general-technical', evidenceIssue: 'none', evidence: [] },
  math: { responseStyle: 'solution', task: 'math', interpretedProblem: 'Evaluate a fraction and a matrix determinant.', explanation: 'Synthetic mathematical rendering fixture.', equations: ['x_1 = \\frac{1}{2}', '\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}'], steps: ['Multiply the diagonal entries.', 'Subtract the off-diagonal product.'], finalResult: '−2', codeBlocks: [], clarification: '', support: 'general-technical', evidenceIssue: 'none', evidence: [] },
  warning: { responseStyle: 'presenter', category: 'FACTUAL', say: 'There is not enough supplied project evidence to confirm this result.', keyPoints: ['Do not invent a measurement.', 'Check the underlying experiment.', 'State the evidence limitation.'], ifChallenged: 'I would need the recorded measurements before confirming that number.', warning: 'No project result is supported by this fixture.', support: 'unsupported-project-claim', evidenceIssue: 'missing', evidence: [] },
  clarification: { responseStyle: 'solution', task: 'clarification', interpretedProblem: 'Two tasks are equally plausible.', explanation: 'The screen contains an unreadable symbol.', equations: [], steps: [], finalResult: '', codeBlocks: [], clarification: 'Which of the two visible problems should I solve?', support: 'general-technical', evidenceIssue: 'none', evidence: [] }
}
const usage = { summary: { inputTokens: 2100, outputTokens: 900, audioMinutes: 0, transcriptionInputTokens: 0, transcriptionAudioTokens: 0, transcriptionOutputTokens: 0, estimatedUsd: .01, pricingVersion: 'synthetic-only' }, recent: [{ id: 'synthetic-unpriced', requestedModel: 'synthetic-model', returnedModel: 'synthetic-unknown', endpoint: 'responses', inputTokens: 100, outputTokens: 50, reasoningTokens: 20, timestamp: '2026-09-30T00:00:00Z', pricingVersion: 'synthetic-only', priced: false }], rollups: [] }
const bridge = {
  getStatus: async () => status, getSettings: async () => settings,
  updateSettings: async (patch: Partial<AppSettings>) => (settings = { ...settings, ...patch }),
  getApiKeyStatus: async () => ({ configured: scenario !== 'keyless', masked: false, protection: 'unavailable' }),
  listDocuments: async () => [document], getUsage: async () => usage,
  ask: async () => ({ ok: true, response: responses[scenario] ?? responses.presenter }),
  selectDocuments: async () => ({ documents: [document], outcomes: [{ status: 'added', name: document.name, path: document.path, documentId: document.id }, { status: 'failed', name: 'invalid.pdf', path: 'synthetic://invalid.pdf', error: { code: 'malformed', message: 'Synthetic malformed PDF.' } }] }),
  searchDocuments: async (query: string) => query === 'missing' ? [] : [{ chunkId: 'synthetic-1', documentId: document.id, documentName: document.name, title: 'Readable synthetic search result', location: 'Section 1', kind: 'markdown', preview: 'Evidence text used only for local UI checks.' }],
  inspectDocument: async (_id: string, offset: number = 0, limit: number = 50) => ({ document, offset, limit, total: 60, hasMore: offset === 0, chunks: Array.from({ length: offset ? 10 : 50 }, (_, n) => ({ id: `synthetic-${offset + n}`, title: `Section ${offset + n + 1}`, location: `Section ${offset + n + 1}`, kind: 'markdown', text: 'Synthetic indexed text. '.repeat(8), part: 1, partCount: 1 })) }),
  listSnapshotMonitors: async () => [{ id: '1', name: 'Synthetic monitor A', width: 1100, height: 720, current: true }, { id: '2', name: 'Synthetic monitor B', width: 680, height: 420, current: false }],
  captureSnapshot: async () => ({ id: `synthetic-frame-${++snapshotCounter}`, monitorId: '1', width: 600, height: 220, bytes: 100, expiresAt: new Date(Date.now() + 600000).toISOString(), dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220"><rect width="600" height="220" fill="#eee"/><text x="30" y="80" font-size="28">Synthetic screen: x² + 2x + 1 = 0</text></svg>') }),
  solveSnapshot: async () => { throw new Error('Provider dispatch is forbidden in this audit.') },
  discardSnapshot: async () => undefined, copyCode: async () => undefined,
  retryShortcuts: async () => { status = { ...status, shortcutRegistrations: status.shortcutRegistrations.map((s) => ({ ...s, status: 'registered' })), clickThrough: { ...status.clickThrough, recoveryAvailable: true } }; emit('status', status); return status.shortcutRegistrations },
  setClickThrough: async (enabled: boolean) => { status = { ...status, clickThrough: { ...status.clickThrough, enabled } }; emit('status', status); return status.clickThrough },
  cancel: async () => { status = { ...status, operation: 'idle' }; emit('status', status); return { ok: true } },
  startNewSession: async () => status.sessionUsage,
  showSettings: async () => emit('settings'),
  onStatus: (cb: (s: unknown) => void) => subscribe('status', cb), onFocusAsk: (cb: () => void) => subscribe('focus', cb), onOpenSettings: (cb: () => void) => subscribe('settings', cb), onOpenPrivacy: (cb: () => void) => subscribe('privacy', cb), onSurfaceRestored: (cb: () => void) => subscribe('surface', cb), onTranscriptDraft: (cb: (s: unknown) => void) => subscribe('draft', cb), onError: (cb: (s: unknown) => void) => subscribe('error', cb),
  ackListeningIndicator: async () => undefined, ackAnswerVisible: async () => undefined, ackTranscriptVisible: async () => undefined, acknowledgeTransmissionPreview: async () => undefined,
  refreshAudioDevices: async () => [], clearSession: async () => undefined, clearUsage: async () => undefined, clearCaptureResults: async () => undefined, clearAllDocuments: async () => undefined,
  saveApiKey: async () => { throw new Error('Credential access is forbidden in this audit.') }, testApiKey: async () => { throw new Error('Provider dispatch is forbidden in this audit.') }, deleteApiKey: async () => undefined,
  removeDocument: async () => undefined, acceptListeningConsent: async () => status.privacyConsent,
  deleteAllLocalData: async () => { throw new Error('Deletion is forbidden in this audit.') }, dismissSettingsRecoveryWarning: async () => undefined,
  toggleListening: async () => { throw new Error('Native capture is forbidden in this audit.') }, setCaptureProtection: async () => undefined, saveCaptureResult: async () => undefined, removeCaptureResult: async () => undefined
}
window.presenter = bridge as unknown as PresenterAPI
// Initialization happens before importing the auto-mounting production renderer.
status = { operation: 'idle', operationTimings: {}, listening: false, temporaryAudioExists: false, audioSource: 'Synthetic output', helperAvailable: false, helperState: 'failed', helperError: 'Synthetic helper failure — no native capture was attempted.', audioDevices: [], shortcutWarnings: [], shortcutRegistrations: [{ purpose: 'ask', accelerator: settings.askShortcut, status: 'registered' }, { purpose: 'hide', accelerator: settings.hideShortcut, status: 'registered' }, { purpose: 'recovery', accelerator: 'Control+Shift+I', status: 'unavailable' }], capture: { requested: true, electronReported: true, verifiedResults: [] }, clickThrough: { enabled: false, recoveryAvailable: false, recoveryShortcut: 'Control+Shift+I' }, privacyConsent: { requiredVersion: 4, satisfied: false }, sessionUsage: { sessionId: 'synthetic-session', startedAt: '2026-09-30T00:00:00Z', actualUsd: .01, inputTokens: 2100, outputTokens: 900, reasoningTokens: 300, unpricedRequests: 1, pricingVersion: 'synthetic-only' } }
Object.assign(window, { __audit: {
  settings: () => settings,
  scenario: (name: string) => { scenario = name },
  stage: (operation: AppStatus['operation']) => { status = { ...status, operation }; emit('status', status) },
  error: (code: string) => emit('error', { code, message: `Synthetic ${code} failure.`, retryable: true }),
  draft: () => emit('draft', { operationId: 'synthetic-draft', text: 'Editable synthetic transcript.', durationMs: 1500, endpointId: 'synthetic-output', endpointName: 'Synthetic output', createdAt: '2026-09-30T00:00:00Z' }),
  preview: () => { status = { ...status, outboundPreview: { operationId: 'synthetic-preview', stage: 'response', chunks: [{ chunkId: 'synthetic-1', documentName: document.name, location: 'Section 1', text: 'Only synthetic selected context.' }], rollingTurnCount: 2, includesProjectSummary: true } }; emit('status', status) }
} })
await import('../../src/renderer/src')
