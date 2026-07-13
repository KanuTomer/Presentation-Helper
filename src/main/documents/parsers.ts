import { open } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  DocumentParseError,
  type DocumentChunk,
  type DocumentChunkKind
} from './types.js'

export { DocumentParseError, type DocumentErrorCode } from './types.js'

export const MAX_CHUNK_CHARS = 2_200
export const CHUNK_OVERLAP_CHARS = 200
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024
const MAX_EXPANDED_PPTX_BYTES = 250 * 1024 * 1024
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const
const EXCLUDED_PLACEHOLDERS = new Set(['hdr', 'ftr', 'dt', 'sldNum', 'sldImg'])

const relationshipXml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  processEntities: false
})
const orderedContentXml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  preserveOrder: true,
  processEntities: false,
  textNodeName: '#text'
})

export interface ParseDocumentBytesInput {
  documentId: string
  name: string
  path?: string
  bytes: Uint8Array
}

interface DocumentSourceUnit {
  sourceKey: string
  kind: DocumentChunkKind
  text: string
  pageOrSlide?: number
  section?: string
  title?: string
}

interface OpcRelationship {
  id: string
  type: string
  target: string
  targetMode?: string
}

type OrderedNode = Record<string, unknown>

export async function parseDocument(path: string, documentId: string): Promise<DocumentChunk[]> {
  let bytes: Uint8Array
  try {
    bytes = await readBoundedDocument(path)
  } catch (cause) {
    if (cause instanceof DocumentParseError) throw cause
    throw new DocumentParseError(
      'unreadable',
      'The document could not be read. Check that it still exists and that PresenterAI has permission to open it.',
      { cause }
    )
  }
  return parseDocumentBytes({ documentId, name: basename(path), path, bytes })
}

async function readBoundedDocument(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new DocumentParseError('unreadable', 'The selected path is not a readable document file.')
    if (!Number.isSafeInteger(info.size) || info.size > MAX_DOCUMENT_BYTES) {
      throw new DocumentParseError('unreadable', 'The document is too large to index safely. Use a file smaller than 100 MB.')
    }
    const buffer = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, offset)
  } finally {
    await handle.close()
  }
}

/** Parse one immutable byte snapshot without reading the source path again. */
export async function parseDocumentBytes(input: ParseDocumentBytesInput): Promise<DocumentChunk[]> {
  if (!input.documentId.trim()) throw malformed('The document identity is missing.')
  const kind = documentKind(input.name)
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentParseError('unreadable', 'The document is too large to index safely. Use a file smaller than 100 MB.')
  }
  const bytes = Uint8Array.from(input.bytes)

  try {
    let units: DocumentSourceUnit[]
    if (kind === 'pptx') units = parsePptx(bytes)
    else if (kind === 'pdf') units = await parsePdf(bytes)
    else units = parseTextDocument(bytes, kind)
    return chunkSourceUnits(input.documentId, units)
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    throw malformed(`The ${kindLabel(kind)} file is damaged or is not a valid ${kindLabel(kind)} document.`, error)
  }
}

export function splitDocumentText(
  input: string,
  maxChars = MAX_CHUNK_CHARS,
  overlapChars = CHUNK_OVERLAP_CHARS
): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1 || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError('Chunk sizes must be positive integers and overlap must be smaller than the maximum.')
  }
  const text = normalizeText(input)
  if (!text) return []
  const characters = Array.from(text)
  if (characters.length <= maxChars) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < characters.length) {
    const targetEnd = Math.min(start + maxChars, characters.length)
    let end = targetEnd
    if (targetEnd < characters.length) {
      let boundary = targetEnd
      while (boundary > start && !isWhitespace(characters[boundary])) boundary -= 1
      if (boundary > start) end = boundary
    }
    if (end <= start) end = targetEnd
    const chunk = characters.slice(start, end).join('').trim()
    if (chunk) chunks.push(chunk)
    if (end >= characters.length) break

    const earliest = Math.max(start + 1, end - overlapChars)
    let nextStart = earliest
    while (nextStart < end && !isWordStart(characters, nextStart)) nextStart += 1
    if (nextStart >= end || nextStart <= start) nextStart = end
    start = nextStart
  }
  return chunks
}

