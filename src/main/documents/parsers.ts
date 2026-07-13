import { readFile } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import type { DocumentChunk } from './types.js'

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, textNodeName: '#text' })

function flattenText(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((item) => flattenText(item, output))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) if (key === 't') flattenText(child, output); else if (!key.startsWith('@_')) flattenText(child, output)
  }
  return output
}

export async function parseDocument(path: string, documentId: string): Promise<DocumentChunk[]> {
  const ext = extname(path).toLowerCase()
  if (ext === '.pptx') return parsePptx(path, documentId)
  if (ext === '.pdf') return parsePdf(path, documentId)
  if (ext === '.md' || ext === '.markdown') return parseText(path, documentId, 'markdown')
  if (ext === '.txt') return parseText(path, documentId, 'text')
  throw new Error(`Unsupported document type: ${ext}`)
}

async function parsePptx(path: string, documentId: string): Promise<DocumentChunk[]> {
  const files = unzipSync(new Uint8Array(await readFile(path)))
  const slides = Object.keys(files).filter((key) => /^ppt\/slides\/slide\d+\.xml$/.test(key)).sort(numericPathSort)
  const chunks: DocumentChunk[] = []
  slides.forEach((slidePath, index) => {
    const slideNumber = index + 1
    const slideText = extractXmlText(files[slidePath])
    const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`
    const notesText = extractXmlText(files[notesPath])
    if (slideText) chunks.push({ id: `${documentId}:slide:${slideNumber}`, documentId, text: slideText, pageOrSlide: slideNumber, kind: 'slide' })
    if (notesText) chunks.push({ id: `${documentId}:notes:${slideNumber}`, documentId, text: notesText, pageOrSlide: slideNumber, kind: 'speakerNotes' })
  })
  return chunks
}

function extractXmlText(data?: Uint8Array): string {
  if (!data) return ''
  const parsed = xml.parse(strFromU8(data)) as unknown
  return [...new Set(flattenText(parsed).map((text) => text.trim()).filter(Boolean))].join(' ').replace(/\s+/g, ' ').trim()
}

async function parsePdf(path: string, documentId: string): Promise<DocumentChunk[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), useWorkerFetch: false })
  const document = await task.promise
  const chunks: DocumentChunk[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
    if (text) chunks.push({ id: `${documentId}:page:${pageNumber}`, documentId, text, pageOrSlide: pageNumber, kind: 'pdfPage' })
  }
  return chunks
}

async function parseText(path: string, documentId: string, kind: 'markdown' | 'text'): Promise<DocumentChunk[]> {
  const raw = await readFile(path, 'utf8')
  const sections = kind === 'markdown' ? raw.split(/(?=^#{1,6}\s+)/m) : raw.split(/\n\s*\n/)
  return sections.flatMap((section, index) => splitOversized(section.trim(), 2200).map((text, part) => ({
    id: `${documentId}:section:${index + 1}:${part + 1}`, documentId, text,
    section: section.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? `Section ${index + 1}`, kind
  })))
}

function splitOversized(text: string, max: number): string[] {
  if (!text) return []
  if (text.length <= max) return [text]
  const result: string[] = []
  for (let start = 0; start < text.length; start += max - 200) result.push(text.slice(start, start + max))
  return result
}
function numericPathSort(a: string, b: string): number { return Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]) }

export function documentKind(path: string): 'pptx' | 'pdf' | 'markdown' | 'text' {
  const ext = extname(path).toLowerCase()
  if (ext === '.pptx') return 'pptx'; if (ext === '.pdf') return 'pdf'; if (ext === '.md' || ext === '.markdown') return 'markdown'; return 'text'
}
export function documentName(path: string): string { return basename(path) }
