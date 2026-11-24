// Runs the Prisma CLI with the repo-root .env loaded and a default DATABASE_URL
// (SQLite file under packages/server/data). Usage: node scripts/prisma.mjs migrate deploy
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.resolve(serverRoot, '..', '..', '.env') })
if (!process.env.DATABASE_URL) {
  fs.mkdirSync(path.join(serverRoot, 'data'), { recursive: true })
  process.env.DATABASE_URL = 'file:' + path.join(serverRoot, 'data', 'testpilot.db').replace(/\\/g, '/')
}

const bin = path.join(serverRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
const fallback = path.resolve(serverRoot, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
const exe = fs.existsSync(bin) ? bin : fallback
const win = process.platform === 'win32'
// On Windows .cmd shims need a shell; quote the path because it may contain spaces.
const r = spawnSync(win ? `"${exe}"` : exe, process.argv.slice(2), { stdio: 'inherit', shell: win, cwd: serverRoot })
process.exit(r.status ?? 1)
