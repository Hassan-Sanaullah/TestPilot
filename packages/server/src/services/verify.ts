/**
 * Checking that a freshly compiled script actually replays.
 *
 * A script used to be compiled, stored and trusted. On the first real site it
 * was tried against, eight tests compiled and none of them replayed — and
 * nobody found out until a person pressed "run" and read the failures. One
 * replay, immediately, with no model in the loop, answers the only question
 * that matters: do these recorded steps reproduce what the AI just did?
 *
 * A script that does not reproduce is thrown away rather than kept. Keeping it
 * would mean a suite full of tests that fail for reasons that have nothing to
 * do with the application.
 */
import { prisma } from '../db'

export interface VerifyOutcome {
  verified: boolean
  reason: string
}

export async function verifyCompiledScript(verifyRunId: string): Promise<VerifyOutcome> {
  const run = await prisma.run.findUnique({
    where: { id: verifyRunId },
    select: { id: true, status: true, reason: true, healedSteps: true, failureKind: true, testCaseId: true },
  })
  if (!run) return { verified: false, reason: 'the verification run disappeared' }

  const tc = await prisma.testCase.findUnique({
    where: { id: run.testCaseId },
    select: { id: true, title: true, expectation: true, scriptFromRunId: true },
  })
  if (!tc) return { verified: false, reason: 'the test case disappeared' }

  // What counts as "reproduced" depends on what was recorded. A known-failing
  // script is supposed to fail; a passing one is supposed to pass.
  const expectedStatus = tc.expectation === 'known-failing' ? 'failed' : 'passed'
  const reproduced = run.status === expectedStatus && run.failureKind !== 'tool'

  // A locator that drifts within seconds of being recorded is not stable
  // enough to build a suite on, even though the replay passed.
  const drifted = run.healedSteps > 0

  if (reproduced && !drifted) {
    await prisma.testCase.update({ where: { id: tc.id }, data: { scriptVerifiedAt: new Date() } })
    return { verified: true, reason: 'the recorded steps reproduced exactly' }
  }

  const why = drifted
    ? `${run.healedSteps} locator(s) already needed repairing on the very first replay, so they are not stable enough to rely on`
    : `the replay ended as "${run.status}" when the recording ended as "${expectedStatus}"${run.reason ? ` (${run.reason})` : ''}`

  // Discard the script. The test stays AI-driven, which is slower but honest.
  await prisma.testCase.update({ where: { id: tc.id }, data: { script: null, scriptVerifiedAt: null, scriptFromRunId: null } })
  if (tc.scriptFromRunId) {
    const authoring = await prisma.run.findUnique({ where: { id: tc.scriptFromRunId }, select: { reason: true } })
    await prisma.run
      .update({
        where: { id: tc.scriptFromRunId },
        data: { reason: `${authoring?.reason ?? ''} The recorded steps did not replay, so no script was kept: ${why}.`.trim() },
      })
      .catch(() => undefined)
  }
  console.warn(`[verify] discarded the script for "${tc.title}": ${why}`)
  return { verified: false, reason: why }
}
