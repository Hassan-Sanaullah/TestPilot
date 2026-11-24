/**
 * The scheduler, with the engine replaced by a stub. What is being tested is
 * the policy — how many runs may go at once, and which ones must not overlap —
 * so no browser is involved.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Both run functions are mocked: the entry points record when they start and
// finish so the test can watch how many overlap.
const inFlight = { count: 0, peak: 0, aiPeak: 0, aiCount: 0, perProject: new Map<string, number>(), projectPeak: new Map<string, number>() }
const started: string[] = []
let holdMs = 40

function enter(runId: string, projectId: string, ai: boolean) {
  started.push(runId)
  inFlight.count++
  inFlight.peak = Math.max(inFlight.peak, inFlight.count)
  if (ai) {
    inFlight.aiCount++
    inFlight.aiPeak = Math.max(inFlight.aiPeak, inFlight.aiCount)
  }
  const n = (inFlight.perProject.get(projectId) ?? 0) + 1
  inFlight.perProject.set(projectId, n)
  inFlight.projectPeak.set(projectId, Math.max(inFlight.projectPeak.get(projectId) ?? 0, n))
}

function leave(projectId: string, ai: boolean) {
  inFlight.count--
  if (ai) inFlight.aiCount--
  inFlight.perProject.set(projectId, (inFlight.perProject.get(projectId) ?? 1) - 1)
}

async function stub(runId: string, ai: boolean) {
  const { prisma } = await import('../db')
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { testCase: true } })
  enter(runId, run.testCase.projectId, ai)
  try {
    await new Promise((r) => setTimeout(r, holdMs))
    await prisma.run.update({ where: { id: runId }, data: { status: 'passed', verdict: 'pass', finishedAt: new Date() } })
    return { status: 'passed' as const, verdict: 'pass' as const, reason: 'stub' }
  } finally {
    leave(run.testCase.projectId, ai)
  }
}

vi.mock('../engine/replay', () => ({ replayRun: (runId: string) => stub(runId, false) }))
vi.mock('../engine/runner', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, executeRun: (runId: string) => stub(runId, true) }
})

const { prisma } = await import('../db')
const { startRun, cancelRun, isActive, queueState } = await import('./runService')
const { config } = await import('../config')

const SCRIPT = JSON.stringify({
  version: 1,
  compiledFrom: 'x',
  compiledAt: new Date().toISOString(),
  steps: [{ index: 1, action: { type: 'assertText', text: 'x' } }],
})

let parallelProject: string
let serialProject: string

async function makeTests(projectId: string, n: number, withScript = true): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const tc = await prisma.testCase.create({
      data: { projectId, title: `t${i}`, instruction: 'x', script: withScript ? SCRIPT : null },
    })
    out.push(tc.id)
  }
  return out
}

/** Wait until nothing is running or queued. */
async function drain(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = queueState()
    if (s.running === 0 && s.queued === 0) return
    if (Date.now() > deadline) throw new Error(`queue did not drain: ${JSON.stringify(s)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  const a = await prisma.project.create({ data: { name: 'parallel project', baseUrl: 'http://127.0.0.1:1/', parallel: true } })
  const b = await prisma.project.create({ data: { name: 'serial project', baseUrl: 'http://127.0.0.1:2/', resetUrl: 'http://127.0.0.1:2/__reset' } })
  parallelProject = a.id
  serialProject = b.id
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [parallelProject, serialProject] } } })
  await prisma.$disconnect()
})

beforeEach(() => {
  inFlight.count = 0
  inFlight.peak = 0
  inFlight.aiCount = 0
  inFlight.aiPeak = 0
  inFlight.perProject.clear()
  inFlight.projectPeak.clear()
  started.length = 0
  holdMs = 40
})

afterEach(async () => {
  await drain()
})

describe('run scheduling', () => {
  it('runs several replays at once, up to the total limit', async () => {
    const ids = await makeTests(parallelProject, 6)
    await Promise.all(ids.map((id) => startRun(id)))
    await drain()
    expect(started.length).toBe(6)
    expect(inFlight.peak).toBeGreaterThan(1)
    expect(inFlight.peak).toBeLessThanOrEqual(config.runConcurrency)
  })

  it('holds AI authoring runs to the lower AI limit', async () => {
    const ids = await makeTests(parallelProject, 4, false) // no script -> ai mode
    await Promise.all(ids.map((id) => startRun(id)))
    await drain()
    expect(started.length).toBe(4)
    expect(inFlight.aiPeak).toBeLessThanOrEqual(config.aiConcurrency)
  })

  it('never overlaps two tests of a project that resets shared data', async () => {
    const serial = await makeTests(serialProject, 3)
    const parallel = await makeTests(parallelProject, 3)
    await Promise.all([...serial, ...parallel].map((id) => startRun(id)))
    await drain()
    expect(inFlight.projectPeak.get(serialProject)).toBe(1)
    // and the serial project did not stall the other one
    expect(inFlight.projectPeak.get(parallelProject)).toBeGreaterThan(1)
    expect(started.length).toBe(6)
  })

  it('cancels a queued run without starting it', async () => {
    // Long enough that the first four keep their slots while we cancel the
    // sixth: otherwise a slot frees up and it starts legitimately.
    holdMs = 1500
    const ids = await makeTests(parallelProject, config.runConcurrency + 2)
    // Sequentially, so the last one is reliably still in the queue: started
    // together, any of them could be the one that got a slot.
    const runs = []
    for (const id of ids) runs.push(await startRun(id))
    const last = runs[runs.length - 1]
    expect(isActive(last.id)).toBe(true)
    expect(cancelRun(last.id)).toBe(true)
    await drain()
    // cancelRun answers the caller immediately and writes the row behind it.
    let row = await prisma.run.findUniqueOrThrow({ where: { id: last.id } })
    for (let i = 0; i < 40 && row.status !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 25))
      row = await prisma.run.findUniqueOrThrow({ where: { id: last.id } })
    }
    expect(row.status).toBe('cancelled')
    expect(started).not.toContain(last.id)
  })
})
