import { Router } from 'express'
import { z } from 'zod'
import { reviewInstruction } from '../ai/lint'
import { generateTests } from '../ai/suite'
import { toPlaywrightSpec, toProjectSpec } from '../engine/script'
import { prisma } from '../db'
import { HttpError, h, parseBody } from '../http'
import { startRun } from '../services/runService'

export const testcases = Router()

const Body = z.object({ title: z.string().min(1).max(160), instruction: z.string().min(5).max(4000) })

/**
 * The design metadata a generated test carries. All optional, because a test
 * typed by hand has none of it — but when it IS present it is what makes
 * coverage computable, filtering possible and a bug report able to quote the
 * rule it rests on, so it must survive the save.
 */
const Meta = z.object({
  kind: z.enum(['happy-path', 'negative', 'edge', 'flow']).optional(),
  technique: z.string().max(40).optional(),
  area: z.string().max(40).optional(),
  targetUrl: z.string().max(2000).optional(),
  targetForm: z.string().max(200).optional(),
  targetField: z.string().max(200).optional(),
  designKey: z.string().max(64).optional(),
  oracle: z.enum(['specified', 'stated-rule', 'implicit']).optional(),
  oracleText: z.string().max(400).optional(),
  auth: z.enum(['auto', 'anonymous', 'signed-in']).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  /** requirement keys this test is evidence for */
  requirementKeys: z.array(z.string().max(40)).max(20).optional(),
})

const BodyWithMeta = Body.merge(Meta)

/** Split a saved test into its row fields and the requirement links to create. */
function splitMeta(t: z.infer<typeof BodyWithMeta>) {
  const { requirementKeys, ...row } = t
  return { row, requirementKeys: requirementKeys ?? [] }
}

/**
 * Record which requirements a test is evidence for, once, at save time.
 *
 * Storing the link is what lets coverage be COMPUTED from results later
 * instead of being re-judged by a model on every profile — which is why the
 * same suite used to score differently on two consecutive runs.
 */
async function linkRequirements(projectId: string, testCaseId: string, keys: string[], source = 'generated'): Promise<number> {
  if (keys.length === 0) return 0
  const reqs = await prisma.requirement.findMany({ where: { projectId, key: { in: keys } }, select: { id: true } })
  let n = 0
  for (const r of reqs) {
    await prisma.testRequirement
      .upsert({
        where: { testCaseId_requirementId: { testCaseId, requirementId: r.id } },
        create: { testCaseId, requirementId: r.id, source, confirmed: true },
        update: { source, confirmed: true },
      })
      .then(() => n++)
      .catch(() => undefined)
  }
  return n
}

/** Review an instruction before it is saved or run. */
testcases.post(
  '/projects/:id/testcases/review',
  h(async (req, res) => {
    const { instruction, ai } = parseBody(z.object({ instruction: z.string().min(1).max(4000), ai: z.boolean().optional() }), req.body)
    res.json(await reviewInstruction(req.params.id, instruction, ai !== false))
  }),
)

/**
 * Turn a few words — or nothing — into a set of complete test cases.
 * Returns drafts; nothing is saved until the user accepts them.
 */
testcases.post(
  '/projects/:id/testcases/generate',
  h(async (req, res) => {
    const { prompt, explore } = parseBody(z.object({ prompt: z.string().max(500).optional(), explore: z.boolean().optional() }), req.body ?? {})
    res.json(await generateTests(req.params.id, { prompt, explore }))
  }),
)

/** Save several test cases at once, optionally running them immediately. */
testcases.post(
  '/projects/:id/testcases/bulk',
  h(async (req, res) => {
    const { tests, run } = parseBody(
      z.object({ tests: z.array(BodyWithMeta).min(1).max(40), run: z.boolean().optional() }),
      req.body,
    )
    const project = await prisma.project.findUnique({ where: { id: req.params.id } })
    if (!project) throw new HttpError(404, 'project not found')

    const created = []
    const skipped: string[] = []
    for (const t of tests) {
      const { row, requirementKeys } = splitMeta(t)
      // A design key is unique per project, so re-accepting the same designed
      // test cannot create a second copy of it.
      if (row.designKey) {
        const clash = await prisma.testCase.findFirst({ where: { projectId: project.id, designKey: row.designKey }, select: { title: true } })
        if (clash) {
          skipped.push(row.title)
          continue
        }
      }
      const tc = await prisma.testCase.create({ data: { ...row, projectId: project.id, origin: 'generated' } })
      await linkRequirements(project.id, tc.id, requirementKeys)
      created.push(tc)
    }
    const runs = []
    if (run) for (const tc of created) runs.push(await startRun(tc.id))
    res.status(201).json({ created, runs, skipped })
  }),
)

