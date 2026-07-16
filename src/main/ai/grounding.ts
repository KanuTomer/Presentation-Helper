import type { AssistantResponse } from '../../shared/contracts.js'
import type { RetrievedChunk } from '../retrieval/index.js'

export type GroundingValidation = { valid: true } | { valid: false; reason: string }

export function validateGroundingResponse(
  response: AssistantResponse,
  question: string,
  chunks: readonly RetrievedChunk[]
): GroundingValidation {
  const suppliedIds = new Set(chunks.map((chunk) => chunk.id))
  const citedIds = response.evidence.map((item) => item.chunkId)
  if (new Set(citedIds).size !== citedIds.length) return invalid('duplicate citation')
  if (citedIds.some((id) => !suppliedIds.has(id))) return invalid('citation was not supplied')

  if (response.support === 'document-supported') {
    if (response.evidence.length === 0) return invalid('document-supported answer has no citation')
    if (response.evidenceIssue !== 'none') return invalid('document-supported answer reports an evidence issue')
  } else if (response.support === 'general-technical') {
    if (response.evidence.length !== 0 || response.evidenceIssue !== 'none' || response.warning) {
      return invalid('general explanation carries project evidence or warning state')
    }
    if (requiresProjectEvidence(question) || (response.category === 'FACTUAL' && hasProjectReference(question))) {
      return invalid('project-specific factual question was labeled general')
    }
  } else {
    if (!response.warning?.trim() || response.evidenceIssue === 'none') {
      return invalid('unsupported project answer lacks a warning or evidence issue')
    }
  }

  if (response.evidenceIssue === 'missing' && response.evidence.length !== 0) {
    return invalid('missing-evidence answer cites evidence')
  }
  if (response.evidenceIssue === 'conflicting') {
    if (response.support !== 'unsupported-project-claim' || response.evidence.length < 2) {
      return invalid('conflicting evidence is not represented by an unsupported answer with two citations')
    }
    if (!/\b(?:conflict|contradict|disagree|inconsisten)\w*/iu.test(response.warning ?? '')) {
      return invalid('conflicting evidence warning is not explicit')
    }
  }
  return { valid: true }
}

export function requiresProjectEvidence(question: string): boolean {
  const projectClaim = /\b(?:result|accuracy|runtime|dataset|training\s+data|outperform|experiment|implemented|implementation|algorithm|benchmark|baseline|hardware|participant|precision|recall|ablation|cost|failure\s+rate|memory|latency|throughput|method|architecture|use[sd]?)\b/iu.test(question)
  return hasProjectReference(question) && projectClaim
}

export function hasProjectReference(question: string): boolean {
  const namedProject = /\b(?:presenterai(?:['’]s)?|this\s+(?:project|system|prototype|implementation|approach|model)|the\s+(?:project|app|application))\b/iu.test(question)
  const possessedProject = /\b(?:our|my)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:project|team|system|prototype|implementation|approach|model|app|application|result|experiment|dataset|benchmark|baseline|architecture|design|interface|method|algorithm|classifier|pipeline|study|accuracy|precision|recall|runtime|latency|throughput|cost|memory|hardware)\b/iu.test(question)
  const teamAction = /\bwe\b.{0,120}\b(?:achiev\w*|implement\w*|build\w*|built|chos\w*|use[sd]?|measur\w*|test\w*|train\w*|outperform\w*|deploy\w*)\b/iu.test(question)
  return namedProject || possessedProject || teamAction
}

function invalid(reason: string): GroundingValidation { return { valid: false, reason } }
