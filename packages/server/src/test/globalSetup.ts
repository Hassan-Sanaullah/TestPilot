/** Vitest global setup: migrate the dedicated test database. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DATABASE_URL } from '../../vitest.config'

export default function setup(): void {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  fs.mkdirSync(path.join(serverRoot, 'data'), { recursive: true })
  const r = spawnSync(process.execPath, [path.join(serverRoot, 'scripts', 'prisma.mjs'), 'migrate', 'deploy'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`test DB migration failed:\n${r.stdout}\n${r.stderr}`)
}
