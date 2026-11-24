/**
 * The evaluation: does this actually find bugs, and does it cry wolf?
 *
 *   npm run evaluate                  # all arms, 1 repetition
 *   npm run evaluate -- --arms C,D --reps 3
 *   npm run evaluate -- --arms C      # no API key needed: arm C uses no model
 *
 * Every arm runs against TWO shops: one with all five seeded defects live, and
 * one with none. Detection alone is not a result — a tool that reported
 * everything would score five out of five — so the headline figure is always a
 * pair: how many seeded defects were found, and how many reports were filed
 * against an application that was behaving correctly. The second number should
 * be zero.
 *
 * Arms:
 *   A  the model writes the suite (what the product did before this work)
 *   B  A, plus model-written tests for the gaps
 *   C  designs computed from the application's own rules — no model at all
 *   D  C plus the model's flows and the gap finder: the full pipeline
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

type ArmId = 'A' | 'B' | 'C' | 'D'

interface Args {
  arms: ArmId[]
  reps: number
  label: string
  /** skip the no-bugs shop (halves the time, loses the false-alarm figure) */
  skipClean: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { arms: ['A', 'B', 'C', 'D'], reps: 1, label: 'eval', skipClean: false }
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i]
    if (argv[i] === '--arms') out.arms = (next() ?? '').split(/[,\s]+/).filter((a): a is ArmId => ['A', 'B', 'C', 'D'].includes(a))
    else if (argv[i] === '--reps') out.reps = Math.max(1, Math.min(10, Number(next()) || 1))
    else if (argv[i] === '--label') out.label = (next() ?? 'eval').replace(/[^a-z0-9._-]/gi, '-')
    else if (argv[i] === '--skip-clean') out.skipClean = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

// Everything below must be decided before the engine is imported.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'testpilot-eval-'))
const DATABASE_URL = 'file:' + path.join(work, 'eval.db').replace(/\\/g, '/')
process.env.DATABASE_URL = DATABASE_URL
process.env.EVIDENCE_DIR = path.join(work, 'evidence')
process.env.HEADLESS = '1'
process.env.TRACE = 'off' // nobody opens a trace from an evaluation

const migrate = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'scripts', 'prisma.mjs'), 'migrate', 'deploy'], {
  cwd: SERVER_ROOT,
  env: { ...process.env, DATABASE_URL },
  encoding: 'utf8',
})
if (migrate.status !== 0) {
  console.error(migrate.stdout, migrate.stderr)
  throw new Error('could not migrate the evaluation database')
}

const { createShopApp } = (await import('@testpilot/demo-shop')) as { createShopApp: (o?: { bugs?: number[] }) => import('express').Express }
const { prisma } = await import('../src/db')
const { closeSharedBrowser } = await import('../src/engine/browserPool')
const { exploreApp } = await import('../src/engine/explorer')
const { generateTests } = await import('../src/ai/suite')
const { generateGaps } = await import('../src/ai/gaps')
const { proposeRequirements } = await import('../src/ai/requirements')
const { computeCoverage } = await import('../src/ai/traceability')
const { startRun, queueState } = await import('../src/services/runService')
const { llm } = await import('../src/ai/router')
const { SEEDED_BUGS, reportText, scoreReports } = await import('./evaluate.bugs')

const hasModel = llm.order('reason').some((p) => p.name !== 'mock' && p.configured)
if (!hasModel && args.arms.some((a) => a !== 'C')) {
  console.warn('\nNo AI provider is configured, so only arm C (computed designs) can run. Add a key in .env for the others.\n')
  args.arms = args.arms.filter((a) => a === 'C')
  if (args.arms.length === 0) process.exit(3)
}

interface ArmResult {
  rep: number
  arm: ArmId
  shop: 'bugs' | 'clean'
  tests: number
  designed: number
  passed: number
  failed: number
  toolFailures: number
  reports: number
  seededFound: number[]
  falseReports: number
  duplicateReports: number
  llmCalls: number
  promptTokens: number
  completionTokens: number
  seconds: number
  coverage: { violated: number; covered: number; partial: number; uncovered: number; total: number } | null
}

