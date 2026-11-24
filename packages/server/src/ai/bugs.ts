/**
 * Bug reports. Filed automatically for a confirmed failure (a failed run whose
 * automatic re-run also failed, or a failed run when retries are off). The
 * steps-to-reproduce are built deterministically from the executed steps; the
 * reasoning model writes title / severity / expected / actual.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type Action, describeAction, isSupportedAction } from '@testpilot/shared'
import { json, prisma } from '../db'
import { BUG_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

/**
 * Strip the parts of a failure message that differ between two sightings of the
 * SAME defect: generated ids, timestamps, prices that embed a run-specific
 * quantity, and the unique email a run made up for itself.
 */
export function normaliseForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#') // ids, hashes, cuids
    .replace(/\d{4,}/g, '#') // timestamps, long numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/**
 * A signature for "this defect", not "this run".
 *
 * Without it, a suite that runs nightly files the same bug every night and the
 * list becomes useless within a week. With it, the second sighting raises a
 * counter — and costs no model call, which matters on a free tier.
 */
export function bugFingerprint(testCaseId: string, action: unknown, error: string): string {
  const a = action && typeof action === 'object' ? (action as { type?: string }) : {}
  const shape = JSON.stringify({ type: a.type ?? 'unknown', ...('text' in a ? { text: normaliseForFingerprint(String((a as { text?: string }).text ?? '')) } : {}) })
  return createHash('sha1').update(testCaseId).update('|').update(shape).update('|').update(normaliseForFingerprint(error)).digest('hex').slice(0, 24)
}

const BugSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  expected: z.string().default(''),
  actual: z.string().default(''),
  notes: z.string().default(''),
})

