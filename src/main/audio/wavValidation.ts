import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { operationError } from '../operations/coordinator.js'

export const PRESENTER_WAV_SAMPLE_RATE = 16_000
export const PRESENTER_WAV_CHANNELS = 1
export const PRESENTER_WAV_BITS_PER_SAMPLE = 16
export const MIN_PRESENTER_WAV_DURATION_MS = 250
export const MAX_PRESENTER_WAV_DURATION_MS = 90_000
// 90 seconds of 16 kHz, mono, 16-bit PCM is 2,880,000 data bytes.
// Leave a small allowance for RIFF metadata while remaining far below the API limit.
export const MAX_PRESENTER_WAV_BYTES = 3_000_000

export interface ValidatedPresenterWav {
  bytes: Buffer
  durationMs: number
  byteCount: number
  sampleRate: typeof PRESENTER_WAV_SAMPLE_RATE
  channels: typeof PRESENTER_WAV_CHANNELS
}

export interface ExpectedPresenterWav {
  bytes: number
  durationMs: number
  sampleRate: number
  channels: number
}

/**
 * Reads and validates the exact byte snapshot that will be uploaded. The
 * real-path check prevents a path outside PresenterAI's owned temp directory
 * (including a junction/symlink escape) from being accepted.
 */
export async function validatePresenterWav(
  path: string,
  ownedDirectory: string,
  expected?: ExpectedPresenterWav
): Promise<ValidatedPresenterWav> {
  try {
    if (extname(path).toLocaleLowerCase('en-US') !== '.wav') throw invalidAudio()
    const [ownedRoot, target] = await Promise.all([realpath(resolve(ownedDirectory)), realpath(resolve(path))])
    const ownedRelative = relative(ownedRoot, target)
    if (!ownedRelative || ownedRelative.startsWith('..') || isAbsolute(ownedRelative)) throw invalidAudio()

    const info = await stat(target)
    if (!info.isFile() || info.size <= 44 || info.size > MAX_PRESENTER_WAV_BYTES) throw invalidAudio()
    const bytes = await readFile(target)
    if (bytes.byteLength !== info.size) throw invalidAudio()

    const metadata = parsePcmWave(bytes)
    if (!metadata || metadata.format !== 1 || metadata.channels !== PRESENTER_WAV_CHANNELS ||
        metadata.sampleRate !== PRESENTER_WAV_SAMPLE_RATE || metadata.bitsPerSample !== PRESENTER_WAV_BITS_PER_SAMPLE ||
        metadata.blockAlign !== 2 || metadata.byteRate !== 32_000) throw invalidAudio()

    const durationMs = metadata.dataBytes / metadata.byteRate * 1_000
    if (!Number.isFinite(durationMs) || durationMs < MIN_PRESENTER_WAV_DURATION_MS || durationMs > MAX_PRESENTER_WAV_DURATION_MS) {
      throw invalidAudio()
    }
    if (expected && (
      expected.bytes !== bytes.byteLength || expected.sampleRate !== metadata.sampleRate || expected.channels !== metadata.channels ||
      Math.abs(expected.durationMs - durationMs) > 25
    )) throw invalidAudio()

    return {
      bytes,
      durationMs,
      byteCount: bytes.byteLength,
      sampleRate: PRESENTER_WAV_SAMPLE_RATE,
      channels: PRESENTER_WAV_CHANNELS
    }
  } catch (error) {
    if (isInvalidAudioError(error)) throw error
    throw invalidAudio()
  }
}

interface WaveMetadata {
  format: number
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
  dataBytes: number
}

function parsePcmWave(bytes: Buffer): WaveMetadata | undefined {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return undefined
  const declaredRiffBytes = bytes.readUInt32LE(4) + 8
  if (declaredRiffBytes !== bytes.length || declaredRiffBytes < 44) return undefined

  let format: Omit<WaveMetadata, 'dataBytes'> | undefined
  let dataBytes: number | undefined
  for (let offset = 12; offset + 8 <= declaredRiffBytes;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const end = dataOffset + size
    if (end > declaredRiffBytes || end > bytes.length) return undefined
    if (id === 'fmt ') {
      if (size < 16) return undefined
      format = {
        format: bytes.readUInt16LE(dataOffset),
        channels: bytes.readUInt16LE(dataOffset + 2),
        sampleRate: bytes.readUInt32LE(dataOffset + 4),
        byteRate: bytes.readUInt32LE(dataOffset + 8),
        blockAlign: bytes.readUInt16LE(dataOffset + 12),
        bitsPerSample: bytes.readUInt16LE(dataOffset + 14)
      }
    } else if (id === 'data') {
      if (dataBytes !== undefined) return undefined
      dataBytes = size
    }
    offset = end + (size % 2)
  }
  if (!format || dataBytes === undefined || dataBytes <= 0 || dataBytes % Math.max(1, format.blockAlign) !== 0) return undefined
  return { ...format, dataBytes }
}

function invalidAudio(): Error {
  return operationError(
    'invalid_audio',
    'The temporary recording was not a valid PresenterAI-owned 16 kHz mono PCM WAV.',
    true
  )
}

function isInvalidAudioError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'invalid_audio')
}
