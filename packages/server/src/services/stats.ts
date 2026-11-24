/** Aggregates used by the dashboard's overview page. */
import { estimateCost } from '@testpilot/shared'
import { json, prisma } from '../db'
import { shapeOf } from '../engine/explorer'

export interface ProjectStats {
  counts: {
    requirements: number
    testCases: number
    /** tests that replay deterministically, with no model in the loop */
    compiled: number
    /** of those, how many have been checked by an actual replay */
    verified: number
    quarantined: number
    knownFailing: number
    runs: number
    bugsOpen: number
    bugsTotal: number
    gapsSuggested: number
  }
  runs: { passed: number; failed: number; error: number; cancelled: number; flaky: number }
  passRate: number | null
  coverage: { violated?: number; covered: number; partial: number; uncovered: number; total: number } | null
  trend: { date: string; passed: number; failed: number }[]
  /** How long each mode takes, so the difference is visible rather than claimed. */
  timing: { replayMedianMs: number | null; aiMedianMs: number | null }
  cost: {
    llmCalls: number
    promptTokens: number
    completionTokens: number
    /** calls split by mode: a replay should be zero */
    aiCalls: number
    replayCalls: number
    estimatedUsd: number | null
    free: boolean
  }
  /** Coverage per area of the application, from the app map's page kinds. */
  areas: { name: string; tests: number; failing: number; coveredPct: number | null }[]
  lastRunAt: string | null
  lastSuiteRun: { id: string; status: string; passed: number; failed: number; errored: number; total: number; finishedAt: string | null } | null
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.floor(s.length / 2)])
}

/** Plain-English names for the explorer's page kinds. */
const AREA_NAMES: Record<string, string> = {
  auth: 'Sign in and register',
  form: 'Forms',
  listing: 'Search and browse',
  detail: 'Item pages',
  cart: 'Cart',
  checkout: 'Checkout',
  admin: 'Admin',
  other: 'Other',
  blocked: 'Blocked pages',
}