export async function fileBugReport(runId: string, llm: LLMRouter = defaultLlm) {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { steps: { orderBy: { index: 'asc' } }, testCase: { include: { project: true } } },
  })
  const existing = await prisma.bugReport.findFirst({ where: { runId } })
  if (existing) return existing

  const steps = run.steps.map((s) => ({ ...s, parsed: json<Action | { type: string }>(s.action, { type: 'unknown' }) }))
  const repro = [`Open ${run.testCase.project.baseUrl}`]
  for (const s of steps) {
    if (s.status === 'flagged') continue
    const a = s.parsed
    if (a.type === 'finish') continue
    const line = isSupportedAction(a) ? describeAction(a) : a.type
    repro.push(s.status === 'failed' ? `${line}  ← FAILS: ${s.error ?? ''}` : line)
  }
  const failing = [...steps].reverse().find((s) => s.status !== 'ok') ?? steps.at(-1)
  const screenshotPath = failing?.screenshotPath ?? steps.at(-1)?.screenshotPath ?? null

  // Have we seen this exact defect before? If so, say "again" instead of
  // filing a second report — and spend no model call doing it.
  const fingerprint = bugFingerprint(run.testCaseId, failing?.parsed, failing?.error ?? run.reason ?? '')
  const open = await prisma.bugReport.findFirst({
    where: { projectId: run.testCase.projectId, fingerprint, status: 'open' },
    orderBy: { lastSeenAt: 'desc' },
  })
  if (open) {
    const again = await prisma.bugReport.update({
      where: { id: open.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        lastRunId: runId,
        // It is failing again, so any "looks fixed" note is stale.
        passingSince: null,
        ...(screenshotPath ? { screenshotPath } : {}),
      },
    })
    console.log(`[bugs] the same defect again (${again.occurrences}x): ${again.title}`)
    return again
  }

  let draft = { title: `Test failed: ${run.testCase.title}`, severity: 'medium', expected: run.testCase.instruction, actual: run.reason ?? 'see steps', notes: '' }
  try {
    const res = await llm.reason({
      messages: [
        { role: 'system', content: BUG_SYSTEM },
        {
          role: 'user',
          content:
            `TEST: ${run.testCase.title}\nINSTRUCTION: ${run.testCase.instruction}\nAPPLICATION: ${run.testCase.project.baseUrl}\n` +
            `VERDICT: ${run.status} — ${run.reason ?? ''}\n` +
            (run.oracle ? `ORACLE: ${run.oracle}${run.testCase.oracleText ? ` — the rule relied on: "${run.testCase.oracleText}"` : ''}\n` : '') +
            `\nEXECUTED STEPS\n${repro.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
        },
      ],
      json: true,
      temperature: 0.2,
    })
    draft = BugSchema.parse(parseJsonObject(res.content))
  } catch (e) {
    console.warn('[bugs] model draft failed, using template:', (e as Error).message)
  }

  // An expectation nobody wrote down is still worth reporting, but not at the
  // same confidence as one the page itself states.
  const inferred = run.oracle === 'unstated'
  const severity = inferred ? 'low' : draft.severity
  const notes = inferred
    ? [draft.notes, 'The expectation behind this report was inferred by the model; neither the test instruction nor the page states it. Confirm it before acting.'].filter(Boolean).join('\n\n')
    : draft.notes

  return prisma.bugReport.create({
    data: {
      runId,
      projectId: run.testCase.projectId,
      testCaseId: run.testCaseId,
      fingerprint,
      lastRunId: runId,
      oracle: run.oracle,
      oracleText: run.testCase.oracleText,
      title: draft.title.slice(0, 160),
      severity,
      stepsToReproduce: JSON.stringify(repro),
      expected: draft.expected,
      actual: draft.actual,
      notes,
      screenshotPath,
    },
  })
}

/**
 * File (or re-file) the one bug that an implicit oracle can raise on its own: a
 * first-party server error during a test that otherwise passed. Script
 * exceptions are reported as warnings only — too often they are not actionable.
 */
export async function fileServerErrorBug(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { testCase: { include: { project: true } } },
  })
  if (!run) return
  const anomalies = json<{ kind: string; url?: string; status?: number; step?: number }[]>(run.anomalies, [])
  const first = anomalies.find((a) => a.kind === 'http-5xx')
  if (!first) return

  let path = first.url ?? 'an unknown URL'
  try {
    path = new URL(first.url ?? '').pathname
  } catch {
    /* keep the raw string */
  }
  // Fingerprint on the path, not the test: the same broken endpoint found by
  // three different tests is one defect.
  const fingerprint = createHash('sha1').update('http-5xx').update(path).update(String(first.status ?? 500)).digest('hex').slice(0, 24)
  const open = await prisma.bugReport.findFirst({ where: { projectId: run.testCase.projectId, fingerprint, status: 'open' } })
  if (open) {
    await prisma.bugReport.update({
      where: { id: open.id },
      data: { occurrences: { increment: 1 }, lastSeenAt: new Date(), lastRunId: runId, passingSince: null },
    })
    return
  }
  await prisma.bugReport.create({
    data: {
      runId,
      projectId: run.testCase.projectId,
      testCaseId: run.testCaseId,
      fingerprint,
      lastRunId: runId,
      oracle: 'implicit',
      oracleText: 'A web server must not return a 5xx status for a request a user can make.',
      title: `Server error (HTTP ${first.status}) on ${path}`.slice(0, 160),
      severity: 'medium',
      stepsToReproduce: JSON.stringify([`Open ${run.testCase.project.baseUrl}`, `Run the test "${run.testCase.title}"`, `The request to ${path} returns HTTP ${first.status}`]),
      expected: `${path} responds successfully while the application is used normally.`,
      actual: `It returned HTTP ${first.status} during step ${first.step ?? '?'} of "${run.testCase.title}", which otherwise passed.`,
      notes: 'Found by watching network responses rather than by an assertion, so no test is checking this yet.',
      screenshotPath: null,
    },
  })
}

export function bugMarkdown(bug: {
  id: string
  title: string
  severity: string
  status: string
  stepsToReproduce: string
  expected: string
  actual: string
  notes: string
  screenshotPath: string | null
  createdAt: Date
  run?: { id: string; attempt: number; reason: string | null; testCase?: { title: string; instruction: string; project?: { name: string; baseUrl: string } } } | null
}): string {
  const steps = json<string[]>(bug.stepsToReproduce, [])
  const p = bug.run?.testCase?.project
  const lines = [
    `# ${bug.title}`,
    '',
    `- **Severity:** ${bug.severity}`,
    `- **Status:** ${bug.status}`,
    `- **Reported:** ${bug.createdAt.toISOString()}`,
    p ? `- **Application:** ${p.name} (${p.baseUrl})` : null,
    bug.run?.testCase ? `- **Test:** ${bug.run.testCase.title}` : null,
    bug.run ? `- **Run:** ${bug.run.id} (attempt ${bug.run.attempt}${bug.run.attempt > 1 ? ', reproduced on re-run' : ''})` : null,
    '',
    '## Steps to reproduce',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Expected',
    bug.expected,
    '',
    '## Actual',
    bug.actual,
    bug.notes ? `\n## Notes\n${bug.notes}` : null,
    bug.screenshotPath ? `\n## Evidence\n![failing step](evidence/${bug.screenshotPath})` : null,
    bug.run?.testCase ? `\n## Test instruction\n> ${bug.run.testCase.instruction}` : null,
    '',
  ]
  return lines.filter((l): l is string => l !== null).join('\n')
}
