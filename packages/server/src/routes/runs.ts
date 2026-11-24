import path from 'node:path'
import { Router } from 'express'
import type { RunEvent } from '@testpilot/shared'
import { config } from '../config'
import { prisma } from '../db'
import { runEvents } from '../events'
import { toStepDTO } from '../engine/runner'
import { HttpError, h } from '../http'
import { cancelRun } from '../services/runService'

export const runs = Router()

runs.get(
  '/projects/:id/runs',
  h(async (req, res) => {
    const rows = await prisma.run.findMany({
      where: { testCase: { projectId: req.params.id } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { testCase: { select: { id: true, title: true } }, _count: { select: { steps: true, bugReports: true } } },
    })
    res.json(rows)
  }),
)

runs.get(
  '/runs/:id',
  h(async (req, res) => {
    const row = await prisma.run.findUnique({
      where: { id: req.params.id },
      include: {
        steps: { orderBy: { index: 'asc' } },
        testCase: { include: { project: true } },
        // expected/actual are what the run page shows side by side; without
        // them it can only print the raw step error.
        bugReports: { select: { id: true, title: true, severity: true, expected: true, actual: true, occurrences: true, passingSince: true } },
      },
    })
    if (!row) throw new HttpError(404, 'run not found')
    res.json({ ...row, steps: row.steps.map(toStepDTO) })
  }),
)

runs.post(
  '/runs/:id/cancel',
  h(async (req, res) => {
    res.json({ ok: cancelRun(req.params.id) })
  }),
)

runs.get(
  '/runs/:id/trace',
  h(async (req, res) => {
    const row = await prisma.run.findUnique({ where: { id: req.params.id } })
    if (!row?.tracePath) throw new HttpError(404, 'no trace for this run')
    res.download(path.join(config.evidenceDir, row.tracePath), `trace-${row.id}.zip`)
  }),
)

/** Server-Sent Events: live step/status stream for one run. */
runs.get('/runs/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (ev: RunEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  const off = runEvents.subscribe(req.params.id, send)
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    off()
    clearInterval(beat)
  })
})

/** Global stream (any run) — used by list pages to refresh. */
runs.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const off = runEvents.subscribeAll((ev) => {
    if (ev.type === 'run.status' || ev.type === 'run.done') res.write(`data: ${JSON.stringify(ev)}\n\n`)
  })
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    off()
    clearInterval(beat)
  })
})
