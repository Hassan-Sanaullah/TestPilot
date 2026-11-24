/**
 * Run orchestration: queueing, cancellation, and the post-run policy
 * (re-run once on failure; file a bug when the failure is confirmed).
 *
 * Runs execute several at a time. The old scheduler ran exactly one, which made
 * a suite of twenty tests take twenty times one test — and most of that time
 * was a browser waiting for a network round trip, not CPU. Two limits keep that
 * honest: a total cap, and a lower cap on AI-authoring runs, which share a
 * free-tier LLM quota and are the only ones that can be rate-limited.
 *
 * One ordering rule matters: a project with a reset hook wipes shared data at
 * the start of every run, so two of its tests running together would pull the
 * ground out from under each other. Such a project runs one test at a time
 * while other projects carry on alongside it.
 */
import { isReplayable } from '@testpilot/shared'
import { config } from '../config'
import { prisma } from '../db'
import { replayRun } from '../engine/replay'
import { executeRun, type RunControl } from '../engine/runner'
import { fileBugReport, fileServerErrorBug } from '../ai/bugs'
import { HttpError } from '../http'
import { recordSuiteResult } from './suiteService'
import { verifyCompiledScript } from './verify'
import { updateFlakiness } from './flakiness'

interface Queued {
  runId: string
  projectId: string
  mode: 'ai' | 'replay'
  /** this project must run one test at a time */
  serial: boolean
  /** force headless (suite runs); undefined = follow config */
  headless?: boolean
  /** set for a run started as part of a suite */
  suiteRunId?: string
}

const controls = new Map<string, RunControl>()
const queue: Queued[] = []
const running = new Map<string, Queued>()

export interface StartRunOptions {
  attempt?: number
  retryOfId?: string
  mode?: 'ai' | 'replay' | 'auto'
  /** run headless whatever the config says — suites open no windows */
  headless?: boolean
  /** the suite this run belongs to */
  suiteRunId?: string
  /** ignore the project's parallel setting and run this one alone */
  serial?: boolean
  kind?: string
}

/**
 * Start a run. A test that has been compiled replays deterministically with no
 * AI; `mode: 'ai'` forces re-authoring, which is what you want after the
 * application has genuinely changed.
 */
export async function startRun(testCaseId: string, opts: StartRunOptions = {}) {
  const tc = await prisma.testCase.findUnique({ where: { id: testCaseId }, include: { project: { select: { id: true, resetUrl: true, parallel: true } } } })
  if (!tc) throw new HttpError(404, 'test case not found')

  let script: unknown = null
  try {
    script = tc.script ? JSON.parse(tc.script) : null
  } catch {
    script = null
  }
  const wanted = opts.mode ?? 'auto'
  const mode: 'ai' | 'replay' = wanted === 'ai' ? 'ai' : isReplayable(script) ? 'replay' : 'ai'

  const run = await prisma.run.create({
    data: {
      testCaseId,
      attempt: opts.attempt ?? 1,
      retryOfId: opts.retryOfId ?? null,
      mode,
      suiteRunId: opts.suiteRunId ?? null,
      kind: opts.kind ?? 'normal',
    },
  })
  controls.set(run.id, { cancelled: false, headless: opts.headless })
  queue.push({
    runId: run.id,
    projectId: tc.project.id,
    mode,
    // A reset hook wipes shared data at the start of each run.
    serial: opts.serial ?? (Boolean(tc.project.resetUrl) || !tc.project.parallel),
    headless: opts.headless,
    suiteRunId: opts.suiteRunId,
  })
  pump()
  return run
}

export function cancelRun(runId: string): boolean {
  const c = controls.get(runId)
  if (!c) return false
  c.cancelled = true
  const qi = queue.findIndex((q) => q.runId === runId)
  if (qi >= 0) {
    queue.splice(qi, 1)
    void prisma.run
      .update({ where: { id: runId }, data: { status: 'cancelled', reason: 'cancelled before start', finishedAt: new Date() } })
      .catch(() => undefined)
    controls.delete(runId)
    return true
  }
  // Closing the context stops the run at its next await; the browser is shared
  // with other runs and must stay open.
  void c.context?.close().catch(() => undefined)
  return true
}

export function isActive(runId: string): boolean {
  return running.has(runId) || queue.some((q) => q.runId === runId)
}

/** Queue depth and in-flight count, for the dashboard. */
export function queueState(): { running: number; queued: number; limits: { total: number; ai: number } } {
  return { running: running.size, queued: queue.length, limits: { total: config.runConcurrency, ai: config.aiConcurrency } }
}

function canStart(q: Queued): boolean {
  if (running.size >= config.runConcurrency) return false
  if (q.mode === 'ai' && [...running.values()].filter((r) => r.mode === 'ai').length >= config.aiConcurrency) return false
  const sameProject = [...running.values()].filter((r) => r.projectId === q.projectId)
  if (sameProject.length && (q.serial || sameProject.some((r) => r.serial))) return false
  return true
}

