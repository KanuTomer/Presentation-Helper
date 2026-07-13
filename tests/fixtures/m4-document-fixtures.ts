import { strToU8, unzipSync, zipSync } from 'fflate'
import { createHash } from 'node:crypto'

const encoder = new TextEncoder()
const fixedZipDate = new Date('1980-01-01T00:00:00.000Z')

export interface PptxFixtureOptions {
  oversizedText?: string
  presentationTarget?: string
  presentationTargetMode?: 'External'
  omitTargetSlide?: boolean
}

export function createRelationshipPptx(options: PptxFixtureOptions = {}): Uint8Array {
  const target = options.presentationTarget ?? 'slides/slide9.xml'
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
      </Types>`),
    'ppt/presentation.xml': xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
        <p:sldIdLst>
          <p:sldId id="256" r:id="rId9"/>
          <p:sldId id="257" r:id="rId2"/>
        </p:sldIdLst>
        <p:extLst><p:ext uri="section-metadata"><p14:sectionLst><p14:section name="Part A">
          <p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst>
        </p14:section></p14:sectionLst></p:ext></p:extLst>
      </p:presentation>`),
    'ppt/_rels/presentation.xml.rels': relationshipsXml([
      { id: 'rId9', type: 'slide', target, targetMode: options.presentationTargetMode },
      { id: 'rId2', type: 'slide', target: 'slides/slide2.xml' }
    ]),
    'ppt/slides/slide2.xml': slideXml('Second Slide', options.oversizedText ?? 'A compact second slide.'),
    'ppt/slides/_rels/slide9.xml.rels': relationshipsXml([
      { id: 'notesRel', type: 'notesSlide', target: '../notesSlides/notesSlide4.xml' }
    ]),
    'ppt/notesSlides/notesSlide4.xml': notesXml()
  }
  if (!options.omitTargetSlide && !options.presentationTargetMode && target === 'slides/slide9.xml') {
    files['ppt/slides/slide9.xml'] = firstSlideXml()
  }
  return zipSync(files, { level: 0, mtime: fixedZipDate })
}

export function createMalformedXmlPptx(): Uint8Array {
  const bytes = createRelationshipPptx()
  const files = unzipForMutation(bytes)
  files['ppt/presentation.xml'] = xmlBytes('<p:presentation><broken></p:presentation>')
  return zipSync(files, { level: 0, mtime: fixedZipDate })
}

export function createEmptyPptx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xmlBytes('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': xmlBytes('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst/></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': relationshipsXml([])
  }, { level: 0, mtime: fixedZipDate })
}

export function createCfbEncryptedBytes(): Uint8Array {
  return Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
}

