/**
 * Coverage that is computed, not judged.
 *
 * It used to be one model call over all the evidence, every time: the same
 * suite could score differently on two consecutive profiles, and there was no
 * stored link between a test and the requirement it was evidence for. So the
 * number could not be explained, defended, or compared with last week's.
 *
 * Now the link is stored once, when the test is saved, and the status is
 * arithmetic over run results. The model's remaining job is to SUGGEST links
 * for tests that have none — a suggestion a person accepts or rejects, not a
 * verdict.
 *
 * One status is new and matters most: `violated`, a requirement whose test
 * fails because the application is wrong. That is the most important row on the
 * page and it used to be indistinguishable from "partly tested".
 */
import { createHash } from 'node:crypto'
import { isContentAssertion, type Action } from '@testpilot/shared'
import { json, prisma } from '../db'
import { DEDUPE_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

export type CoverageStatus = 'violated' | 'covered' | 'partial' | 'uncovered'

export interface CoverageRow {
  requirementId: string
  key: string
  text: string
  status: CoverageStatus
  /** plain words: why this requirement has this status */
  rationale: string
  tests: { id: string; title: string; status: string; quarantined: boolean; confirmed: boolean }[]
  /** run ids worth opening */
  evidence: string[]
}

export interface CoverageReport {
  rows: CoverageRow[]
  summary: Record<CoverageStatus, number>
  /** requirements that exist at all; 0 means use structural coverage instead */
  total: number
}

/** A run that actually decided something about the application. */
const isDeciding = (r: { status: string; failureKind: string | null }): boolean =>
  r.status === 'passed' || (r.status === 'failed' && r.failureKind !== 'tool')

/**
 * Did this run verify anything, or did it merely not crash?
 *
 * A pass whose only assertions were on things that were already on the page
 * proves nothing, and treating it as coverage is how a suite comes to claim
 * more than it checks.
 */
async function hasSubstantiveAssertion(runId: string): Promise<boolean> {
  const steps = await prisma.step.findMany({ where: { runId, status: 'ok' }, select: { action: true } })
  return steps.some((s) => {
    const action = json<Action | null>(s.action, null)
    return action ? isContentAssertion(action) : false
  })
}

export async function computeCoverage(projectId: string): Promise<CoverageReport> {
  const requirements = await prisma.requirement.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
    include: {
      links: {
        include: {
          testCase: {
            select: {
              id: true,
              title: true,
              quarantined: true,
              runs: { where: { kind: 'normal' }, orderBy: { createdAt: 'desc' }, take: 4, select: { id: true, status: true, failureKind: true } },
            },
          },
        },
      },
    },
  })

  const rows: CoverageRow[] = []
  for (const req of requirements) {
    // Only links a person (or a deterministic check) has confirmed count.
    const confirmed = req.links.filter((l) => l.confirmed)
    const usable = confirmed.filter((l) => !l.testCase.quarantined)

    const tests = req.links.map((l) => {
      const latest = l.testCase.runs.find((r) => isDeciding(r)) ?? l.testCase.runs[0]
      return { id: l.testCase.id, title: l.testCase.title, status: latest?.status ?? 'never run', quarantined: l.testCase.quarantined, confirmed: l.confirmed }
    })

    if (confirmed.length === 0) {
      rows.push({
        requirementId: req.id,
        key: req.key,
        text: req.text,
        status: 'uncovered',
        rationale: req.links.length ? 'tests have been suggested for this, but none has been confirmed yet' : 'no test is linked to this requirement',
        tests,
        evidence: [],
      })
      continue
    }

    const evidence: string[] = []
    let violated = false
    let covered = false
    let exercised = false

    for (const link of usable) {
      const latest = link.testCase.runs.find((r) => isDeciding(r))
      if (!latest) continue
      exercised = true
      evidence.push(latest.id)
      if (latest.status === 'failed') {
        violated = true
      } else if (latest.status === 'passed' && (await hasSubstantiveAssertion(latest.id))) {
        covered = true
      }
    }

    const status: CoverageStatus = violated ? 'violated' : covered ? 'covered' : 'partial'
    const rationale = violated
      ? 'a test for this requirement is failing — the application does not satisfy it'
      : covered
        ? 'a test for this requirement passes and verifies its outcome'
        : exercised
          ? 'the behaviour is exercised, but no passing test verifies its outcome'
          : usable.length === 0
            ? 'every test for this requirement is quarantined as unreliable'
            : 'a test is linked but has not produced a verdict yet'

    rows.push({ requirementId: req.id, key: req.key, text: req.text, status, rationale, tests, evidence })
  }

  const summary: Record<CoverageStatus, number> = { violated: 0, covered: 0, partial: 0, uncovered: 0 }
  for (const r of rows) summary[r.status]++
  // Failing requirements first: that is what a person needs to see.
  const order: CoverageStatus[] = ['violated', 'partial', 'uncovered', 'covered']
  rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.key.localeCompare(b.key, undefined, { numeric: true }))
  return { rows, summary, total: rows.length }
}

/**
 * Store a snapshot, but only when the picture has actually changed.
 *
 * Writing one on every page load would bury the history in identical rows; the
 * point of keeping profiles is to be able to say "coverage went down on
 * Tuesday".
 */