/**
 * Start everything that can start. Scanning with skipping rather than taking
 * strictly from the front, so one blocked serial project does not stall the
 * queue behind it.
 */
function pump(): void {
  for (let i = 0; i < queue.length; ) {
    const q = queue[i]
    if (canStart(q)) {
      queue.splice(i, 1)
      void launch(q)
    } else {
      i++
    }
  }
}

async function launch(q: Queued): Promise<void> {
  running.set(q.runId, q)
  const control = controls.get(q.runId) ?? { cancelled: false, headless: q.headless }
  try {
    const outcome = q.mode === 'replay' ? await replayRun(q.runId, control) : await executeRun(q.runId, control)
    await afterRun(q.runId, outcome.status)
  } catch (e) {
    console.error('[run] unexpected failure', e)
  } finally {
    controls.delete(q.runId)
    running.delete(q.runId)
    pump()
  }
}

async function afterRun(runId: string, status: string): Promise<void> {
  const run = await prisma.run.findUnique({ where: { id: runId }, include: { testCase: { include: { project: true } } } })
  if (!run) return
  const project = run.testCase.project

  // A verification replay exists only to answer "does the script we just
  // compiled actually reproduce?". It never files bugs, never retries, and
  // never counts towards a suite.
  if (run.kind === 'verify') {
    await verifyCompiledScript(run.id).catch((e) => console.warn('[verify] could not record the result:', (e as Error).message))
    return
  }

  // A known failure that failed where it was recorded to fail is the expected,
  // deterministic result. Re-running it proves nothing and costs a browser.
  const asExpected = run.testCase.expectation === 'known-failing' && (run.reason ?? '').startsWith('Known failure, unchanged')
  const willRetry = status === 'failed' && !asExpected && run.attempt === 1 && project.retryOnFail && run.failureKind !== 'tool' && !(run.reason ?? '').startsWith('invalid_step')

  // Only a FINAL result counts towards a suite. Tallying an attempt that is
  // about to be re-run would close the suite on a failure that the retry then
  // overturns, and the retry's pass would arrive to a suite already finished.
  if (!willRetry) {
    await updateFlakiness(run.testCaseId).catch(() => undefined)
    await recordSuiteResult(runId).catch((e) => console.warn('[suite] could not record the result:', (e as Error).message))
  }

  if (willRetry) {
    // Flakiness control: re-run once before trusting the failure. The retry
    // runs alone, so a failure caused by another test touching the same data
    // cannot repeat — which is also how we learn that was the cause.
    await startRun(run.testCaseId, { attempt: 2, retryOfId: run.id, suiteRunId: run.suiteRunId ?? undefined, serial: true, mode: run.mode as 'ai' | 'replay' })
    return
  }
  // A script was just compiled by this run: check once, now, that it really
  // replays. A script nobody has ever replayed is a promise, not a test.
  if ((status === 'passed' || status === 'failed') && run.mode === 'ai') {
    const tc = await prisma.testCase.findUnique({ where: { id: run.testCaseId }, select: { script: true, scriptFromRunId: true, scriptVerifiedAt: true } })
    if (tc?.script && tc.scriptFromRunId === runId && !tc.scriptVerifiedAt) {
      await startRun(run.testCaseId, { mode: 'replay', kind: 'verify', headless: true, serial: true }).catch((e) =>
        console.warn('[verify] could not queue a verification replay:', (e as Error).message),
      )
    }
  }

  if (status === 'passed' && run.attempt === 2 && run.retryOfId) {
    const first = await prisma.run.findUnique({ where: { id: run.retryOfId }, select: { suiteRunId: true } })
    await prisma.run.update({
      where: { id: run.retryOfId },
      // The retry ran alone and passed. When the first attempt was part of a
      // parallel suite, the most likely cause is interference between tests,
      // and saying so is more useful than the word "flaky" on its own.
      data: { flaky: true, flakyCause: first?.suiteRunId ? 'parallel' : 'unknown' },
    })
    return
  }
  if (status === 'passed') {
    // The test works again. Do not close anything automatically — the user
    // decides that — but say so, so the bug page can offer it.
    await prisma.bugReport
      .updateMany({ where: { testCaseId: run.testCaseId, status: 'open', passingSince: null }, data: { passingSince: new Date() } })
      .catch(() => undefined)
    // A test can pass while the server is quietly returning 500s behind it.
    // Nothing was asserting that, so nothing would otherwise have noticed.
    try {
      await fileServerErrorBug(runId)
    } catch (e) {
      console.warn('[run] could not file a server-error report:', (e as Error).message)
    }
  }
  if (status === 'failed') {
    // Only the application misbehaving earns a bug report. A run that failed
    // because TestPilot could not drive the browser says nothing about the
    // application, and filing it would bury real defects under noise.
    if (run.failureKind === 'tool') {
      console.warn(`[run] ${run.id} failed for tooling reasons (${run.reason}); not filing a bug report`)
      return
    }
    try {
      await fileBugReport(run.id)
    } catch (e) {
      console.error('[run] bug report failed', e)
    }
  }
}
