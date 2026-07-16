import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Electron, pdf.js and SQLite contend heavily when Vitest starts every
    // suite at once on Windows (especially while Defender scans generated
    // workers). Run files serially so timeouts indicate a real hang instead
    // of host load.
    pool: 'threads',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { reporter: ['text', 'html'] }
  }
})
