/**
 * Disk hygiene. Every run writes a screenshot per step and, when it fails, a
 * Playwright trace; a few hundred runs is a few gigabytes. Evidence for a run
 * that still backs an open bug report is never touched — that is the proof the
 * report rests on.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config'
import { prisma } from '../db'

/** Delete evidence folders older than `EVIDENCE_KEEP_DAYS`, except open bugs. */
export async function sweepEvidence(now = Date.now()): Promise<{ deleted: number; kept: number }> {
  const days = config.evidenceKeepDays
  if (days <= 0) return { deleted: 0, kept: 0 }
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000)

  let entries: string[]
  try {
    entries = await fs.readdir(config.evidenceDir)
  } catch {
    return { deleted: 0, kept: 0 } // nothing written yet
  }
  if (entries.length === 0) return { deleted: 0, kept: 0 }

  const old = await prisma.run.findMany({
    where: { createdAt: { lt: cutoff }, id: { in: entries } },
    select: { id: true, bugReports: { where: { status: 'open' }, select: { id: true } } },
  })

  let deleted = 0
  let kept = 0
  for (const run of old) {
    if (run.bugReports.length > 0) {
      kept++
      continue
    }
    const dir = path.join(config.evidenceDir, run.id)
    try {
      await fs.rm(dir, { recursive: true, force: true })
      await prisma.run.update({ where: { id: run.id }, data: { tracePath: null } })
      deleted++
    } catch {
      /* in use; next sweep gets it */
    }
  }
  if (deleted) console.log(`[housekeeping] removed evidence for ${deleted} run(s) older than ${days} days (${kept} kept for open bugs)`)
  return { deleted, kept }
}
