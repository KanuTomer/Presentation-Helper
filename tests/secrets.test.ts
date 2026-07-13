import { describe, expect, it } from 'vitest'
import { SecretStore, type EncryptionAdapter, type SecretFileAdapter } from '../src/main/settings/secrets'

describe('SecretStore boundary', () => {
  it('stores only encrypted bytes and never returns the key from status operations', async () => {
    const values = new Map<string, Uint8Array>()
    const files: SecretFileAdapter = {
      read: async (path) => { const value = values.get(path); if (!value) throw new Error('missing'); return value },
      write: async (path, value) => { values.set(path, value) }, remove: async (path) => { values.delete(path) }
    }
    const encryption: EncryptionAdapter = {
      isAvailable: () => true,
      encrypt: (value) => Uint8Array.from(Buffer.from(value).map((byte) => byte ^ 0xaa)),
      decrypt: (value) => Buffer.from(value.map((byte) => byte ^ 0xaa)).toString('utf8')
    }
    const store = new SecretStore({ path: () => 'key.bin', files, encryption })
    const key = ['sk', 'project-fixture-never-log-this'].join('-')
    await store.saveKey(`  ${key}  `)
    expect(await store.hasKey()).toBe(true)
    expect(Buffer.from(values.get('key.bin')!).toString('utf8')).not.toContain(key)
    expect(await store.getKey()).toBe(key)
    await store.deleteKey(); expect(await store.hasKey()).toBe(false)
  })

  it('rejects invalid keys and unavailable secure storage without writing', async () => {
    let writes = 0
    const files: SecretFileAdapter = { read: async () => new Uint8Array(), write: async () => { writes += 1 }, remove: async () => undefined }
    const encryption: EncryptionAdapter = { isAvailable: () => false, encrypt: () => new Uint8Array(), decrypt: () => '' }
    const store = new SecretStore({ path: () => 'key.bin', files, encryption })
    await expect(store.saveKey('not-a-key')).rejects.toThrow(/valid OpenAI API key/i)
    await expect(store.saveKey(['sk', 'project-fixture-long-enough'].join('-'))).rejects.toThrow(/secure storage/i)
    expect(writes).toBe(0)
  })
})
