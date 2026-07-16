import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePresenterWav } from '../src/main/audio/wavValidation'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'presenter-wav-'))
  temporaryDirectories.push(root)
  return { root, path: join(root, 'capture.wav') }
}

describe('PresenterAI WAV validation', () => {
  it('accepts the exact owned 16 kHz mono PCM snapshot and metadata', async () => {
    const { root, path } = await fixture()
    const bytes = pcmWave(1_000)
    await writeFile(path, bytes)
    const result = await validatePresenterWav(path, root, {
      bytes: bytes.length, durationMs: 1_000, sampleRate: 16_000, channels: 1
    })
    expect(result.bytes).toEqual(bytes)
    expect(result).toMatchObject({ durationMs: 1_000, byteCount: 32_044, sampleRate: 16_000, channels: 1 })
  })

  it('rejects a readable WAV outside the owned directory', async () => {
    const owned = await fixture()
    const outside = await fixture()
    await writeFile(outside.path, pcmWave(1_000))
    await expect(validatePresenterWav(outside.path, owned.root)).rejects.toMatchObject({ code: 'invalid_audio' })
  })

  it.each([
    ['short', Buffer.from('not a wave')],
    ['stereo', pcmWave(1_000, 16_000, 2)],
    ['wrong rate', pcmWave(1_000, 48_000, 1)],
    ['too short', pcmWave(200)],
    ['too long', pcmWave(90_001)]
  ])('rejects %s audio based on actual bytes', async (_name, bytes) => {
    const { root, path } = await fixture()
    await writeFile(path, bytes)
    await expect(validatePresenterWav(path, root)).rejects.toMatchObject({ code: 'invalid_audio' })
  })

  it('rejects helper metadata that does not describe the uploaded snapshot', async () => {
    const { root, path } = await fixture()
    const bytes = pcmWave(1_000)
    await writeFile(path, bytes)
    await expect(validatePresenterWav(path, root, {
      bytes: bytes.length + 2, durationMs: 1_000, sampleRate: 16_000, channels: 1
    })).rejects.toMatchObject({ code: 'invalid_audio' })
  })
})

function pcmWave(durationMs: number, sampleRate = 16_000, channels = 1): Buffer {
  const bitsPerSample = 16
  const blockAlign = channels * bitsPerSample / 8
  const byteRate = sampleRate * blockAlign
  const dataBytes = Math.floor(durationMs / 1_000 * byteRate)
  const output = Buffer.alloc(44 + dataBytes)
  output.write('RIFF', 0, 'ascii'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8, 'ascii')
  output.write('fmt ', 12, 'ascii'); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22); output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(byteRate, 28)
  output.writeUInt16LE(blockAlign, 32); output.writeUInt16LE(bitsPerSample, 34)
  output.write('data', 36, 'ascii'); output.writeUInt32LE(dataBytes, 40)
  return output
}