/** Wait for every queued and running test to finish, including retries. */
async function drain(timeoutMs = 25 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // The retry policy queues a second attempt after a run ends, so an empty
  // queue is not proof of being done; it has to stay empty.
  let quiet = 0
  while (Date.now() < deadline) {
    const s = queueState()
    if (s.running === 0 && s.queued === 0) {
      if (++quiet >= 4) return
    } else {
      quiet = 0
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('  (gave up waiting for the queue to drain)')
}

async function runOneArm(rep: number, arm: ArmId, shop: 'bugs' | 'clean'): Promise<ArmResult> {
  const bugs = shop === 'bugs' ? undefined : []
  const server: Server = createShopApp(bugs === undefined ? {} : { bugs }).listen(0)
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const started = Date.now()

  const project = await prisma.project.create({
    data: {
      name: `rep${rep}-arm${arm}-${shop}`,
      baseUrl,
      resetUrl: `${baseUrl}__reset`,
      testUser: 'test@example.com',
      testPassword: 'Password123!',
      // One at a time: the reset hook wipes shared data, and a measurement
      // must not be polluted by tests tripping over each other.
      parallel: false,
      retryOnFail: true,
    },
  })

  try {
    await exploreApp(project.id)

    // ---- build the suite for this arm
    let designed = 0
    if (arm === 'C') {
      // Computed designs only. generateTests also calls the model unless no
      // provider is configured, so take the designs directly.
      const { designTests } = await import('../src/ai/design')
      const pages = await prisma.appPage.findMany({ where: { projectId: project.id } })
      const { json } = await import('../src/db')
      const result = designTests({
        pages: pages.map((p) => ({
          url: p.url,
          title: p.title,
          kind: p.kind,
          forms: json(p.forms, []),
          actions: json(p.actions, []),
          rules: json(p.rules, []),
          headings: json(p.headings, []),
          samples: json(p.samples, []),
          reachedVia: p.reachedVia,
          requiresAuth: p.requiresAuth,
        })),
        testUser: project.testUser,
        testData: json(project.testData, {}),
      })
      designed = result.designs.length
      for (const d of result.designs.slice(0, 24)) {
        await prisma.testCase.create({
          data: {
            projectId: project.id,
            title: d.title,
            instruction: d.instruction,
            origin: 'generated',
            kind: d.kind,
            technique: d.technique,
            area: d.area,
            targetUrl: d.pageUrl,
            targetForm: d.form,
            targetField: d.field,
            designKey: d.designKey,
            oracle: d.oracle,
            oracleText: d.oracleText,
            auth: d.auth,
            priority: d.priority,
          },
        })
      }
    } else {
      const suite = await generateTests(project.id, { prompt: '' })
      designed = suite.drafts.filter((d) => d.source === 'designed').length
      // Arm A is the old behaviour: the model's tests only.
      const drafts = arm === 'A' ? suite.drafts.filter((d) => d.source !== 'designed') : suite.drafts
      for (const d of drafts.filter((x) => !x.duplicateOf).slice(0, 24)) {
        await prisma.testCase.create({
          data: {
            projectId: project.id,
            title: d.title,
            instruction: d.instruction,
            origin: 'generated',
            kind: d.kind,
            technique: d.technique ?? null,
            area: d.area ?? null,
            targetUrl: d.targetUrl ?? null,
            targetForm: d.targetForm ?? null,
            targetField: d.targetField ?? null,
            designKey: d.designKey ?? null,
            oracle: d.oracle ?? null,
            oracleText: d.oracleText ?? null,
            auth: d.auth ?? 'auto',
            priority: d.priority ?? 2,
          },
        })
      }
    }

    // ---- run everything
    for (const tc of await prisma.testCase.findMany({ where: { projectId: project.id } })) {
      await startRun(tc.id, { headless: true })
    }
    await drain()

    // ---- arms B and D add the gap finder on top
    if (arm === 'B' || arm === 'D') {
      await proposeRequirements(project.id).catch((e) => console.warn('  requirements step failed:', (e as Error).message))
      await generateGaps(project.id).catch((e) => console.warn('  gap step failed:', (e as Error).message))
      const gaps = await prisma.gapScenario.findMany({ where: { projectId: project.id, status: 'suggested', feasibility: { not: 'infeasible' } }, take: 12 })
      for (const g of gaps) {
        const tc = await prisma.testCase.create({
          data: { projectId: project.id, title: g.title, instruction: g.instruction, origin: 'gap', gapScenarioId: g.id },
        })
        await prisma.gapScenario.update({ where: { id: g.id }, data: { status: 'converted' } })
        await startRun(tc.id, { headless: true })
      }
      await drain()
    }

    // ---- score it
    const runs = await prisma.run.findMany({ where: { testCase: { projectId: project.id } }, select: { status: true, failureKind: true, llmCalls: true, promptTokens: true, completionTokens: true, kind: true } })
    const normal = runs.filter((r) => r.kind === 'normal')
    const reports = await prisma.bugReport.findMany({ where: { projectId: project.id } })
    const scored = scoreReports(
      reports.map((b) => ({ id: b.id, text: reportText([b.title, b.expected, b.actual, b.notes, b.stepsToReproduce]) })),
    )
    const coverage = await computeCoverage(project.id).catch(() => null)

    return {
      rep,
      arm,
      shop,
      tests: await prisma.testCase.count({ where: { projectId: project.id } }),
      designed,
      passed: normal.filter((r) => r.status === 'passed').length,
      failed: normal.filter((r) => r.status === 'failed').length,
      toolFailures: normal.filter((r) => r.failureKind === 'tool').length,
      reports: reports.length,
      seededFound: scored.found,
      falseReports: scored.falseReports.length,
      duplicateReports: scored.duplicates,
      llmCalls: runs.reduce((a, r) => a + r.llmCalls, 0),
      promptTokens: runs.reduce((a, r) => a + r.promptTokens, 0),
      completionTokens: runs.reduce((a, r) => a + r.completionTokens, 0),
      seconds: Math.round((Date.now() - started) / 1000),
      coverage: coverage ? { ...coverage.summary, total: coverage.total } : null,
    }
  } finally {
    server.close()
  }
}

const results: ArmResult[] = []

try {
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of args.arms) {
      for (const shop of args.skipClean ? (['bugs'] as const) : (['bugs', 'clean'] as const)) {
        console.log(`\n── repetition ${rep}, arm ${arm}, ${shop === 'bugs' ? 'all five defects live' : 'a correct shop'}`)
        const r = await runOneArm(rep, arm, shop)
        results.push(r)
        console.log(
          `   ${r.tests} tests · ${r.passed} passed · ${r.failed} failed · ${r.reports} report(s)` +
            (shop === 'bugs' ? ` · found ${r.seededFound.length}/5 seeded` : ` · ${r.falseReports} FALSE report(s)`) +
            ` · ${r.llmCalls} AI calls · ${r.seconds}s`,
        )
      }
    }
  }
} finally {
  await closeSharedBrowser().catch(() => undefined)
}

