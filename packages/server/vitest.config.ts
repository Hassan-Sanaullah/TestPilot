import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))
// Tests use their own SQLite file so they never touch the development data.
export const TEST_DATABASE_URL = 'file:' + path.join(here, 'data', 'test.db').replace(/\\/g, '/')

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./src/test/globalSetup.ts'],
    env: { DATABASE_URL: TEST_DATABASE_URL, HEADLESS: '1', EVIDENCE_DIR: path.join(here, 'test-results', 'evidence') },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
