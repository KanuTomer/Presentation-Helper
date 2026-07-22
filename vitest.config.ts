import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Electron, pdf.js and SQLite include process-global/native state. A
    // serial fork pool isolates that state and avoids Windows worker-thread
    // termination after the heavier PDF/SQLite suites.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { reporter: ['text', 'html'] }
  }
})
