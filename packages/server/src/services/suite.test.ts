/**
 * A suite is the unit a build reports on, so its tally has to be right even
 * when a test is retried, quarantined, or fails for a reason that has nothing
 * to do with the application.
 *
 * And the verification replay: a script nobody has ever replayed is a promise,
 * not a test. These check that an unreproducible script is thrown away rather
 * than kept and believed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../db'
import { junitXml } from './reports'
import { recordSuiteResult } from './suiteService'
import { updateFlakiness } from './flakiness'
import { verifyCompiledScript } from './verify'

let projectId: string

const SCRIPT = JSON.stringify({
  version: 1,
  compiledFrom: 'r0',
  compiledAt: new Date().toISOString(),
  expectation: 'pass',
  steps: [{ index: 1, action: { type: 'assertText', text: 'ok' } }],
})

beforeAll(async () => {
  const p = await prisma.project.create({ data: { name: 'Suite bookkeeping', baseUrl: 'http://suite.test/' } })
  projectId = p.id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
})

afterEach(async () => {
  await prisma.testCase.deleteMany({ where: { projectId } })
  await prisma.suiteRun.deleteMany({ where: { projectId } })
})

async function makeCase(title: string, over: Record<string, unknown> = {}) {
  return prisma.testCase.create({ data: { projectId, title, instruction: 'x', script: SCRIPT, ...over } })
}

async function finishedRun(testCaseId: string, suiteRunId: string | null, over: Record<string, unknown> = {}) {
  const run = await prisma.run.create({
    data: { testCaseId, suiteRunId, status: 'passed', verdict: 'pass', mode: 'replay', finishedAt: new Date(), ...over },
  })
  if (suiteRunId) await recordSuiteResult(run.id)
  return run
}

describe('the suite tally', () => {
  it('counts each result once and closes when the last lands', async () => {
    const a = await makeCase('a')
    const b = await makeCase('b')
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 2 } })

    await finishedRun(a.id, suite.id)
    let row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    expect(row).toMatchObject({ passed: 1, failed: 0, status: 'running' })

    await finishedRun(b.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app' })
    row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    expect(row).toMatchObject({ passed: 1, failed: 1, status: 'failed' })
    expect(row.finishedAt).toBeTruthy()
  })

  it('counts a retried test once, by its last attempt', async () => {
    const a = await makeCase('a')
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 1 } })

    const first = await finishedRun(a.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app', attempt: 1 })
    await finishedRun(a.id, suite.id, { status: 'passed', attempt: 2, retryOfId: first.id })

    const row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    // One test, one result: the re-run replaced the failure rather than
    // adding to it, so the totals cannot exceed the number of tests.
    expect(row.passed + row.failed + row.errored).toBe(1)
    expect(row).toMatchObject({ passed: 1, failed: 0, status: 'passed' })
  })

  it('separates "the application failed" from "we could not run it"', async () => {
    const a = await makeCase('a')
    const b = await makeCase('b')
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 2 } })
    await finishedRun(a.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app' })
    await finishedRun(b.id, suite.id, { status: 'error', failureKind: 'tool', reason: 'the page never loaded' })

    const row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    expect(row).toMatchObject({ failed: 1, errored: 1 })
  })

  it('does not let a quarantined test decide the result', async () => {
    const good = await makeCase('good')
    const flaky = await makeCase('flaky', { quarantined: true })
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 2 } })
    await finishedRun(good.id, suite.id)
    await finishedRun(flaky.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app' })

    const row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    expect(row).toMatchObject({ passed: 1, failed: 0, status: 'passed' })
  })

  it('ignores the verification replay entirely', async () => {
    const a = await makeCase('a')
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 1 } })
    await finishedRun(a.id, suite.id)
    await finishedRun(a.id, suite.id, { kind: 'verify', status: 'failed' })

    const row = await prisma.suiteRun.findUniqueOrThrow({ where: { id: suite.id } })
    expect(row).toMatchObject({ passed: 1, failed: 0, status: 'passed' })
  })
})

describe('JUnit output', () => {
  it('reports a failure, an error and a skip the way CI expects', async () => {
    const pass = await makeCase('it works')
    const fail = await makeCase('it is broken')
    const tool = await makeCase('it would not load')
    const quar = await makeCase('it is unreliable', { quarantined: true })
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 4 } })

    await finishedRun(pass.id, suite.id)
    await finishedRun(fail.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app', reason: 'ASSERTION FAILED: the total is wrong', oracle: 'stated-rule' })
    await finishedRun(tool.id, suite.id, { status: 'error', failureKind: 'tool', reason: 'the page never loaded' })
    await finishedRun(quar.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app' })

    const xml = await junitXml(suite.id)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('name="it works"')
    expect(xml).toMatch(/<failure message="[^"]*the total is wrong/)
    expect(xml).toContain('type="ToolFailure"')
    expect(xml).toContain('<skipped message="quarantined')
    // The oracle travels with the failure, so whoever reads the build knows
    // what authority the expectation rested on.
    expect(xml).toContain('Oracle: stated-rule')
  })

  it('escapes characters that would break the document', async () => {
    const tc = await makeCase('a <test> & "quotes"')
    const suite = await prisma.suiteRun.create({ data: { projectId, total: 1 } })
    await finishedRun(tc.id, suite.id, { status: 'failed', verdict: 'fail', failureKind: 'app', reason: 'expected <b> & got "x"' })
    const xml = await junitXml(suite.id)
    expect(xml).toContain('&lt;test&gt;')
    expect(xml).not.toMatch(/name="a <test>/)
  })
})

describe('verifying a freshly compiled script', () => {
  it('marks it deterministic when the replay reproduces the result', async () => {
    const tc = await makeCase('reproducible')
    const authoring = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'ai', status: 'passed', finishedAt: new Date() } })
    await prisma.testCase.update({ where: { id: tc.id }, data: { scriptFromRunId: authoring.id } })
    const verify = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay', kind: 'verify', status: 'passed', finishedAt: new Date() } })

    const r = await verifyCompiledScript(verify.id)
    expect(r.verified).toBe(true)
    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: tc.id } })
    expect(saved.scriptVerifiedAt).toBeTruthy()
    expect(saved.script).toBeTruthy()
  })

  it('throws the script away when the replay does not reproduce it', async () => {
    const tc = await makeCase('not reproducible')
    const authoring = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'ai', status: 'passed', reason: 'verified', finishedAt: new Date() } })
    await prisma.testCase.update({ where: { id: tc.id }, data: { scriptFromRunId: authoring.id } })
    const verify = await prisma.run.create({
      data: { testCaseId: tc.id, mode: 'replay', kind: 'verify', status: 'failed', failureKind: 'tool', reason: 'the element no longer exists', finishedAt: new Date() },
    })

    const r = await verifyCompiledScript(verify.id)
    expect(r.verified).toBe(false)
    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: tc.id } })
    // Kept as AI-driven: slower, but it will not fail for reasons that have
    // nothing to do with the application.
    expect(saved.script).toBeNull()
    expect(saved.scriptVerifiedAt).toBeNull()
    const note = await prisma.run.findUniqueOrThrow({ where: { id: authoring.id } })
    expect(note.reason).toMatch(/did not replay/)
  })

  it('refuses to trust a script whose locators already drifted', async () => {
    const tc = await makeCase('already drifting')
    const verify = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay', kind: 'verify', status: 'passed', healedSteps: 1, finishedAt: new Date() } })
    const r = await verifyCompiledScript(verify.id)
    expect(r.verified).toBe(false)
    expect(r.reason).toMatch(/not stable enough/)
    expect((await prisma.testCase.findUniqueOrThrow({ where: { id: tc.id } })).script).toBeNull()
  })

  it('expects a known-failing script to FAIL in order to be verified', async () => {
    const tc = await makeCase('a recorded defect', { expectation: 'known-failing' })
    const verify = await prisma.run.create({
      data: { testCaseId: tc.id, mode: 'replay', kind: 'verify', status: 'failed', failureKind: 'app', reason: 'Known failure, unchanged', finishedAt: new Date() },
    })
    const r = await verifyCompiledScript(verify.id)
    expect(r.verified).toBe(true)
    expect((await prisma.testCase.findUniqueOrThrow({ where: { id: tc.id } })).scriptVerifiedAt).toBeTruthy()
  })
})

describe('quarantining an unreliable test', () => {
  it('quarantines after two flaky results in the last five, and releases after five stable ones', async () => {
    const tc = await makeCase('unreliable')
    for (let i = 0; i < 2; i++) {
      await prisma.run.create({ data: { testCaseId: tc.id, status: 'passed', flaky: true, finishedAt: new Date() } })
    }
    let r = await updateFlakiness(tc.id)
    expect(r.quarantined).toBe(true)
    expect((await prisma.testCase.findUniqueOrThrow({ where: { id: tc.id } })).quarantined).toBe(true)

    // Five clean runs later it is trusted again. It never stopped running.
    for (let i = 0; i < 5; i++) {
      await prisma.run.create({ data: { testCaseId: tc.id, status: 'passed', flaky: false, finishedAt: new Date() } })
    }
    r = await updateFlakiness(tc.id)
    expect(r.quarantined).toBe(false)
  })

  it('leaves a test that simply fails alone — failing is not flaky', async () => {
    const tc = await makeCase('honestly failing')
    for (let i = 0; i < 5; i++) {
      await prisma.run.create({ data: { testCaseId: tc.id, status: 'failed', failureKind: 'app', flaky: false, finishedAt: new Date() } })
    }
    const r = await updateFlakiness(tc.id)
    expect(r.quarantined).toBe(false)
  })
})