// ---------------------------------------------------------------- the report
const lines: string[] = []
const push = (s = '') => {
  lines.push(s)
  console.log(s)
}

push('')
push('| Rep | Arm | Shop | Tests | Seeded found (of 5) | False reports | Tool failures | AI calls | Tokens in/out | Time |')
push('|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  push(
    `| ${r.rep} | ${r.arm} | ${r.shop === 'bugs' ? 'defects live' : 'correct'} | ${r.tests} | ${r.shop === 'bugs' ? `${r.seededFound.length} (${r.seededFound.join(', ') || 'none'})` : '—'} | ${r.falseReports} | ${r.toolFailures} | ${r.llmCalls} | ${r.promptTokens}/${r.completionTokens} | ${r.seconds}s |`,
  )
}

push('')
push('| Arm | Detection (mean of 5) | False reports (mean) | AI calls (mean) | Time (mean) |')
push('|---|---|---|---|---|')
for (const arm of args.arms) {
  const onBugs = results.filter((r) => r.arm === arm && r.shop === 'bugs')
  const onClean = results.filter((r) => r.arm === arm && r.shop === 'clean')
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—')
  const range = (xs: number[]) => (xs.length > 1 ? ` (${Math.min(...xs)}–${Math.max(...xs)})` : '')
  const detect = onBugs.map((r) => r.seededFound.length)
  const falses = onClean.map((r) => r.falseReports)
  push(
    `| ${arm} | ${mean(detect)}${range(detect)} | ${mean(falses)}${range(falses)} | ${mean([...onBugs, ...onClean].map((r) => r.llmCalls))} | ${mean([...onBugs, ...onClean].map((r) => r.seconds))}s |`,
  )
}

push('')
push('Which seeded defects were found, by arm:')
for (const arm of args.arms) {
  const onBugs = results.filter((r) => r.arm === arm && r.shop === 'bugs')
  for (const bug of SEEDED_BUGS) {
    const hits = onBugs.filter((r) => r.seededFound.includes(bug.id)).length
    push(`  arm ${arm} · bug ${bug.id} (${bug.name}): ${hits} of ${onBugs.length} repetition(s)`)
  }
}

push('')
push('Limits of this measurement: one application, five seeded defects, ' + `${args.reps} repetition(s), a free-tier model, and a bug report is matched to a seeded defect by keyword. ` + 'A false report means a report filed against a shop with no defects at all; the target is zero.')

const outDir = path.join(REPO_ROOT, 'docs', 'evaluation')
fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
fs.writeFileSync(path.join(outDir, `${stamp}-${args.label}.json`), JSON.stringify({ at: new Date().toISOString(), args, results }, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(outDir, `${stamp}-${args.label}.md`), lines.join('\n') + '\n', 'utf8')
console.log(`\nwritten: ${path.join(outDir, `${stamp}-${args.label}.md`)}`)

await prisma.$disconnect().catch(() => undefined)
fs.rmSync(work, { recursive: true, force: true })
process.exit(0)
