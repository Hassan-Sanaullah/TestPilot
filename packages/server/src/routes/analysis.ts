/** Coverage (M4), gaps (M5) and bug reports. */
import { Router } from 'express'
import { z } from 'zod'
import { bugMarkdown } from '../ai/bugs'
import { profileCoverage } from '../ai/coverage'
import { generateGaps } from '../ai/gaps'
import { computeStructuralCoverage } from '../ai/structural'
import { computeCoverage, decideLink, proposeLinks, saveCoverageProfile } from '../ai/traceability'
import { json, prisma } from '../db'
import { HttpError, h, parseBody } from '../http'
import { parallelInterference } from '../services/flakiness'
import { startRun } from '../services/runService'

export const analysis = Router()

// ---- Coverage ---------------------------------------------------------------

/**
 * Coverage, computed from the stored test-to-requirement links and the run
 * results. No model, so the same data always gives the same answer.
 *
 * `?mode=llm` keeps the old model-judged version available, which the
 * evaluation needs as a comparison arm.
 */
analysis.get(
  '/projects/:id/coverage/computed',
  h(async (req, res) => {
    const [requirements, structural, interference] = await Promise.all([
      computeCoverage(req.params.id),
      computeStructuralCoverage(req.params.id),
      parallelInterference(req.params.id),
    ])
    await saveCoverageProfile(req.params.id, requirements).catch(() => undefined)
    res.json({ requirements, structural, interference })
  }),
)

analysis.post(
  '/projects/:id/coverage',
  h(async (req, res) => {
    if (String(req.query.mode) === 'llm') {
      res.status(201).json(await profileCoverage(req.params.id))
      return
    }
    const report = await computeCoverage(req.params.id)
    const profileId = await saveCoverageProfile(req.params.id, report)
    res.status(201).json({ ...report, profileId })
  }),
)

/** Ask the model which requirements the unlinked tests are evidence for. */
analysis.post(
  '/projects/:id/coverage/suggest-links',
  h(async (req, res) => {
    res.status(201).json({ suggestions: await proposeLinks(req.params.id) })
  }),
)

/** Accept or reject one suggested link. */
analysis.post(
  '/testcases/:testCaseId/requirements/:requirementId',
  h(async (req, res) => {
    const { accept } = parseBody(z.object({ accept: z.boolean() }), req.body ?? {})
    await decideLink(req.params.testCaseId, req.params.requirementId, accept)
    res.json({ ok: true })
  }),
)

analysis.get(
  '/projects/:id/coverage',
  h(async (req, res) => {
    const profiles = await prisma.coverageProfile.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { items: { include: { requirement: true } } },
    })
    res.json(profiles.map((p) => ({ ...p, runIds: json<string[]>(p.runIds, []), summary: json(p.summary, {}), items: p.items.map((i) => ({ ...i, evidence: json<string[]>(i.evidence, []) })) })))
  }),
)

// ---- Gaps -------------------------------------------------------------------

analysis.post(
  '/projects/:id/gaps/generate',
  h(async (req, res) => {
    res.status(201).json(await generateGaps(req.params.id))
  }),
)

analysis.get(
  '/projects/:id/gaps',
  h(async (req, res) => {
    const rows = await prisma.gapScenario.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'desc' }, include: { requirement: true } })
    res.json(rows.map((r) => ({ ...r, neededUi: json<string[]>(r.neededUi, []) })))
  }),
)

analysis.post(
  '/gaps/:id/accept',
  h(async (req, res) => {
    const { run } = parseBody(z.object({ run: z.boolean().optional() }), req.body ?? {})
    const gap = await prisma.gapScenario.findUnique({ where: { id: req.params.id } })
    if (!gap) throw new HttpError(404, 'gap not found')
    const tc = await prisma.testCase.create({
      data: { projectId: gap.projectId, title: gap.title, instruction: gap.instruction, origin: 'gap', gapScenarioId: gap.id },
    })
    await prisma.gapScenario.update({ where: { id: gap.id }, data: { status: 'converted' } })
    const started = run ? await startRun(tc.id) : null
    res.status(201).json({ testCase: tc, run: started })
  }),
)

analysis.post(
  '/gaps/:id/reject',
  h(async (req, res) => {
    res.json(await prisma.gapScenario.update({ where: { id: req.params.id }, data: { status: 'rejected' } }))
  }),
)

analysis.delete(
  '/gaps/:id',
  h(async (req, res) => {
    await prisma.gapScenario.delete({ where: { id: req.params.id } })
    res.status(204).end()
  }),
)

// ---- Bugs -------------------------------------------------------------------

analysis.get(
  '/projects/:id/bugs',
  h(async (req, res) => {
    const rows = await prisma.bugReport.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      include: { run: { select: { id: true, attempt: true, testCase: { select: { title: true } } } } },
    })
    res.json(rows.map((b) => ({ ...b, stepsToReproduce: json<string[]>(b.stepsToReproduce, []) })))
  }),
)

analysis.get(
  '/bugs/:id',
  h(async (req, res) => {
    const bug = await prisma.bugReport.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { testCase: { include: { project: true } } } } },
    })
    if (!bug) throw new HttpError(404, 'bug not found')
    res.json({ ...bug, stepsToReproduce: json<string[]>(bug.stepsToReproduce, []), markdown: bugMarkdown(bug) })
  }),
)

analysis.get(
  '/bugs/:id/markdown',
  h(async (req, res) => {
    const bug = await prisma.bugReport.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { testCase: { include: { project: true } } } } },
    })
    if (!bug) throw new HttpError(404, 'bug not found')
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="bug-${bug.id}.md"`)
    res.send(bugMarkdown(bug))
  }),
)

analysis.put(
  '/bugs/:id',
  h(async (req, res) => {
    const data = parseBody(z.object({ status: z.enum(['open', 'closed']).optional(), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), title: z.string().min(1).optional(), notes: z.string().optional() }), req.body)
    res.json(await prisma.bugReport.update({ where: { id: req.params.id }, data }))
  }),
)