function chunkSourceUnits(documentId: string, units: DocumentSourceUnit[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = []
  for (const unit of units) {
    const parts = splitDocumentText(unit.text)
    for (let index = 0; index < parts.length; index += 1) {
      chunks.push({
        id: `${documentId}:${unit.sourceKey}:part:${index + 1}`,
        documentId,
        text: parts[index]!,
        kind: unit.kind,
        part: index + 1,
        partCount: parts.length,
        ...(unit.pageOrSlide === undefined ? {} : { pageOrSlide: unit.pageOrSlide }),
        ...(unit.section ? { section: normalizeTitle(unit.section) } : {}),
        ...(unit.title ? { title: normalizeTitle(unit.title) } : {})
      })
    }
  }
  if (chunks.length === 0) {
    throw new DocumentParseError(
      'empty',
      'No extractable text was found. Image-only documents require OCR or vision support, which is not available in this milestone.'
    )
  }
  return chunks
}

function parsePptx(bytes: Uint8Array): DocumentSourceUnit[] {
  if (startsWith(bytes, CFB_SIGNATURE)) {
    throw new DocumentParseError('encrypted', 'This PowerPoint file is encrypted. Remove its encryption and try again.')
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw malformed('The PowerPoint file is not a valid PPTX archive.')

  let files: Record<string, Uint8Array>
  let expandedSize = 0
  try {
    files = unzipSync(bytes, { filter: (file) => {
      expandedSize += file.originalSize
      if (expandedSize > MAX_EXPANDED_PPTX_BYTES) {
        throw new DocumentParseError('unreadable', 'The expanded PowerPoint file is too large to index safely.')
      }
      return true
    } })
  } catch (cause) {
    if (cause instanceof DocumentParseError) throw cause
    throw malformed('The PowerPoint archive is damaged or encrypted.', cause)
  }
  parseRelationshipPart(requiredPart(files, '[Content_Types].xml'), 'PowerPoint content types')
  const presentationPath = 'ppt/presentation.xml'
  const presentation = parseRelationshipPart(requiredPart(files, presentationPath), 'PowerPoint presentation')
  const presentationRelationships = relationshipMap(files, presentationPath, true)
  const presentationRoot = findElementObjects(presentation, 'presentation')[0]
  const slideList = presentationRoot ? directElementObjects(presentationRoot, 'sldIdLst')[0] : undefined
  const slideIds = slideList ? directElementObjects(slideList, 'sldId') : []
  const units: DocumentSourceUnit[] = []

  for (let index = 0; index < slideIds.length; index += 1) {
    const relationshipId = getRelationshipAttribute(slideIds[index]!, 'id')
    if (!relationshipId) throw malformed('A PowerPoint slide is missing its relationship identifier.')
    const relationship = presentationRelationships.get(relationshipId)
    if (!relationship || !relationship.type.endsWith('/slide')) {
      throw malformed('A PowerPoint slide relationship is missing or has the wrong type.')
    }
    const slidePath = resolveRelationshipTarget(presentationPath, relationship, 'slide')
    const slideBytes = requiredPart(files, slidePath)
    const slideNumber = index + 1
    const slideContent = extractPresentationContent(slideBytes, 'slide')
    if (slideContent.text) {
      units.push({
        sourceKey: `slide:${slideNumber}`,
        kind: 'slide',
        text: slideContent.text,
        pageOrSlide: slideNumber,
        ...(slideContent.title ? { title: slideContent.title } : {})
      })
    }

    const slideRelationships = relationshipMap(files, slidePath, false)
    const notesRelationship = [...slideRelationships.values()].find((item) => item.type.endsWith('/notesSlide'))
    if (notesRelationship) {
      const notesPath = resolveRelationshipTarget(slidePath, notesRelationship, 'speaker notes')
      const notesContent = extractPresentationContent(requiredPart(files, notesPath), 'notes')
      if (notesContent.text) {
        units.push({
          sourceKey: `slide:${slideNumber}:notes`,
          kind: 'speakerNotes',
          text: notesContent.text,
          pageOrSlide: slideNumber,
          ...(slideContent.title ? { title: slideContent.title } : {})
        })
      }
    }
  }
  return units
}

function parseRelationshipPart(bytes: Uint8Array, label: string): unknown {
  const source = decodeXml(bytes, label)
  try { return relationshipXml.parse(source) as unknown } catch (cause) { throw malformed(`The ${label} XML is malformed.`, cause) }
}

function decodeXml(bytes: Uint8Array, label: string): string {
  const source = strFromU8(bytes)
  if (/<!DOCTYPE/i.test(source) || XMLValidator.validate(source) !== true) {
    throw malformed(`The ${label} XML is malformed.`)
  }
  return source
}

function relationshipMap(files: Record<string, Uint8Array>, sourcePart: string, required: boolean): Map<string, OpcRelationship> {
  const relationshipPath = relationshipPartPath(sourcePart)
  const bytes = files[relationshipPath]
  if (!bytes) {
    if (required) throw malformed(`The relationship file for ${sourcePart} is missing.`)
    return new Map()
  }
  const parsed = parseRelationshipPart(bytes, 'PowerPoint relationship')
  const relationships = new Map<string, OpcRelationship>()
  for (const value of findElementObjects(parsed, 'Relationship')) {
    const id = getAttribute(value, 'Id')
    const type = getAttribute(value, 'Type')
    const target = getAttribute(value, 'Target')
    if (!id || !type || !target || relationships.has(id)) throw malformed('A PowerPoint relationship is invalid or duplicated.')
    relationships.set(id, {
      id,
      type,
      target,
      ...(getAttribute(value, 'TargetMode') ? { targetMode: getAttribute(value, 'TargetMode') } : {})
    })
  }
  return relationships
}

function resolveRelationshipTarget(sourcePart: string, relationship: OpcRelationship, label: string): string {
  if (relationship.targetMode?.toLowerCase() === 'external' || /^[a-z][a-z\d+.-]*:/i.test(relationship.target) || relationship.target.startsWith('//')) {
    throw malformed(`The ${label} relationship points outside the PowerPoint package.`)
  }
  let target: string
  try { target = decodeURIComponent(relationship.target.split('#', 1)[0]!) } catch (cause) { throw malformed(`The ${label} relationship target is invalid.`, cause) }
  if (target.includes('\\')) throw malformed(`The ${label} relationship target is invalid.`)
  const joined = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(sourcePart), target)
  const normalized = posix.normalize(joined)
  if (!normalized.startsWith('ppt/') || normalized.includes('\0')) {
    throw malformed(`The ${label} relationship escapes the PowerPoint package.`)
  }
  return normalized
}

function relationshipPartPath(sourcePart: string): string {
  return posix.join(posix.dirname(sourcePart), '_rels', `${posix.basename(sourcePart)}.rels`)
}

function requiredPart(files: Record<string, Uint8Array>, part: string): Uint8Array {
  const value = files[part]
  if (!value) throw malformed(`The PowerPoint package is missing ${part}.`)
  return value
}

function extractPresentationContent(bytes: Uint8Array, mode: 'slide' | 'notes'): { text: string; title?: string } {
  const source = decodeXml(bytes, mode === 'slide' ? 'PowerPoint slide' : 'PowerPoint speaker notes')
  let parsed: unknown
  try { parsed = orderedContentXml.parse(source) as unknown } catch (cause) { throw malformed('PowerPoint slide content is malformed.', cause) }
  const nodes = asOrderedNodes(parsed)
  const blocks: string[] = []
  let title: string | undefined

  visitOrdered(nodes, (node, name) => {
    if (name === 'sp') {
      const placeholder = placeholderType(node)
      if (EXCLUDED_PLACEHOLDERS.has(placeholder ?? '')) return false
      const text = extractShapeText(node)
      if (text) {
        if (mode === 'slide' && (placeholder === 'title' || placeholder === 'ctrTitle') && !title) title = normalizeTitle(text)
        if (mode === 'slide' || placeholder === 'body' || placeholder === 'title' || placeholder === 'ctrTitle' || placeholder === undefined) blocks.push(text)
      }
      return false
    }
    if (name === 'tbl') {
      const table = extractTableText(node)
      if (table) blocks.push(table)
      return false
    }
    return true
  })

  const text = normalizeText(blocks.join('\n\n'))
  return { text, ...(title ? { title } : {}) }
}

function placeholderType(node: OrderedNode): string | undefined {
  const placeholder = findOrdered(nodeChildren(node), 'ph')[0]
  const attributes = placeholder?.[':@']
  if (!attributes || typeof attributes !== 'object') return undefined
  const type = (attributes as Record<string, unknown>)['@_type']
  return typeof type === 'string' ? type : undefined
}

function extractShapeText(node: OrderedNode): string {
  const body = findOrdered(nodeChildren(node), 'txBody')[0]
  return body ? extractTextBody(body) : ''
}

function extractTextBody(body: OrderedNode): string {
  const paragraphs = findOrdered(nodeChildren(body), 'p')
  const values = paragraphs.map((paragraph) => extractRuns(nodeChildren(paragraph)).trim()).filter(Boolean)
  if (values.length > 0) return normalizeText(values.join('\n'))
  return normalizeText(extractRuns(nodeChildren(body)))
}

function extractRuns(nodes: OrderedNode[]): string {
  const output: string[] = []
  const visit = (values: OrderedNode[]): void => {
    for (const node of values) {
      const [name, value] = nodeEntry(node) ?? []
      if (!name) continue
      if (localName(name) === 't') output.push(extractRawText(value))
      else if (localName(name) === 'br') output.push('\n')
      else if (localName(name) === 'tab') output.push('\t')
      else visit(asOrderedNodes(value))
    }
  }
  visit(nodes)
  return output.join('')
}

function extractRawText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractRawText).join('')
  if (!value || typeof value !== 'object') return ''
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== ':@')
    .map(([, child]) => extractRawText(child))
    .join('')
}

