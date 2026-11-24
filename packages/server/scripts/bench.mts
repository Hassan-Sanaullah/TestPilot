/**
 * Where does a run actually spend its time?
 *
 * Runs three authored tests against the bundled demo shop with a scripted mock
 * model (so no network, no quota, and no variance from a real LLM), replays
 * each several times, then queues every replay at once to measure the suite
 * path. Writes docs/benchmarks/<date>-<label>.json so later claims about speed
 * are measured against something rather than asserted.
 *
 *   npm run bench            # label "baseline"
 *   npm run bench phase1
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')

const label = (process.argv[2] ?? 'baseline').replace(/[^a-z0-9._-]/gi, '-')

// Everything below must be decided BEFORE the engine is imported: config.ts
// reads these at module load, and db.ts opens the database immediately.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'testpilot-bench-'))
const DATABASE_URL = 'file:' + path.join(work, 'bench.db').replace(/\\/g, '/')
process.env.DATABASE_URL = DATABASE_URL
process.env.EVIDENCE_DIR = path.join(work, 'evidence')
process.env.HEADLESS = '1'
process.env.TRACE = process.env.TRACE ?? 'on-failure'

const migrate = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'scripts', 'prisma.mjs'), 'migrate', 'deploy'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, DATABASE_URL },
  encoding: 'utf8',
})
if (migrate.status !== 0) {
  console.error(migrate.stdout, migrate.stderr)
  throw new Error('could not migrate the benchmark database')
}

// Dynamic imports: the env above has to be in place first.
const { createShopApp } = (await import('@testpilot/demo-shop')) as { createShopApp: () => import('express').Express }
const { prisma } = await import('../src/db')
const { MockProvider } = await import('../src/ai/provider')
const { LLMRouter } = await import('../src/ai/router')
const { executeRun } = await import('../src/engine/runner')
const { replayRun } = await import('../src/engine/replay')
const { closeSharedBrowser } = await import('../src/engine/browserPool')
const { TimingCollector } = await import('../src/engine/timing')

const server: Server = createShopApp().listen(0)
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const router = (mock: InstanceType<typeof MockProvider>) => new LLMRouter({ mock }, 'mock', 'mock')

interface Case {
  name: string
  title: string
  instruction: string
  /** scripted model replies that author the test */
  replies: object[]
}

/**
 * Three shapes of test, because they cost very different amounts: a read-only
 * check, a form submission, and a multi-page flow.
 */
const cases: Case[] = [
  {
    name: 'read-only (2 steps)',
    title: 'Bench: the home page states the shop name',
    instruction: 'Open the shop and confirm the name is shown.',
    replies: [{ action: { type: 'assertText', text: 'ShopMax' } }, { action: { type: 'finish', verdict: 'pass', reason: 'the name is shown' } }],
  },
  {
    name: 'form (7 steps)',
    title: 'Bench: registration rejects a short password',
    instruction: 'Register with a password that is too short and confirm it is refused.',
    replies: [
      { action: { type: 'navigate', url: `${baseUrl}/register` } },
      { action: { type: 'find', text: 'Name' } },
      { action: { type: 'assertText', text: 'Create an account' } },
      { action: { type: 'assertText', text: 'At least 8 characters' } },
      { action: { type: 'assertUrl', contains: '/register' } },
      { action: { type: 'finish', verdict: 'pass', reason: 'the rule is stated' } },
    ],
  },
  {
    name: 'flow (6 steps)',
    title: 'Bench: the catalogue lists products',
    instruction: 'Open the catalogue and confirm products are listed.',
    replies: [
      { action: { type: 'navigate', url: `${baseUrl}/products` } },
      { action: { type: 'assertText', text: 'Products' } },
      { action: { type: 'extract' } },
      { action: { type: 'navigate', url: `${baseUrl}/cart` } },
      { action: { type: 'assertText', text: 'cart' } },
      { action: { type: 'finish', verdict: 'pass', reason: 'the catalogue and cart both load' } },
    ],
  },
]

const REPLAYS_PER_CASE = 5
const SUITE_REPEATS = 4

function stats(xs: number[]): { min: number; median: number; max: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b)
  return {
    min: Math.round(s[0]),
    median: Math.round(s[Math.floor(s.length / 2)]),
    max: Math.round(s[s.length - 1]),
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  }
}

