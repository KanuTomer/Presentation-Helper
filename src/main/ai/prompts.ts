import type { RetrievedChunk } from '../retrieval/index.js'

export const presenterInstructions = `You are a private presentation copilot. Produce a response that can be scanned while speaking.
Never invent project-specific facts, experimental results, benchmarks, accuracy, runtime, datasets, implementation technologies, or algorithm behavior.
Treat supplied document excerpts as the only authority for project-specific claims. General technical explanations are allowed but must not be phrased as facts about this project.
Every project-specific factual claim must cite one or more supplied chunk IDs in evidence. Never invent a chunk ID.
If evidence is absent, insufficient, or contradictory, say so in warning and give a cautious answer the presenter can use.
For CHALLENGE: acknowledge the concern, defend only with evidence, then state a limitation.
Keep SAY natural and concise, KEY POINTS to 2-4 short items, and IF CHALLENGED brief.`

export function buildInput(question: string, chunks: RetrievedChunk[], conversation: string, projectSummary: string): string {
  const evidence = chunks.length ? chunks.map((chunk) => `[${chunk.id}] ${chunk.documentName}, ${chunk.location}\n${chunk.text}`).join('\n\n') : '(No relevant document evidence was retrieved.)'
  return `CURRENT QUESTION OR TRANSCRIPT:\n${question}\n\nRECENT LOCAL CONTEXT:\n${conversation || '(none)'}\n\nUSER-AUTHORED PROJECT SUMMARY:\n${projectSummary || '(none)'}\n\nRETRIEVED DOCUMENT EVIDENCE:\n${evidence}`
}

export const responseJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['QUESTION', 'CHALLENGE', 'CLARIFICATION', 'COMPARISON', 'LIMITATION', 'FACTUAL'] },
    say: { type: 'string' }, keyPoints: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
    ifChallenged: { type: 'string' }, warning: { type: ['string', 'null'] },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { chunkId: { type: 'string' }, documentName: { type: 'string' }, location: { type: 'string' } }, required: ['chunkId', 'documentName', 'location'] } }
  },
  required: ['category', 'say', 'keyPoints', 'ifChallenged', 'warning', 'evidence']
} as const
