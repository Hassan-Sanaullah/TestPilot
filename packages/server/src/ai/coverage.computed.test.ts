/**
 * Coverage as arithmetic.
 *
 * The thing being tested is that the same data always gives the same answer —
 * the property the model-judged version could not offer — and that a
 * requirement whose test is FAILING is called out as violated rather than
 * lumped in with "partly tested", which is where it used to disappear.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../db'
import { computeCoverage } from './traceability'
import { computeStructuralCoverage } from './structural'

let projectId: string

beforeAll(async () => {
  const p = await prisma.project.create({ data: { name: 'Computed coverage', baseUrl: 'http://cov.test/' } })
  projectId = p.id
  await prisma.appPage.create({
    data: {
      projectId,
      url: 'http://cov.test/register',
      title: 'Register',
      kind: 'auth',
      forms: JSON.stringify([
        {
          name: 'register',
          submitLabel: 'Create account',
          fields: [
            { label: 'Email', type: 'email', required: true, hint: '' },
            { label: 'Password', type: 'password', required: true, hint: '', minLength: 8 },
          ],
        },
      ]),
      actions: '[]',
      rules: JSON.stringify(['At least 8 characters']),
      headings: '[]',
      samples: '[]',
      reachedVia: 'start',
    },
  })
  await prisma.appPage.create({
    data: { projectId, url: 'http://cov.test/orders', title: 'Orders', kind: 'listing', forms: '[]', actions: '[]', rules: '[]', headings: '[]', samples: '[]', reachedVia: 'start' },
  })
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
})

afterEach(async () => {
  await prisma.testCase.deleteMany({ where: { projectId } })
  await prisma.requirement.deleteMany({ where: { projectId } })
})

/** A requirement, a test linked to it, and that test's latest run. */
async function scenario(opts: {
  runStatus?: 'passed' | 'failed'
  failureKind?: 'app' | 'tool'
  confirmed?: boolean
  quarantined?: boolean
  substantive?: boolean
  noRun?: boolean
}) {
  const req = await prisma.requirement.create({ data: { projectId, key: 'R1', text: 'Registration refuses a short password', ruleText: 'At least 8 characters' } })
  const tc = await prisma.testCase.create({
    data: { projectId, title: 'Short password is refused', instruction: 'x', quarantined: opts.quarantined ?? false, oracleText: 'At least 8 characters' },
  })
  await prisma.testRequirement.create({ data: { testCaseId: tc.id, requirementId: req.id, confirmed: opts.confirmed ?? true, source: 'generated' } })
  if (!opts.noRun) {
    const run = await prisma.run.create({
      data: {
        testCaseId: tc.id,
        status: opts.runStatus ?? 'passed',
        verdict: opts.runStatus === 'failed' ? 'fail' : 'pass',
        failureKind: opts.failureKind ?? null,
        finishedAt: new Date(),
      },
    })
    await prisma.step.create({
      data: {
        runId: run.id,
        index: 1,
        // A content assertion is what makes a pass mean something; a bare
        // visibility check on a pre-existing element does not.
        action: JSON.stringify(opts.substantive === false ? { type: 'assertVisible', index: 2 } : { type: 'assertText', text: 'must be at least 8 characters' }),
        status: 'ok',
      },
    })
  }
  return { req, tc }
}