function extractTableText(table: OrderedNode): string {
  const rows = findOrdered(nodeChildren(table), 'tr')
  return normalizeText(rows.map((row) => {
    const cells = findOrdered(nodeChildren(row), 'tc')
    return cells.map((cell) => {
      const body = findOrdered(nodeChildren(cell), 'txBody')[0]
      return body ? extractTextBody(body).replace(/\s*\n\s*/g, ' / ') : ''
    }).join(' | ')
  }).filter((row) => row.replaceAll('|', '').trim()).join('\n'))
}

async function parsePdf(bytes: Uint8Array): Promise<DocumentSourceUnit[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS
  })
  let document: Awaited<typeof task.promise> | undefined
  try {
    document = await task.promise
    const titles = await pdfOutlineTitles(document)
    const units: DocumentSourceUnit[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const lines: string[] = []
        let line: string[] = []
        for (const item of content.items) {
          if (!('str' in item)) continue
          if (item.str) line.push(item.str)
          if ('hasEOL' in item && item.hasEOL) {
            const value = normalizeInline(line.join(' '))
            if (value) lines.push(value)
            line = []
          }
        }
        const trailing = normalizeInline(line.join(' '))
        if (trailing) lines.push(trailing)
        const text = normalizeText(lines.join('\n'))
        if (text) {
          units.push({
            sourceKey: `page:${pageNumber}`,
            kind: 'pdfPage',
            text,
            pageOrSlide: pageNumber,
            ...(titles.get(pageNumber) ? { title: titles.get(pageNumber) } : {})
          })
        }
      } finally {
        page.cleanup()
      }
    }
    return units
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    const value = error as { name?: string; code?: number; message?: string }
    if (value.name === 'PasswordException' || value.code === pdfjs.PasswordResponses.NEED_PASSWORD || value.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD) {
      throw new DocumentParseError('password_protected', 'This PDF requires a password. Remove the password and try again.', { cause: error })
    }
    if (/encrypt|security handler/i.test(value.message ?? '')) {
      throw new DocumentParseError('encrypted', 'This PDF uses encryption that PresenterAI cannot open. Export an unencrypted copy and try again.', { cause: error })
    }
    throw malformed('The PDF is damaged or is not a valid PDF document.', error)
  } finally {
    if (document) await document.cleanup().catch(() => undefined)
    await task.destroy().catch(() => undefined)
  }
}

