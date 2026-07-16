import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SecretFileAdapter {
  read(path: string): Promise<Uint8Array>
  write(path: string, value: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
}
export interface EncryptionAdapter {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}
export interface SecretStoreOptions {
  path?: () => string
  metadataPath?: () => string
  files?: SecretFileAdapter
  encryption?: EncryptionAdapter
  clock?: () => Date
}

export interface ApiKeyStatus {
  configured: boolean
  masked: boolean
  protection: 'windows-dpapi' | 'unavailable'
  updatedAt?: string
}

const nodeFiles: SecretFileAdapter = {
  read: (path) => readFile(path),
  write: (path, value) => writeFile(path, value),
  remove: (path) => rm(path, { force: true })
}
const electronEncryption: EncryptionAdapter = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
}

export class SecretStore {
  private readonly path: () => string
  private readonly metadataPath: () => string
  private readonly files: SecretFileAdapter
  private readonly encryption: EncryptionAdapter
  private readonly clock: () => Date
  constructor(options: SecretStoreOptions = {}) {
    this.path = options.path ?? (() => join(app.getPath('userData'), 'openai-key.bin'))
    this.metadataPath = options.metadataPath ?? (options.path
      ? () => `${this.path()}.meta.json`
      : () => join(app.getPath('userData'), 'openai-key.meta.json'))
    this.files = options.files ?? nodeFiles
    this.encryption = options.encryption ?? electronEncryption
    this.clock = options.clock ?? (() => new Date())
  }
  async hasKey(): Promise<boolean> { try { return (await this.files.read(this.path())).byteLength > 0 } catch { return false } }
  async status(): Promise<ApiKeyStatus> {
    const configured = await this.hasKey()
    const metadata = configured ? await this.readMetadata() : undefined
    return {
      configured,
      masked: configured,
      protection: this.encryption.isAvailable() ? 'windows-dpapi' : 'unavailable',
      ...(metadata ? { updatedAt: metadata.updatedAt } : {})
    }
  }
  async saveKey(input: string): Promise<void> {
    const value = input.trim()
    if (!value.startsWith('sk-') || value.length < 20) throw new Error('Enter a valid OpenAI API key.')
    if (!this.encryption.isAvailable()) throw new Error('Windows secure storage is unavailable.')
    await this.files.write(this.path(), this.encryption.encrypt(value))
    await this.files.write(this.metadataPath(), Buffer.from(JSON.stringify({
      schemaVersion: 1,
      updatedAt: this.clock().toISOString()
    }), 'utf8'))
  }
  async getKey(): Promise<string> { return this.encryption.decrypt(await this.files.read(this.path())) }
  async deleteKey(): Promise<void> {
    const outcomes = await Promise.allSettled([this.files.remove(this.path()), this.files.remove(this.metadataPath())])
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failure) throw failure.reason
  }

  private async readMetadata(): Promise<{ updatedAt: string } | undefined> {
    try {
      const raw = JSON.parse(Buffer.from(await this.files.read(this.metadataPath())).toString('utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const value = raw as Record<string, unknown>
      if (value.schemaVersion !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return undefined
      return { updatedAt: value.updatedAt }
    } catch { return undefined }
  }
}