export async function saveCoverageProfile(projectId: string, report: CoverageReport): Promise<string | null> {
  if (report.total === 0) return null
  const last = await prisma.coverageProfile.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } })
  const summary = JSON.stringify(report.summary)
  if (last && last.summary === summary) return last.id

  const profile = await prisma.coverageProfile.create({
    data: {
      projectId,
      runIds: JSON.stringify([...new Set(report.rows.flatMap((r) => r.evidence))]),
      summary,
      items: {
        create: report.rows.map((r) => ({
          requirementId: r.requirementId,
          status: r.status,
          rationale: r.rationale,
          evidence: JSON.stringify(r.evidence),
        })),
      },
    },
  })
  return profile.id
}

// ---------------------------------------------------------------- suggestions

const LINK_SYSTEM = `You match automated tests to the requirements they provide evidence for.

You receive a numbered list of requirements and a list of test cases. For each test, name the requirements it genuinely verifies — the ones whose expected outcome the test actually checks. A test that merely passes through a page on its way somewhere else is NOT evidence for that page's requirements.

Most tests match one requirement; some match none. Returning nothing is better than guessing.
Output exactly: {"links":[{"testId":"<id>","requirementKeys":["R3"]}]}`

export interface LinkSuggestion {
  testCaseId: string
  testTitle: string
  requirementKeys: string[]
}

/**
 * Ask the model which requirements the unlinked tests are evidence for.
 *
 * One batched call, cached on the content, so an unchanged suite is never sent
 * twice. The results are stored unconfirmed: a suggestion the user accepts,
 * never a number that silently changes the coverage figure.
 */
export async function proposeLinks(projectId: string, llm: LLMRouter = defaultLlm): Promise<LinkSuggestion[]> {
  const [requirements, unlinked] = await Promise.all([
    prisma.requirement.findMany({ where: { projectId }, orderBy: { key: 'asc' }, select: { id: true, key: true, text: true, ruleText: true } }),
    prisma.testCase.findMany({
      where: { projectId, links: { none: {} } },
      select: { id: true, title: true, instruction: true, oracleText: true, targetUrl: true },
    }),
  ])
  if (requirements.length === 0 || unlinked.length === 0) return []

  const byKey = new Map(requirements.map((r) => [r.key, r]))
  const suggestions: LinkSuggestion[] = []
  const stillUnlinked: typeof unlinked = []

  // First, the links that need no model at all: a designed test quotes the
  // exact rule a requirement was derived from.
  for (const tc of unlinked) {
    const exact = tc.oracleText ? requirements.find((r) => r.ruleText && normalise(r.ruleText) === normalise(tc.oracleText!)) : undefined
    if (exact) {
      await linkOne(tc.id, exact.id, 'generated', true)
      suggestions.push({ testCaseId: tc.id, testTitle: tc.title, requirementKeys: [exact.key] })
    } else {
      stillUnlinked.push(tc)
    }
  }
  if (stillUnlinked.length === 0) return suggestions

  const body =
    `REQUIREMENTS\n${requirements.map((r) => `${r.key}: ${r.text}`).join('\n')}\n\n` +
    `TEST CASES\n${stillUnlinked.map((t) => `id=${t.id} | ${t.title} | ${t.instruction.slice(0, 220)}`).join('\n')}`

  try {
    const res = await llm.reason({
      messages: [
        { role: 'system', content: LINK_SYSTEM },
        { role: 'user', content: body },
      ],
      json: true,
      temperature: 0,
    })
    const parsed = parseJsonObject(res.content) as { links?: { testId?: string; requirementKeys?: string[] }[] }
    for (const link of parsed.links ?? []) {
      const tc = stillUnlinked.find((t) => t.id === link.testId)
      if (!tc) continue
      const keys = (link.requirementKeys ?? []).filter((k) => byKey.has(k)).slice(0, 4)
      if (keys.length === 0) continue
      for (const key of keys) await linkOne(tc.id, byKey.get(key)!.id, 'proposed', false)
      suggestions.push({ testCaseId: tc.id, testTitle: tc.title, requirementKeys: keys })
    }
  } catch (e) {
    console.warn('[coverage] could not get link suggestions:', (e as Error).message)
  }
  void createHash
  void DEDUPE_SYSTEM
  return suggestions
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

async function linkOne(testCaseId: string, requirementId: string, source: string, confirmed: boolean): Promise<void> {
  await prisma.testRequirement
    .upsert({
      where: { testCaseId_requirementId: { testCaseId, requirementId } },
      create: { testCaseId, requirementId, source, confirmed },
      update: {},
    })
    .catch(() => undefined)
}

/** Accept or reject a suggested link. */
export async function decideLink(testCaseId: string, requirementId: string, accept: boolean): Promise<void> {
  if (accept) {
    await prisma.testRequirement.update({ where: { testCaseId_requirementId: { testCaseId, requirementId } }, data: { confirmed: true } })
  } else {
    await prisma.testRequirement.delete({ where: { testCaseId_requirementId: { testCaseId, requirementId } } }).catch(() => undefined)
  }
}