async function pdfOutlineTitles(document: Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>['promise']>): Promise<Map<number, string>> {
  const titles = new Map<number, string>()
  let outline: Awaited<ReturnType<typeof document.getOutline>>
  try { outline = await document.getOutline() } catch { return titles }
  if (!outline) return titles

  const visit = async (items: typeof outline, parents: string[]): Promise<void> => {
    for (const item of items ?? []) {
      const title = normalizeTitle(item.title)
      const path = title ? [...parents, title] : parents
      try {
        const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
        if (destination?.[0]) {
          const pageIndex = await document.getPageIndex(destination[0])
          if (title) titles.set(pageIndex + 1, path.join(' > '))
        }
      } catch { /* Ignore an invalid optional outline target while retaining page text. */ }
      if (item.items?.length) await visit(item.items, path)
    }
  }
  await visit(outline, [])
  return titles
}

function parseTextDocument(bytes: Uint8Array, kind: 'markdown' | 'text'): DocumentSourceUnit[] {
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (cause) { throw malformed(`The ${kindLabel(kind)} file is not valid UTF-8 text.`, cause) }
  return kind === 'markdown' ? markdownUnits(raw) : plainTextUnits(raw)
}

function markdownUnits(raw: string): DocumentSourceUnit[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const units: DocumentSourceUnit[] = []
  const headings: string[] = []
  let buffer: string[] = []
  let title: string | undefined
  let section = 'Preamble'
  let fence: { marker: '`' | '~'; length: number } | undefined

  const flush = (): void => {
    const text = normalizeText(buffer.join('\n'))
    if (text) units.push({
      sourceKey: `section:${units.length + 1}`,
      kind: 'markdown',
      text,
      section,
      ...(title ? { title } : {})
    })
    buffer = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      buffer.push(line)
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) fence = undefined
      continue
    }
    if (fenceMatch) {
      buffer.push(line)
      fence = { marker: fenceMatch[1]![0] as '`' | '~', length: fenceMatch[1]!.length }
      continue
    }

    const atx = line.match(/^\s{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/)
    const next = lines[index + 1]
    const setext = line.trim() && next?.match(/^\s{0,3}(=+|-+)\s*$/)
    if (atx || setext) {
      flush()
      const level = atx ? atx[1]!.length : setext![1]![0] === '=' ? 1 : 2
      const rawTitle = atx ? atx[2]!.replace(/[ \t]+#+[ \t]*$/, '') : line
      title = normalizeTitle(rawTitle)
      if (!title) {
        buffer.push(line)
        continue
      }
      headings.length = level
      headings[level - 1] = title
      section = headings.filter(Boolean).join(' > ')
      buffer.push(line)
      if (setext) { buffer.push(next!); index += 1 }
      continue
    }
    buffer.push(line)
  }
  flush()
  return units
}