async function main() {
  const project = await prisma.project.create({
    data: { name: `bench ${label}`, baseUrl, testUser: 'test@example.com', testPassword: 'Password123!', parallel: true },
  })

  const authored: { name: string; testCaseId: string; authorMs: number; steps: number }[] = []

  for (const c of cases) {
    const tc = await prisma.testCase.create({ data: { projectId: project.id, title: c.title, instruction: c.instruction } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'ai' } })
    const mock = new MockProvider().enqueue(...c.replies)
    const collector = new TimingCollector()
    const t0 = performance.now()
    const outcome = await executeRun(run.id, { cancelled: false, headless: true, onTiming: collector.sink }, router(mock))
    const authorMs = performance.now() - t0
    const steps = await prisma.step.count({ where: { runId: run.id } })
    if (outcome.status !== 'passed') {
      console.warn(`! ${c.name}: authoring did not pass (${outcome.status}: ${outcome.reason}) — it will not have a script to replay`)
    }
    authored.push({ name: c.name, testCaseId: tc.id, authorMs, steps })
    console.log(`authored ${c.name} in ${Math.round(authorMs)}ms (${steps} steps, ${outcome.status})`)
  }

  // ---- single replays, measured in isolation
  const single: Record<string, unknown> = {}
  for (const a of authored) {
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: a.testCaseId } })
    if (!tc.script) {
      single[a.name] = { skipped: 'no compiled script' }
      continue
    }
    const walls: number[] = []
    const collector = new TimingCollector()
    for (let i = 0; i < REPLAYS_PER_CASE; i++) {
      const run = await prisma.run.create({ data: { testCaseId: a.testCaseId, mode: 'replay' } })
      const t0 = performance.now()
      await replayRun(run.id, { cancelled: false, headless: true, onTiming: collector.sink }, router(new MockProvider()))
      walls.push(performance.now() - t0)
    }
    const stepRows = await prisma.step.findMany({
      where: { run: { testCaseId: a.testCaseId, mode: 'replay' } },
      select: { index: true, durationMs: true },
    })
    const perStep: Record<string, number[]> = {}
    for (const r of stepRows) (perStep[r.index] ??= []).push(r.durationMs)
    single[a.name] = {
      wallMs: stats(walls),
      phases: collector.summary(),
      stepMedianMs: Object.fromEntries(Object.entries(perStep).map(([k, v]) => [k, stats(v).median])),
    }
    console.log(`replay ${a.name}: median ${stats(walls).median}ms over ${REPLAYS_PER_CASE} runs`)
  }

  // ---- the suite number: everything queued at once
  const replayable = []
  for (const a of authored) {
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: a.testCaseId } })
    if (tc.script) replayable.push(a.testCaseId)
  }
  let suite: Record<string, unknown> = { skipped: 'nothing compiled' }
  if (replayable.length) {
    const ids = Array.from({ length: SUITE_REPEATS }, () => replayable).flat()
    const collector = new TimingCollector()
    const t0 = performance.now()
    await Promise.all(
      ids.map(async (testCaseId) => {
        const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
        return replayRun(run.id, { cancelled: false, headless: true, onTiming: collector.sink }, router(new MockProvider()))
      }),
    )
    const totalMs = performance.now() - t0
    suite = { runs: ids.length, totalMs: Math.round(totalMs), perRunMs: Math.round(totalMs / ids.length), phases: collector.summary() }
    console.log(`suite: ${ids.length} replays in ${Math.round(totalMs)}ms (${Math.round(totalMs / ids.length)}ms per run)`)
  }

  const { config } = await import('../src/config')
  const report = {
    label,
    at: new Date().toISOString(),
    machine: { platform: process.platform, cpus: os.cpus().length, node: process.version },
    settings: { runConcurrency: config.runConcurrency, aiConcurrency: config.aiConcurrency, traceMode: config.traceMode, headless: true },
    authoring: authored.map((a) => ({ name: a.name, ms: Math.round(a.authorMs), steps: a.steps })),
    singleReplay: single,
    suite,
  }

  const outDir = path.join(REPO_ROOT, 'docs', 'benchmarks')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${new Date().toISOString().slice(0, 10)}-${label}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8')

  console.log('')
  console.log(`| case | authoring | replay median |`)
  console.log(`|---|---|---|`)
  for (const a of authored) {
    const s = single[a.name] as { wallMs?: { median: number } } | undefined
    console.log(`| ${a.name} | ${Math.round(a.authorMs)}ms | ${s?.wallMs ? s.wallMs.median + 'ms' : 'n/a'} |`)
  }
  console.log('')
  console.log(`written: ${outFile}`)
}

try {
  await main()
} finally {
  await closeSharedBrowser().catch(() => undefined)
  await prisma.$disconnect().catch(() => undefined)
  server.close()
  fs.rmSync(work, { recursive: true, force: true })
}
