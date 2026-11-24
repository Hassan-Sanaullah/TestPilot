/**
 * A suite run: one press of "run all", and the unit a build system reports on.
 *
 * Without this there was no such thing as "the result" — only a list of
 * individual runs that a person had to eyeball and total up themselves. A build
 * needs one number, one exit code and one report.
 */
import { isReplayable } from '@testpilot/shared'
import { prisma } from '../db'
import { runEvents } from '../events'
import { HttpError } from '../http'
import { startRun } from './runService'

export interface StartSuiteOptions {
  /** limit the suite to these tests; default is every test in the project */
  testCaseIds?: string[]
  mode?: 'auto' | 'ai' | 'replay'
  /** only run tests that already have a compiled script (what a build wants) */
  compiledOnly?: boolean
}

export interface SuiteStart {
  suiteRun: { id: string; total: number }
  /** tests that were not run, and why */
  skipped: { testCaseId: string; title: string; reason: string }[]
}

export async function startSuite(projectId: string, opts: StartSuiteOptions = {}): Promise<SuiteStart> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new HttpError(404, 'project not found')

  const cases = await prisma.testCase.findMany({
    where: { projectId, ...(opts.testCaseIds?.length ? { id: { in: opts.testCaseIds } } : {}) },
    orderBy: { createdAt: 'asc' },
  })
  if (cases.length === 0) throw new HttpError(400, 'this project has no test cases to run')

  const skipped: SuiteStart['skipped'] = []
  const toRun = cases.filter((tc) => {
    if (!opts.compiledOnly) return true
    let script: unknown = null
    try {
      script = tc.script ? JSON.parse(tc.script) : null
    } catch {
      script = null
    }
    if (isReplayable(script)) return true
    // A test nobody has authored yet cannot fail a build; it is simply not
    // ready. Saying so is more useful than failing.
    skipped.push({ testCaseId: tc.id, title: tc.title, reason: 'not authored yet — no compiled script' })
    return false
  })

  if (toRun.length === 0) throw new HttpError(400, 'none of the selected tests have been authored yet')

  const suiteRun = await prisma.suiteRun.create({ data: { projectId, total: toRun.length } })
  runEvents.publish({ type: 'suite.started', suiteRunId: suiteRun.id, projectId, total: toRun.length })

  for (const tc of toRun) {
    // Suites always run headless: four visible browser windows fighting for
    // the screen is not a feature.
    await startRun(tc.id, { suiteRunId: suiteRun.id, headless: true, mode: opts.mode })
  }
  return { suiteRun: { id: suiteRun.id, total: toRun.length }, skipped }
}

/**
 * Fold one finished run into its suite's tally, and close the suite when the
 * last one lands.
 *
 * Only the LAST attempt of a test counts: a failure that passed on its
 * automatic re-run is flaky, not a failure, and counting both would make the
 * totals exceed the number of tests.
 */
export async function recordSuiteResult(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, suiteRunId: true, status: true, testCaseId: true, testCase: { select: { quarantined: true } } },
  })
  if (!run?.suiteRunId) return

  const suite = await prisma.suiteRun.findUnique({ where: { id: run.suiteRunId } })
  // A cancelled suite keeps its numbers; everything else is recounted, so a
  // result that arrives after the suite looked finished still corrects it.
  if (!suite || suite.status === 'cancelled') return

  // Tally from the rows rather than incrementing counters: the retry policy can
  // add a run after the fact, and a recount is always right.
  const runs = await prisma.run.findMany({
    where: { suiteRunId: run.suiteRunId, kind: 'normal' },
    orderBy: [{ attempt: 'asc' }, { createdAt: 'asc' }],
    select: { testCaseId: true, attempt: true, status: true, failureKind: true, testCase: { select: { quarantined: true } } },
  })
  // The later ATTEMPT is the result, not the later timestamp: a retry can be
  // created in the same millisecond as the attempt it replaces, and ordering by
  // time alone would then sometimes tally the failure that was already
  // superseded.
  const latest = new Map<string, (typeof runs)[number]>()
  for (const r of runs) {
    const prev = latest.get(r.testCaseId)
    if (!prev || r.attempt >= prev.attempt) latest.set(r.testCaseId, r)
  }

  let passed = 0
  let failed = 0
  let errored = 0
  let quarantined = 0
  for (const r of latest.values()) {
    if (r.status === 'queued' || r.status === 'running') continue
    if (r.testCase.quarantined) {
      // It still runs and its result is shown, but a test known to be
      // unreliable must not decide whether the build is broken.
      quarantined++
      continue
    }
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else errored++
  }

  const decided = passed + failed + errored + quarantined
  const done = decided >= suite.total
  const status = !done ? 'running' : failed > 0 ? 'failed' : errored > 0 ? 'failed' : 'passed'

  await prisma.suiteRun.update({
    where: { id: suite.id },
    data: { passed, failed, errored, status, ...(done ? { finishedAt: new Date() } : {}) },
  })
  runEvents.publish({ type: 'suite.progress', suiteRunId: suite.id, passed, failed, errored, total: suite.total })
  if (done) runEvents.publish({ type: 'suite.done', suiteRunId: suite.id, status, passed, failed, errored, total: suite.total })
}

/** Cancel every run still in flight for a suite. */
export async function cancelSuite(suiteRunId: string): Promise<number> {
  const { cancelRun } = await import('./runService')
  const runs = await prisma.run.findMany({ where: { suiteRunId, status: { in: ['queued', 'running'] } }, select: { id: true } })
  let n = 0
  for (const r of runs) if (cancelRun(r.id)) n++
  await prisma.suiteRun.update({ where: { id: suiteRunId }, data: { status: 'cancelled', finishedAt: new Date() } }).catch(() => undefined)
  return n
}

export interface SuiteSummary {
  id: string
  projectId: string
  status: string
  total: number
  passed: number
  failed: number
  errored: number
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

export const toSuiteDto = (s: {
  id: string
  projectId: string
  status: string
  total: number
  passed: number
  failed: number
  errored: number
  startedAt: Date
  finishedAt: Date | null
}): SuiteSummary => ({
  id: s.id,
  projectId: s.projectId,
  status: s.status,
  total: s.total,
  passed: s.passed,
  failed: s.failed,
  errored: s.errored,
  startedAt: s.startedAt.toISOString(),
  finishedAt: s.finishedAt?.toISOString() ?? null,
  durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
})
