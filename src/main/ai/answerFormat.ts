import type { AnswerFormat } from '../../shared/contracts.js'

const NON_PROGRAMMING_CODE = /\b(?:code\s+signing|code\s+of\s+conduct|source[- ]code\s+licen[cs]\w*|licen[cs]\w*\s+(?:the\s+)?source[- ]code)\b/u
const DIRECT_CODE_REQUEST = /\b(?:code|snippet)\s+(?:for|to)\b/u
const CREATION_OR_EDIT_INTENT = /\b(?:write|generate|provide|show|create|build|design|implement|fix|debug|refactor|convert)(?:s|ed|ing)?\b/u
const PROGRAMMING_ARTIFACT_OR_TECHNOLOGY = /\b(?:code|snippet|component|function|class|hook|script|query|regex|jsx|tsx|javascript|typescript|react|python|sql|html|css|java|rust|golang|powershell|bash|node(?:\.js)?)\b|c#|c\+\+/u

export function isCodeAnswerRequest(question: string): boolean {
  const normalized = question.normalize('NFKC').toLocaleLowerCase('en-US')
  if (NON_PROGRAMMING_CODE.test(normalized)) return false
  if (DIRECT_CODE_REQUEST.test(normalized)) return true
  return CREATION_OR_EDIT_INTENT.test(normalized) && PROGRAMMING_ARTIFACT_OR_TECHNOLOGY.test(normalized)
}

export function resolveAnswerFormat(_question: string, requested: AnswerFormat = 'presenter'): AnswerFormat {
  return requested
}
