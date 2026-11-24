/**
 * Run a project's suite from a terminal, for a build.
 *
 *   npm run suite -- "ShopMax"
 *   npm run suite -- <projectId> --base-url http://staging.example.test --junit results.xml
 *
 * Exit codes are what a build system reads:
 *   0  every test that ran passed
 *   1  at least one test failed — the application misbehaved
 *   2  at least one test could not run — TestPilot could not drive the browser
 *   3  the suite could not be started at all (bad arguments, nothing authored)
 *
 * The distinction between 1 and 2 is the point: a build should not be reported
 * as broken because a page would not load in CI.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Args {
  target?: string
  baseUrl?: string
  junit?: string
  report?: string
  json?: string
  all: boolean
  timeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { all: false, timeoutMs: 30 * 60 * 1000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--base-url') out.baseUrl = next()
    else if (a === '--junit') out.junit = next()
    else if (a === '--report') out.report = next()
    else if (a === '--json') out.json = next()
    else if (a === '--timeout') out.timeoutMs = Math.max(60, Number(next()) || 1800) * 1000
    else if (a === '--all') out.all = true
    else if (a === '--help' || a === '-h') out.target = '--help'
    else if (!a.startsWith('-') && !out.target) out.target = a
  }
  return out
}

const USAGE = `
Run a TestPilot project's suite and report the result.

  npm run suite -- <project name or id> [options]

  --base-url <url>   test a different deployment (staging, a preview build)
  --all              include tests that have not been authored yet (they will
                     be authored with the AI, which needs an API key)
  --junit <file>     write JUnit XML for your CI system
  --report <file>    write the self-contained HTML report
  --json <file>      write the raw result as JSON
  --timeout <sec>    give up waiting after this long (default 1800)

Exit code: 0 all passed · 1 a test failed · 2 a test could not run · 3 bad input
`.trim()

const args = parseArgs(process.argv.slice(2))
if (!args.target || args.target === '--help') {
  console.log(USAGE)
  process.exit(args.target ? 0 : 3)
}

// Suites never open a window, and the database must be resolved before the
// engine is imported.
process.env.HEADLESS = '1'

const { prisma } = await import('../src/db')
const { startSuite } = await import('../src/services/suiteService')
const { closeSharedBrowser } = await import('../src/engine/browserPool')
const { junitXml, htmlReport } = await import('../src/services/reports')
const { totalCost, formatCost } = await import('@testpilot/shared')

function fail(message: string): never {
  console.error(`\n${message}\n`)
  process.exitCode = 3
  throw new ExitEarly()
}
class ExitEarly extends Error {}

let exitCode = 0

try {
  const project =
    (await prisma.project.findUnique({ where: { id: args.target! } })) ??
    (await prisma.project.findFirst({ where: { name: { equals: args.target! } } })) ??
    (await prisma.project.findFirst({ where: { name: { contains: args.target! } } }))
  if (!project) {
    const all = await prisma.project.findMany({ select: { id: true, name: true } })
    fail(`No project matches "${args.target}". Projects: ${all.map((p) => `${p.name} (${p.id})`).join(', ') || 'none yet'}`)
  }

  // A different deployment, for this invocation only. Restored in `finally`,
  // because leaving a project pointed at staging would be a nasty surprise.
  const originalBaseUrl = project.baseUrl
  if (args.baseUrl) {
    await prisma.project.update({ where: { id: project.id }, data: { baseUrl: args.baseUrl } })
    console.log(`Testing ${args.baseUrl} instead of ${originalBaseUrl} for this run.`)
  }

  let suiteId: string
  try {
    const started = await startSuite(project.id, { compiledOnly: !args.all })
    suiteId = started.suiteRun.id
    console.log(`\n${project.name}: running ${started.suiteRun.total} test(s)…`)
    for (const s of started.skipped) console.log(`  skipped — ${s.title}: ${s.reason}`)
  } catch (e) {
    if (args.baseUrl) await prisma.project.update({ where: { id: project.id }, data: { baseUrl: originalBaseUrl } })
    fail((e as Error).message)
  }

  // Wait for it to finish.
  const deadline = Date.now() + args.timeoutMs
  let suite = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suiteId } })
  let lastLine = ''
  while (suite.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    suite = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suiteId } })
    const line = `  ${suite.passed + suite.failed + suite.errored} of ${suite.total} done · ${suite.passed} passed · ${suite.failed} failed`
    if (line !== lastLine) {
      console.log(line)
      lastLine = line
    }
  }
  if (suite.status === 'running') {
    console.error(`\nGave up waiting after ${Math.round(args.timeoutMs / 1000)}s. The suite is still running; see the dashboard.`)
    exitCode = 2
  }

  // Report.
  const runs = await prisma.run.findMany({
    where: { suiteRunId: suiteId, kind: 'normal' },
    orderBy: { createdAt: 'asc' },
    include: { testCase: { select: { id: true, title: true, quarantined: true, expectation: true } } },
  })
  const latest = new Map<string, (typeof runs)[number]>()
  for (const r of runs) latest.set(r.testCaseId, r)
  const results = [...latest.values()]

  console.log('')
  const width = Math.min(70, Math.max(20, ...results.map((r) => r.testCase.title.length)))
  for (const r of results) {
    const verdict = r.testCase.quarantined
      ? 'QUARANTINED'
      : r.status === 'passed'
        ? r.testCase.expectation === 'known-failing'
          ? 'FIXED'
          : 'pass'
        : r.status === 'failed' && r.failureKind !== 'tool'
          ? r.testCase.expectation === 'known-failing'
            ? 'known failure'
            : 'FAIL'
          : 'could not run'
    console.log(`  ${r.testCase.title.padEnd(width).slice(0, width)}  ${verdict}`)
    if (verdict === 'FAIL' || verdict === 'could not run') console.log(`  ${' '.repeat(width)}  ${(r.reason ?? '').slice(0, 160)}`)
  }

  const cost = totalCost(results.map((r) => ({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens })))
  console.log('')
  console.log(`  ${suite.passed} passed · ${suite.failed} failed · ${suite.errored} could not run · model cost ${formatCost(cost)} (indicative)`)

  if (args.junit) {
    fs.writeFileSync(path.resolve(args.junit), await junitXml(suiteId), 'utf8')
    console.log(`  JUnit XML → ${path.resolve(args.junit)}`)
  }
  if (args.report) {
    // Links point into the evidence folder so screenshots resolve from disk.
    const base = `file://${path.join(SERVER_ROOT, 'evidence').replace(/\\/g, '/')}/`
    fs.writeFileSync(path.resolve(args.report), await htmlReport(suiteId, { evidenceBase: base }), 'utf8')
    console.log(`  HTML report → ${path.resolve(args.report)}`)
  }
  if (args.json) {
    const body = { suite, results: results.map((r) => ({ id: r.id, title: r.testCase.title, status: r.status, failureKind: r.failureKind, reason: r.reason })) }
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(body, null, 2), 'utf8')
    console.log(`  JSON → ${path.resolve(args.json)}`)
  }

  if (args.baseUrl) await prisma.project.update({ where: { id: project.id }, data: { baseUrl: originalBaseUrl } })

  // A failure means the application misbehaved; an error means we could not
  // drive it. A build should treat those differently.
  if (suite.failed > 0) exitCode = 1
  else if (suite.errored > 0 && exitCode === 0) exitCode = 2
} catch (e) {
  if (!(e instanceof ExitEarly)) {
    console.error(`\n${(e as Error).message}\n`)
    exitCode = 3
  } else {
    exitCode = 3
  }
} finally {
  await closeSharedBrowser().catch(() => undefined)
  await prisma.$disconnect().catch(() => undefined)
}

process.exit(exitCode)
