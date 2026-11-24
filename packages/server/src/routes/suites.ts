/**
 * Suite runs: one press of "run all", and the artefacts a build system and a
 * person need from it.
 */
import { Router } from 'express'
import { z } from 'zod'
import { json, prisma } from '../db'
import { HttpError, h, parseBody } from '../http'
import { htmlReport, junitXml } from '../services/reports'
import { cancelSuite, startSuite, toSuiteDto } from '../services/suiteService'

export const suites = Router()

const StartBody = z.object({
  testCaseIds: z.array(z.string()).max(500).optional(),
  mode: z.enum(['auto', 'ai', 'replay']).optional(),
  compiledOnly: z.boolean().optional(),
})

suites.post(
  '/projects/:id/suite-runs',
  h(async (req, res) => {
    const body = parseBody(StartBody, req.body ?? {})
    res.status(202).json(await startSuite(req.params.id, body))
  }),
)

suites.get(
  '/projects/:id/suite-runs',
  h(async (req, res) => {
    const rows = await prisma.suiteRun.findMany({ where: { projectId: req.params.id }, orderBy: { startedAt: 'desc' }, take: 50 })
    res.json(rows.map(toSuiteDto))
  }),
)

suites.get(
  '/suite-runs/:id',
  h(async (req, res) => {
    const row = await prisma.suiteRun.findUnique({
      where: { id: req.params.id },
      include: {
        runs: {
          orderBy: { createdAt: 'asc' },
          include: {
            testCase: { select: { id: true, title: true, quarantined: true, expectation: true, oracleText: true } },
            bugReports: { select: { id: true, title: true, severity: true } },
            _count: { select: { steps: true } },
          },
        },
      },
    })
    if (!row) throw new HttpError(404, 'suite run not found')
    const { runs, ...suite } = row
    res.json({
      ...toSuiteDto(suite),
      runs: runs.map((r) => ({ ...r, anomalies: json(r.anomalies, []) })),
    })
  }),
)

suites.post(
  '/suite-runs/:id/cancel',
  h(async (req, res) => {
    res.json({ cancelled: await cancelSuite(req.params.id) })
  }),
)

/** What a CI system reads. */
suites.get(
  '/suite-runs/:id/junit',
  h(async (req, res) => {
    const xml = await junitXml(req.params.id)
    res.type('application/xml').send(xml)
  }),
)

/** One self-contained page: open it, read it, print it. */
suites.get(
  '/suite-runs/:id/report',
  h(async (req, res) => {
    const html = await htmlReport(req.params.id, { evidenceBase: '/evidence/' })
    res.type('html').send(html)
  }),
)