function plainTextUnits(raw: string): DocumentSourceUnit[] {
  const normalized = normalizeText(raw)
  if (!normalized) return []
  return normalized.split(/\n\s*\n/).map((text, index) => ({
    sourceKey: `section:${index + 1}`,
    kind: 'text',
    text,
    section: `Section ${index + 1}`
  }))
}

function findElementObjects(value: unknown, expectedName: string, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    value.forEach((item) => findElementObjects(item, expectedName, output))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('@_')) continue
      if (localName(key) === expectedName) {
        const values = Array.isArray(child) ? child : [child]
        for (const item of values) if (item && typeof item === 'object') output.push(item as Record<string, unknown>)
      }
      findElementObjects(child, expectedName, output)
    }
  }
  return output
}

function directElementObjects(value: Record<string, unknown>, expectedName: string): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_') || localName(key) !== expectedName) continue
    const values = Array.isArray(child) ? child : [child]
    for (const item of values) if (item && typeof item === 'object') output.push(item as Record<string, unknown>)
  }
  return output
}

function getRelationshipAttribute(value: Record<string, unknown>, name: string): string | undefined {
  const entry = Object.entries(value).find(([key]) => key.startsWith('@_') && key.includes(':') && localName(key) === name)
  return typeof entry?.[1] === 'string' ? entry[1] : undefined
}