export async function projectStats(projectId: string): Promise<ProjectStats> {
  const [requirements, bugsOpen, bugsTotal, gapsSuggested, cases, pages, lastSuite] = await Promise.all([
    prisma.requirement.count({ where: { projectId } }),
    prisma.bugReport.count({ where: { projectId, status: 'open' } }),
    prisma.bugReport.count({ where: { projectId } }),
    prisma.gapScenario.count({ where: { projectId, status: 'suggested' } }),
    prisma.testCase.findMany({
      where: { projectId },
      select: { id: true, script: true, scriptVerifiedAt: true, quarantined: true, expectation: true, targetUrl: true, area: true },
    }),
    prisma.appPage.findMany({ where: { projectId }, select: { url: true, kind: true } }),
    prisma.suiteRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } }),
  ])

  const counts = {
    requirements,
    testCases: cases.length,
    compiled: cases.filter((c) => c.script).length,
    verified: cases.filter((c) => c.scriptVerifiedAt).length,
    quarantined: cases.filter((c) => c.quarantined).length,
    knownFailing: cases.filter((c) => c.expectation === 'known-failing').length,
    runs: 0,
    bugsOpen,
    bugsTotal,
    gapsSuggested,
  }

  const runs = await prisma.run.findMany({
    where: { testCase: { projectId }, kind: 'normal' },
    select: {
      status: true,
      flaky: true,
      createdAt: true,
      llmCalls: true,
      promptTokens: true,
      completionTokens: true,
      mode: true,
      model: true,
      startedAt: true,
      finishedAt: true,
      testCaseId: true,
      failureKind: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  counts.runs = runs.length

  const tally = { passed: 0, failed: 0, error: 0, cancelled: 0, flaky: 0 }
  const cost = { llmCalls: 0, promptTokens: 0, completionTokens: 0, aiCalls: 0, replayCalls: 0, estimatedUsd: null as number | null, free: true }
  const replayMs: number[] = []
  const aiMs: number[] = []
  let usd = 0
  let anyPaid = false

  for (const r of runs) {
    if (r.status === 'passed') tally.passed++
    else if (r.status === 'failed') tally.failed++
    else if (r.status === 'error') tally.error++
    else if (r.status === 'cancelled') tally.cancelled++
    if (r.flaky) tally.flaky++

    cost.llmCalls += r.llmCalls
    cost.promptTokens += r.promptTokens
    cost.completionTokens += r.completionTokens
    if (r.mode === 'replay') cost.replayCalls += r.llmCalls
    else cost.aiCalls += r.llmCalls

    const e = estimateCost(r.model, r.promptTokens, r.completionTokens)
    usd += e.usd
    if (!e.free && (r.promptTokens || r.completionTokens)) anyPaid = true

    if (r.startedAt && r.finishedAt) {
      const ms = r.finishedAt.getTime() - r.startedAt.getTime()
      if (ms > 0 && ms < 10 * 60 * 1000) (r.mode === 'replay' ? replayMs : aiMs).push(ms)
    }
  }
  cost.free = !anyPaid
  cost.estimatedUsd = anyPaid ? usd : null

  const decided = tally.passed + tally.failed

  // last 14 days, oldest first
  const days = 14
  const byDay = new Map<string, { passed: number; failed: number }>()
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    byDay.set(d.toISOString().slice(0, 10), { passed: 0, failed: 0 })
  }
  for (const r of runs) {
    const key = r.createdAt.toISOString().slice(0, 10)
    const slot = byDay.get(key)
    if (!slot) continue
    if (r.status === 'passed') slot.passed++
    else if (r.status === 'failed' || r.status === 'error') slot.failed++
  }

  const profile = await prisma.coverageProfile.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } })
  const summary = profile
    ? json<{ violated?: number; covered: number; partial: number; uncovered: number; total: number }>(profile.summary, { covered: 0, partial: 0, uncovered: 0, total: 0 })
    : null

  // ---- areas: which part of the application each test belongs to.
  const kindByShape = new Map(pages.map((p) => [shapeOf(p.url), p.kind]))
  const latestByCase = new Map<string, (typeof runs)[number]>()
  for (const r of runs) if (!latestByCase.has(r.testCaseId)) latestByCase.set(r.testCaseId, r)

  const areaTally = new Map<string, { tests: number; failing: number }>()
  for (const c of cases) {
    // The test's own target first; otherwise the area the explorer assigned.
    const kind = (c.targetUrl ? kindByShape.get(shapeOf(c.targetUrl)) : undefined) ?? c.area ?? 'other'
    const name = AREA_NAMES[kind] ?? AREA_NAMES.other
    const slot = areaTally.get(name) ?? { tests: 0, failing: 0 }
    slot.tests++
    const latest = latestByCase.get(c.id)
    if (latest?.status === 'failed' && latest.failureKind !== 'tool') slot.failing++
    areaTally.set(name, slot)
  }

  // A percentage needs a coverage profile to mean anything. Without one, show
  // the counts and leave the figure out rather than inventing it.
  const items = profile ? await prisma.coverageItem.findMany({ where: { profileId: profile.id }, include: { requirement: { select: { pageUrl: true } } } }) : []
  const areas = [...areaTally.entries()]
    .map(([name, v]) => {
      const relevant = items.filter((i) => {
        const url = i.requirement.pageUrl
        if (!url) return false
        const kind = kindByShape.get(shapeOf(url)) ?? 'other'
        return (AREA_NAMES[kind] ?? AREA_NAMES.other) === name
      })
      const coveredPct = relevant.length ? Math.round((100 * relevant.filter((i) => i.status === 'covered').length) / relevant.length) : null
      return { name, tests: v.tests, failing: v.failing, coveredPct }
    })
    .sort((a, b) => b.tests - a.tests)

  return {
    counts,
    runs: tally,
    passRate: decided ? Math.round((100 * tally.passed) / decided) : null,
    coverage: summary,
    trend: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
    timing: { replayMedianMs: median(replayMs), aiMedianMs: median(aiMs) },
    cost,
    areas,
    lastRunAt: runs[0]?.createdAt.toISOString() ?? null,
    lastSuiteRun: lastSuite
      ? {
          id: lastSuite.id,
          status: lastSuite.status,
          passed: lastSuite.passed,
          failed: lastSuite.failed,
          errored: lastSuite.errored,
          total: lastSuite.total,
          finishedAt: lastSuite.finishedAt?.toISOString() ?? null,
        }
      : null,
  }
}
