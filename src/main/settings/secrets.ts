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
  files?: SecretFileAdapter
  encryption?: EncryptionAdapter
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
  private readonly files: SecretFileAdapter
  private readonly encryption: EncryptionAdapter
  constructor(options: SecretStoreOptions = {}) {
    this.path = options.path ?? (() => join(app.getPath('userData'), 'openai-key.bin'))
    this.files = options.files ?? nodeFiles
    this.encryption = options.encryption ?? electronEncryption
  }
  async hasKey(): Promise<boolean> { try { return (await this.files.read(this.path())).byteLength > 0 } catch { return false } }
  async saveKey(input: string): Promise<void> {
    const value = input.trim()
    if (!value.startsWith('sk-') || value.length < 20) throw new Error('Enter a valid OpenAI API key.')
    if (!this.encryption.isAvailable()) throw new Error('Windows secure storage is unavailable.')
    await this.files.write(this.path(), this.encryption.encrypt(value))
  }
  async getKey(): Promise<string> { return this.encryption.decrypt(await this.files.read(this.path())) }
  async deleteKey(): Promise<void> { await this.files.remove(this.path()) }
}