function getAttribute(value: Record<string, unknown>, name: string): string | undefined {
  const entry = Object.entries(value).find(([key]) => key.startsWith('@_') && localName(key) === name)
  return typeof entry?.[1] === 'string' ? entry[1] : undefined
}

function asOrderedNodes(value: unknown): OrderedNode[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is OrderedNode => Boolean(item) && typeof item === 'object')
}

function nodeEntry(node: OrderedNode): [string, unknown] | undefined {
  return Object.entries(node).find(([key]) => key !== ':@')
}

function nodeChildren(node: OrderedNode): OrderedNode[] {
  return asOrderedNodes(nodeEntry(node)?.[1])
}

function visitOrdered(nodes: OrderedNode[], visitor: (node: OrderedNode, name: string) => boolean): void {
  for (const node of nodes) {
    const entry = nodeEntry(node)
    if (!entry) continue
    const descend = visitor(node, localName(entry[0]))
    if (descend) visitOrdered(asOrderedNodes(entry[1]), visitor)
  }
}

function findOrdered(nodes: OrderedNode[], expectedName: string): OrderedNode[] {
  const output: OrderedNode[] = []
  visitOrdered(nodes, (node, name) => { if (name === expectedName) output.push(node); return true })
  return output
}

function localName(name: string): string {
  const plain = name.startsWith('@_') ? name.slice(2) : name
  return plain.slice(plain.lastIndexOf(':') + 1)
}

function normalizeText(text: string): string {
  return text.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeInline(text: string): string { return text.replace(/\s+/g, ' ').trim().normalize('NFC') }
function normalizeTitle(text: string): string { return Array.from(normalizeInline(text)).slice(0, 300).join('') }
function isWhitespace(value: string | undefined): boolean { return value === undefined || /\s/u.test(value) }
function isWordStart(values: string[], index: number): boolean { return !isWhitespace(values[index]) && (index === 0 || isWhitespace(values[index - 1])) }
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean { return signature.every((value, index) => bytes[index] === value) }
function malformed(message: string, cause?: unknown): DocumentParseError {
  return new DocumentParseError('malformed', message, cause === undefined ? undefined : { cause })
}

function kindLabel(kind: ReturnType<typeof documentKind>): string {
  if (kind === 'pptx') return 'PowerPoint'
  if (kind === 'pdf') return 'PDF'
  return kind === 'markdown' ? 'Markdown' : 'text'
}

export function documentKind(pathOrName: string): 'pptx' | 'pdf' | 'markdown' | 'text' {
  const extension = extname(pathOrName).toLowerCase()
  if (extension === '.pptx') return 'pptx'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.txt') return 'text'
  throw new DocumentParseError(
    'unsupported_type',
    'PresenterAI supports PPTX, PDF, Markdown, and UTF-8 text documents.'
  )
}

export function documentName(path: string): string { return basename(path) }