testcases.get(
  '/projects/:id/testcases',
  h(async (req, res) => {
    const rows = await prisma.testCase.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { runs: true } },
        links: { include: { requirement: { select: { key: true, text: true } } } },
      },
    })
    // The compiled script can be long; the list only needs to know it exists.
    res.json(
      rows.map(({ script, links, ...rest }) => ({
        ...rest,
        hasScript: Boolean(script),
        scriptSteps: script ? (JSON.parse(script).steps?.length ?? 0) : 0,
        requirements: links.map((l) => ({ key: l.requirement.key, text: l.requirement.text, confirmed: l.confirmed, source: l.source })),
      })),
    )
  }),
)

testcases.post(
  '/projects/:id/testcases',
  h(async (req, res) => {
    const data = parseBody(BodyWithMeta, req.body)
    const project = await prisma.project.findUnique({ where: { id: req.params.id } })
    if (!project) throw new HttpError(404, 'project not found')
    const { row: fields, requirementKeys } = splitMeta(data)
    const row = await prisma.testCase.create({ data: { ...fields, projectId: project.id } })
    await linkRequirements(project.id, row.id, requirementKeys, 'manual')
    res.status(201).json(row)
  }),
)

testcases.put(
  '/testcases/:id',
  h(async (req, res) => {
    const data = parseBody(Body.partial(), req.body)
    res.json(await prisma.testCase.update({ where: { id: req.params.id }, data }))
  }),
)

testcases.delete(
  '/testcases/:id',
  h(async (req, res) => {
    await prisma.testCase.delete({ where: { id: req.params.id } })
    res.status(204).end()
  }),
)

testcases.post(
  '/testcases/:id/run',
  h(async (req, res) => {
    const { mode } = parseBody(z.object({ mode: z.enum(['auto', 'ai', 'replay']).optional() }), req.body ?? {})
    const run = await startRun(req.params.id, { mode })
    res.status(202).json(run)
  }),
)

/** The compiled script: what a replay will do, with no AI involved. */
testcases.get(
  '/testcases/:id/script',
  h(async (req, res) => {
    const tc = await prisma.testCase.findUnique({ where: { id: req.params.id } })
    if (!tc) throw new HttpError(404, 'test case not found')
    res.json({ script: tc.script ? JSON.parse(tc.script) : null, updatedAt: tc.scriptUpdatedAt, fromRunId: tc.scriptFromRunId })
  }),
)

/** Export as an ordinary Playwright spec, for running in CI. */
testcases.get(
  '/testcases/:id/spec',
  h(async (req, res) => {
    const tc = await prisma.testCase.findUnique({ where: { id: req.params.id }, include: { project: true } })
    if (!tc) throw new HttpError(404, 'test case not found')
    if (!tc.script) throw new HttpError(400, 'This test has no compiled script yet — run it once so TestPilot can record one.')
    const spec = toPlaywrightSpec(tc.title, tc.project.baseUrl, JSON.parse(tc.script))
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${tc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spec.ts"`)
    res.send(spec)
  }),
)

/**
 * Every compiled test of a project as one Playwright spec file.
 *
 * This is the exit door. A team that adopts TestPilot and later wants to own
 * its tests outright gets ordinary Playwright code, with no runtime dependency
 * on this project at all.
 */
testcases.get(
  '/projects/:id/spec',
  h(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } })
    if (!project) throw new HttpError(404, 'project not found')
    const rows = await prisma.testCase.findMany({
      where: { projectId: project.id, script: { not: null }, quarantined: false },
      orderBy: { createdAt: 'asc' },
      select: { title: true, script: true, expectation: true },
    })
    if (rows.length === 0) throw new HttpError(400, 'No test in this project has been authored yet — run one so TestPilot can record its steps.')
    const cases = rows.map((r) => ({ title: r.title, script: JSON.parse(r.script!), expectation: r.expectation }))
    const spec = toProjectSpec(project.name, project.baseUrl, cases)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spec.ts"`)
    res.send(spec)
  }),
)

/** Forget the script so the next run re-authors it with the AI. */
testcases.delete(
  '/testcases/:id/script',
  h(async (req, res) => {
    await prisma.testCase.update({ where: { id: req.params.id }, data: { script: null, scriptUpdatedAt: null, scriptFromRunId: null } })
    res.status(204).end()
  }),
)

testcases.post(
  '/projects/:id/run-all',
  h(async (req, res) => {
    const cases = await prisma.testCase.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'asc' } })
    const runs = []
    for (const tc of cases) runs.push(await startRun(tc.id))
    res.status(202).json(runs)
  }),
)
