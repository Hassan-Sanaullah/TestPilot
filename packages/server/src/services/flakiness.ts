/**
 * Which tests cannot be trusted, and saying so instead of hiding it.
 *
 * A test that fails and then passes tells you nothing about the application,
 * but a suite that silently re-runs until it goes green tells you nothing at
 * all. So: the result is still shown, the test keeps running, and it stops
 * deciding whether the build is broken until it settles down.
 */
import { prisma } from '../db'

/** How many of the last few deciding runs may be flaky before we stop trusting it. */
const WINDOW = 5
const FLAKY_LIMIT = 2
const STABLE_TO_RELEASE = 5

export interface FlakinessUpdate {
  quarantined: boolean
  changed: boolean
  reason?: string
}

export async function updateFlakiness(testCaseId: string): Promise<FlakinessUpdate> {
  const tc = await prisma.testCase.findUnique({ where: { id: testCaseId }, select: { id: true, title: true, quarantined: true } })
  if (!tc) return { quarantined: false, changed: false }

  // Only runs that reached a verdict say anything about reliability.
  const recent = await prisma.run.findMany({
    where: { testCaseId, kind: 'normal', status: { in: ['passed', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    take: WINDOW,
    select: { flaky: true, status: true },
  })
  if (recent.length === 0) return { quarantined: tc.quarantined, changed: false }

  const flakyCount = recent.filter((r) => r.flaky).length

  if (!tc.quarantined && flakyCount >= FLAKY_LIMIT) {
    await prisma.testCase.update({ where: { id: testCaseId }, data: { quarantined: true } })
    console.warn(`[flaky] quarantined "${tc.title}": ${flakyCount} of its last ${recent.length} runs needed a re-run to decide`)
    return { quarantined: true, changed: true, reason: `${flakyCount} of the last ${recent.length} runs were flaky` }
  }

  if (tc.quarantined && recent.length >= STABLE_TO_RELEASE && recent.slice(0, STABLE_TO_RELEASE).every((r) => !r.flaky)) {
    await prisma.testCase.update({ where: { id: testCaseId }, data: { quarantined: false } })
    console.log(`[flaky] released "${tc.title}" from quarantine after ${STABLE_TO_RELEASE} stable runs`)
    return { quarantined: false, changed: true, reason: `${STABLE_TO_RELEASE} consecutive stable runs` }
  }

  return { quarantined: tc.quarantined, changed: false }
}

/**
 * Do this project's tests interfere with each other?
 *
 * Three failures that passed when re-run alone is not three flaky tests; it is
 * one project whose tests share data. Telling the user that is far more useful
 * than marking three tests unreliable.
 */
export async function parallelInterference(projectId: string): Promise<{ count: number; suggest: boolean }> {
  const count = await prisma.run.count({ where: { testCase: { projectId }, flakyCause: 'parallel' } })
  return { count, suggest: count >= 3 }
}