export function createPdfFixture(pages: Array<{ text: string; title?: string }>): Uint8Array {
  const pageCount = pages.length
  const fontId = 3 + pageCount * 2
  const outlinedPages = pages.map((page, index) => ({ ...page, index })).filter((page) => page.title)
  const outlineRootId = outlinedPages.length ? fontId + 1 : undefined
  const outlineFirstId = outlineRootId === undefined ? undefined : outlineRootId + 1
  const objectCount = fontId + (outlineRootId === undefined ? 0 : 1 + outlinedPages.length)
  const objects = new Map<number, Uint8Array>()

  objects.set(1, ascii(`<< /Type /Catalog /Pages 2 0 R${outlineRootId ? ` /Outlines ${outlineRootId} 0 R /PageMode /UseOutlines` : ''} >>`))
  objects.set(2, ascii(`<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`))
  for (let index = 0; index < pages.length; index += 1) {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    const stream = pdfTextStream(pages[index]!.text)
    objects.set(pageId, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
    objects.set(contentId, concatBytes(ascii(`<< /Length ${stream.byteLength} >>\nstream\n`), stream, ascii('\nendstream')))
  }
  objects.set(fontId, ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

  if (outlineRootId && outlineFirstId) {
    const lastId = outlineFirstId + outlinedPages.length - 1
    objects.set(outlineRootId, ascii(`<< /Type /Outlines /First ${outlineFirstId} 0 R /Last ${lastId} 0 R /Count ${outlinedPages.length} >>`))
    outlinedPages.forEach((page, outlineIndex) => {
      const id = outlineFirstId + outlineIndex
      const previous = outlineIndex > 0 ? ` /Prev ${id - 1} 0 R` : ''
      const next = outlineIndex + 1 < outlinedPages.length ? ` /Next ${id + 1} 0 R` : ''
      objects.set(id, ascii(`<< /Title (${escapePdfString(page.title!)}) /Parent ${outlineRootId} 0 R /Dest [${3 + page.index * 2} 0 R /Fit]${previous}${next} >>`))
    })
  }
  return assemblePdf(objects, objectCount, '')
}

export function createPasswordProtectedPdf(): Uint8Array {
  const userPassword = ascii('presenter')
  const ownerPassword = ascii('fixture-owner')
  const fileId = md5(ascii('PresenterAI deterministic protected PDF'))
  const ownerKey = md5(padPdfPassword(ownerPassword)).slice(0, 5)
  const ownerEntry = rc4(ownerKey, padPdfPassword(userPassword))
  const permissions = new Uint8Array(4)
  new DataView(permissions.buffer).setInt32(0, -4, true)
  const encryptionKey = md5(concatBytes(padPdfPassword(userPassword), ownerEntry, permissions, fileId)).slice(0, 5)
  const userEntry = rc4(encryptionKey, PDF_PASSWORD_PADDING)

  const content = pdfTextStream('Protected fixture content.')
  const encryptedContent = rc4(pdfObjectKey(encryptionKey, 4), content)
  const objects = new Map<number, Uint8Array>([
    [1, ascii('<< /Type /Catalog /Pages 2 0 R >>')],
    [2, ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [3, ascii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>')],
    [4, concatBytes(ascii(`<< /Length ${encryptedContent.byteLength} >>\nstream\n`), encryptedContent, ascii('\nendstream'))],
    [5, ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')],
    [6, ascii(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${hex(ownerEntry)}> /U <${hex(userEntry)}> /P -4 >>`)]
  ])
  const id = hex(fileId)
  return assemblePdf(objects, 6, ` /Encrypt 6 0 R /ID [<${id}> <${id}>]`)
}

export function createEncryptedPdfMarker(): Uint8Array {
  return ascii(`%PDF-1.7
1 0 obj << /Filter /Adobe.PubSec >> endobj
trailer << /Root 2 0 R /Encrypt 1 0 R >>
%%EOF`)
}

function firstSlideXml(): Uint8Array {
  return xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        ${shapeXml('Presenter Architecture', 'title')}
        ${shapeXml('Repeated evidence')}
        ${shapeXml('Repeated evidence')}
        <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
          ${tableRowXml(['Metric', 'Value'])}
          ${tableRowXml(['Accuracy', 'Unreported'])}
        </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      </p:spTree></p:cSld>
    </p:sld>`)
}

function slideXml(title: string, body: string): Uint8Array {
  return xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>${shapeXml(title, 'ctrTitle')}${shapeXml(body)}</p:spTree></p:cSld>
    </p:sld>`)
}

function notesXml(): Uint8Array {
  return xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
    <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        ${shapeXml('Do not include slide image', 'sldImg')}
        ${shapeXml('Explain the local retrieval boundary.', 'body')}
        ${shapeXml('Preserve this untyped note.')}
        ${shapeXml('Do not include footer', 'ftr')}
        ${shapeXml('Do not include date', 'dt')}
        ${shapeXml('99', 'sldNum')}
      </p:spTree></p:cSld>
    </p:notes>`)
}

function shapeXml(text: string, placeholder?: string): string {
  return `<p:sp><p:nvSpPr><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr>
    <p:txBody><a:p><a:r><a:t xml:space="preserve">${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function tableRowXml(cells: string[]): string {
  return `<a:tr>${cells.map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${escapeXml(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`
}

function relationshipsXml(items: Array<{ id: string; type: string; target: string; targetMode?: string }>): Uint8Array {
  return xmlBytes(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${items.map((item) => `<Relationship Id="${item.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type}" Target="${escapeXml(item.target)}"${item.targetMode ? ` TargetMode="${item.targetMode}"` : ''}/>`).join('')}
    </Relationships>`)
}

function pdfTextStream(text: string): Uint8Array {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return ascii(`BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${escapePdfString(line)}) Tj`).join(' ')} ET`)
}

function assemblePdf(objects: Map<number, Uint8Array>, objectCount: number, trailerExtra: string): Uint8Array {
  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n%fixture\n')]
  const offsets = [0]
  let length = chunks[0]!.byteLength
  for (let id = 1; id <= objectCount; id += 1) {
    const object = objects.get(id)
    if (!object) throw new Error(`Missing PDF object ${id}`)
    offsets[id] = length
    const wrapped = concatBytes(ascii(`${id} 0 obj\n`), object, ascii('\nendobj\n'))
    chunks.push(wrapped)
    length += wrapped.byteLength
  }
  const xrefOffset = length
  const xref = ascii(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objectCount + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  chunks.push(xref)
  return concatBytes(...chunks)
}

function ascii(value: string): Uint8Array { return encoder.encode(value) }
function xmlBytes(value: string): Uint8Array { return strToU8(value) }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
function escapePdfString(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)') }
function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0))
  let offset = 0
  for (const value of values) { output.set(value, offset); offset += value.byteLength }
  return output
}

const PDF_PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])

function padPdfPassword(password: Uint8Array): Uint8Array {
  const output = new Uint8Array(32)
  const length = Math.min(password.byteLength, output.byteLength)
  output.set(password.slice(0, length))
  output.set(PDF_PASSWORD_PADDING.slice(0, output.byteLength - length), length)
  return output
}

function pdfObjectKey(encryptionKey: Uint8Array, objectNumber: number): Uint8Array {
  const objectBytes = Uint8Array.from([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    0,
    0
  ])
  return md5(concatBytes(encryptionKey, objectBytes)).slice(0, Math.min(encryptionKey.byteLength + 5, 16))
}

function md5(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(bytes).digest())
}

function rc4(key: Uint8Array, input: Uint8Array): Uint8Array {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let index = 0; index < state.length; index += 1) {
    j = (j + state[index]! + key[index % key.length]!) & 0xff
    const value = state[index]!; state[index] = state[j]!; state[j] = value
  }
  const output = new Uint8Array(input.byteLength)
  let i = 0; j = 0
  for (let index = 0; index < input.byteLength; index += 1) {
    i = (i + 1) & 0xff
    j = (j + state[i]!) & 0xff
    const value = state[i]!; state[i] = state[j]!; state[j] = value
    output[index] = input[index]! ^ state[(state[i]! + state[j]!) & 0xff]!
  }
  return output
}

function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex').toUpperCase() }

function unzipForMutation(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes)
}