describe('requirement coverage', () => {
  it('calls a requirement covered when its test passes and verified something', async () => {
    await scenario({ runStatus: 'passed' })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('covered')
    expect(r.summary.covered).toBe(1)
  })

  it('calls it VIOLATED when its test fails because the application is wrong', async () => {
    await scenario({ runStatus: 'failed', failureKind: 'app' })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('violated')
    expect(r.rows[0].rationale).toMatch(/does not satisfy/)
    // And it is the first thing shown.
    expect(r.rows[0].key).toBe('R1')
  })

  it('ignores a failure that was TestPilot failing to drive the browser', async () => {
    await scenario({ runStatus: 'failed', failureKind: 'tool' })
    const r = await computeCoverage(projectId)
    // A tool failure says nothing about the application, so the requirement is
    // not violated — it is simply not verified.
    expect(r.rows[0].status).toBe('partial')
  })

  it('calls it partly tested when the only passing run verified nothing', async () => {
    await scenario({ runStatus: 'passed', substantive: false })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('partial')
    expect(r.rows[0].rationale).toMatch(/no passing test verifies/)
  })

  it('calls it partly tested when the linked test has never run', async () => {
    await scenario({ noRun: true })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('partial')
  })

  it('ignores a link nobody has confirmed', async () => {
    await scenario({ runStatus: 'passed', confirmed: false })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('uncovered')
    expect(r.rows[0].rationale).toMatch(/none has been confirmed/)
    // The suggestion is still listed, so the user can accept it.
    expect(r.rows[0].tests[0].confirmed).toBe(false)
  })

  it('ignores a quarantined test', async () => {
    await scenario({ runStatus: 'passed', quarantined: true })
    const r = await computeCoverage(projectId)
    expect(r.rows[0].status).toBe('partial')
    expect(r.rows[0].rationale).toMatch(/quarantined/)
  })

  it('gives the same answer twice for the same data', async () => {
    await scenario({ runStatus: 'failed', failureKind: 'app' })
    const a = await computeCoverage(projectId)
    const b = await computeCoverage(projectId)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('reports no requirements rather than failing when there are none', async () => {
    const r = await computeCoverage(projectId)
    expect(r.total).toBe(0)
    expect(r.rows).toEqual([])
  })
})

describe('structural coverage', () => {
  /** A run whose steps fill and submit the registration form. */
  async function runWithSteps(steps: { action: object; url: string; locator?: string }[]) {
    const tc = await prisma.testCase.create({ data: { projectId, title: 'Registration works', instruction: 'x' } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id, status: 'passed', verdict: 'pass', finishedAt: new Date() } })
    for (const [i, s] of steps.entries()) {
      await prisma.step.create({
        data: { runId: run.id, index: i + 1, action: JSON.stringify(s.action), status: 'ok', url: s.url, locator: s.locator ? JSON.stringify({ description: s.locator, candidate: { by: 'text', value: s.locator } }) : null },
      })
    }
    return tc
  }

  it('counts a form only when something was entered AND it was submitted', async () => {
    await runWithSteps([
      { action: { type: 'type', index: 1, text: 'a@b.com' }, url: 'http://cov.test/register', locator: 'textbox Email' },
      { action: { type: 'type', index: 2, text: 'Tp1!abcdefgh' }, url: 'http://cov.test/register', locator: 'textbox Password' },
      { action: { type: 'click', index: 3 }, url: 'http://cov.test/register', locator: 'button Create account' },
    ])
    const s = await computeStructuralCoverage(projectId)
    expect(s.forms).toMatchObject({ covered: 1, total: 1 })
    expect(s.fields).toMatchObject({ covered: 2, total: 2 })
    expect(s.pages.covered).toBe(1)
    expect(s.pages.total).toBe(2)
  })

  it('does not count a form that was filled in but never submitted', async () => {
    await runWithSteps([{ action: { type: 'type', index: 1, text: 'a@b.com' }, url: 'http://cov.test/register', locator: 'textbox Email' }])
    const s = await computeStructuralCoverage(projectId)
    expect(s.forms.covered).toBe(0)
    expect(s.fields.covered).toBe(1)
    expect(s.forms.missing.join(' ')).toMatch(/never submitted/)
  })

  it('counts only the page when a test merely opens it', async () => {
    await runWithSteps([{ action: { type: 'assertText', text: 'Register' }, url: 'http://cov.test/register' }])
    const s = await computeStructuralCoverage(projectId)
    expect(s.pages.covered).toBe(1)
    expect(s.forms.covered).toBe(0)
    expect(s.fields.covered).toBe(0)
  })

  it('counts a stated rule as checked when a test quotes it', async () => {
    await prisma.testCase.create({ data: { projectId, title: 'Password rule', instruction: 'x', oracleText: 'At least 8 characters' } })
    const tc = await prisma.testCase.findFirstOrThrow({ where: { projectId, oracleText: 'At least 8 characters' } })
    await prisma.run.create({ data: { testCaseId: tc.id, status: 'passed', verdict: 'pass', finishedAt: new Date() } })
    const s = await computeStructuralCoverage(projectId)
    expect(s.rules).toMatchObject({ covered: 1, total: 1 })
  })

  it('lists what is missing so the number is actionable', async () => {
    const s = await computeStructuralCoverage(projectId)
    expect(s.pages.missing.length).toBeGreaterThan(0)
    expect(s.overall).toBeGreaterThanOrEqual(0)
    expect(s.overall).toBeLessThanOrEqual(100)
  })
})
