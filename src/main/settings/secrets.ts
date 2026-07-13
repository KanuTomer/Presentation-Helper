import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class SecretStore {
  private get path(): string { return join(app.getPath('userData'), 'openai-key.bin') }
  async hasKey(): Promise<boolean> { try { return (await readFile(this.path)).length > 0 } catch { return false } }
  async saveKey(value: string): Promise<void> {
    if (!value.startsWith('sk-') || value.length < 20) throw new Error('Enter a valid OpenAI API key.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.')
    const encrypted = safeStorage.encryptString(value.trim())
    await writeFile(this.path, encrypted)
  }
  async getKey(): Promise<string> {
    const encrypted = await readFile(this.path)
    return safeStorage.decryptString(encrypted)
  }
  async deleteKey(): Promise<void> { await rm(this.path, { force: true }) }
}
