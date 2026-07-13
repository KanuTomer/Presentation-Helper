import type { RetrievedChunk } from '../retrieval/index.js'

export const presenterInstructions = `You are a private presentation copilot. Produce a response that can be scanned while speaking.
Never invent project-specific facts, experimental results, benchmarks, accuracy, runtime, datasets, implementation technologies, or algorithm behavior.
Treat supplied document excerpts as the only authority for project-specific claims. General technical explanations are allowed but must not be phrased as facts about this project.
Every project-specific factual claim must cite one or more supplied chunk IDs in evidence. Never invent a chunk ID.
If evidence is absent, insufficient, or contradictory, say so in warning and give a cautious answer the presenter can use.
Classify the CURRENT QUESTION by its communicative intent before writing the answer. Use this precedence:
1. COMPARISON when it asks whether things differ, asks for the "difference between" them, asks whether they are the "same thing as" one another, or asks whether one outperforms, changed, or is faster/slower than another.
2. CHALLENGE when it expresses skepticism, an objection, or asks why the audience should trust or accept something.
3. CLARIFICATION when it asks what a term or distinction means.
4. LIMITATION when it explicitly asks for a limitation, constraint, weakness, or failure reason.
5. FACTUAL when it asks for a concrete fact, measurement, implementation detail, or result.
6. QUESTION only as the fallback.
Missing evidence affects WARNING; it must not change the question's category.
For CHALLENGE: acknowledge the concern, defend only with evidence, then state a limitation.
Produce 120-220 visible words in total without padding or repetition. Use these field targets:
- SAY: 60-80 words.
- KEY POINTS: exactly 3 items, each 12-18 words.
- IF CHALLENGED: 25-35 words.
- WARNING: 20-30 words when evidence is absent, insufficient, or contradictory; otherwise omit it.
Check the combined visible word count before returning the structured response.`

export function buildInput(question: string, chunks: RetrievedChunk[], conversation: string, projectSummary: string): string {
  const evidence = chunks.length ? chunks.map((chunk) => `[${chunk.id}] ${chunk.documentName}, ${chunk.location}\n${chunk.text}`).join('\n\n') : '(No relevant document evidence was retrieved.)'
  return `CURRENT QUESTION OR TRANSCRIPT:\n${question}\n\nRECENT LOCAL CONTEXT:\n${conversation || '(none)'}\n\nUSER-AUTHORED PROJECT SUMMARY:\n${projectSummary || '(none)'}\n\nRETRIEVED DOCUMENT EVIDENCE:\n${evidence}`
}

export const responseJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['QUESTION', 'CHALLENGE', 'CLARIFICATION', 'COMPARISON', 'LIMITATION', 'FACTUAL'] },
    say: { type: 'string', pattern: '^(?:\\S+\\s+){59,79}\\S+$' },
    keyPoints: {
      type: 'array', minItems: 3, maxItems: 3,
      items: { type: 'string', pattern: '^(?:\\S+\\s+){11,17}\\S+$' }
    },
    ifChallenged: { type: 'string', pattern: '^(?:\\S+\\s+){24,34}\\S+$' },
    warning: { type: ['string', 'null'], pattern: '^(?:\\S+\\s+){19,29}\\S+$' },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { chunkId: { type: 'string' }, documentName: { type: 'string' }, location: { type: 'string' } }, required: ['chunkId', 'documentName', 'location'] } }
  },
  required: ['category', 'say', 'keyPoints', 'ifChallenged', 'warning', 'evidence']
} as const
