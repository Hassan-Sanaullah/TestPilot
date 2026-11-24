/**
 * M4 — Coverage Checker ("Profile" in the methodology).
 *
 * Input:  the project's requirement checklist + evidence from the latest run of
 *         every test case (executed steps, assertion outcomes, URLs).
 * Output: a CoverageProfile saying, per requirement, covered / partial /
 *         uncovered with cited evidence steps.
 *
 * The LLM does the mapping; a deterministic guard then enforces the definition
 * of "covered": at least one cited step must be a PASSED assertion. This keeps
 * the profile honest even if the model is generous.
 */
import { z } from 'zod'
import { type Action, describeAction, isAssertion, isSupportedAction } from '@testpilot/shared'
import { json, prisma } from '../db'
import { HttpError } from '../http'
import { COVERAGE_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

const ItemsSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      status: z.enum(['covered', 'partial', 'uncovered']),
      evidence: z.array(z.string()).default([]),
      rationale: z.string().default(''),
    }),
  ),
})

export interface EvidenceStep {
  label: string
  id: string
  status: string
  action: Action | { type: string }
  error: string | null
  url: string
}

export function buildEvidence(
  runs: { id: string; status: string; reason: string | null; testCase: { title: string }; steps: { id: string; status: string; action: string; error: string | null; url: string }[] }[],
): { text: string; steps: EvidenceStep[] } {
  const steps: EvidenceStep[] = []
  const lines: string[] = []
  let n = 0
  for (const r of runs) {
    lines.push(`RUN ${r.id.slice(-6)} — test "${r.testCase.title}" — ${r.status}${r.reason ? ` — ${r.reason}` : ''}`)
    for (const s of r.steps) {
      n++
      const label = `S${n}`
      const action = json<Action | { type: string }>(s.action, { type: 'unknown' })
      const desc = isSupportedAction(action) ? describeAction(action) : action.type
      const outcome = s.status === 'flagged' ? ' → FLAGGED (invalid)' : isAssertion(action) ? (s.status === 'ok' ? ' → ASSERTION PASSED' : ' → ASSERTION FAILED') : s.status === 'failed' ? ` → failed: ${s.error ?? ''}` : ''
      lines.push(`  ${label} [${s.status}] ${desc}${outcome}  @ ${s.url}`)
      steps.push({ label, id: s.id, status: s.status, action, error: s.error, url: s.url })
    }
  }
  return { text: lines.join('\n'), steps }
}

/** Deterministic guard on the model's judgement. */
export function applyCoverageGuard(
  item: { status: 'covered' | 'partial' | 'uncovered'; evidence: string[]; rationale: string },
  stepsByLabel: Map<string, EvidenceStep>,
): { status: 'covered' | 'partial' | 'uncovered'; evidence: string[]; rationale: string } {
  const cited = item.evidence.map((l) => stepsByLabel.get(l)).filter((s): s is EvidenceStep => Boolean(s))
  if (item.status === 'uncovered') return { ...item, evidence: cited.map((s) => s.id) }
  if (cited.length === 0) {
    return { status: 'uncovered', evidence: [], rationale: `${item.rationale} (downgraded: no evidence cited)`.trim() }
  }
  const hasPassedAssertion = cited.some((s) => isAssertion(s.action) && s.status === 'ok')
  if (item.status === 'covered' && !hasPassedAssertion) {
    return { status: 'partial', evidence: cited.map((s) => s.id), rationale: `${item.rationale} (downgraded: no passed assertion among the cited steps)`.trim() }
  }
  return { status: item.status, evidence: cited.map((s) => s.id), rationale: item.rationale }
}

export async function profileCoverage(projectId: string, llm: LLMRouter = defaultLlm) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      requirements: { orderBy: { createdAt: 'asc' } },
      testCases: {
        include: {
          runs: { where: { status: { in: ['passed', 'failed'] } }, orderBy: { createdAt: 'desc' }, take: 1, include: { steps: { orderBy: { index: 'asc' } } } },
        },
      },
    },
  })
  if (project.requirements.length === 0) throw new HttpError(400, 'Add requirements before profiling coverage.')
  const runs = project.testCases.flatMap((tc) => tc.runs.map((r) => ({ ...r, testCase: tc })))
  if (runs.length === 0) throw new HttpError(400, 'Run at least one test before profiling coverage.')

  const { text, steps } = buildEvidence(runs)
  const stepsByLabel = new Map(steps.map((s) => [s.label, s]))
  const reqText = project.requirements.map((r) => `${r.key}: ${r.text}`).join('\n')

  const res = await llm.reason({
    messages: [
      { role: 'system', content: COVERAGE_SYSTEM },
      { role: 'user', content: `(A) REQUIREMENTS\n${reqText}\n\n(B) EVIDENCE\n${text}` },
    ],
    json: true,
    temperature: 0,
  })
  const parsed = ItemsSchema.parse(parseJsonObject(res.content))
  const byKey = new Map(parsed.items.map((i) => [i.key.toUpperCase(), i]))

  const items = project.requirements.map((req) => {
    const raw = byKey.get(req.key.toUpperCase()) ?? { status: 'uncovered' as const, evidence: [], rationale: 'not mentioned by the analyst' }
    const g = applyCoverageGuard(raw, stepsByLabel)
    return { requirementId: req.id, status: g.status, rationale: g.rationale, evidence: JSON.stringify(g.evidence) }
  })
  const summary = {
    covered: items.filter((i) => i.status === 'covered').length,
    partial: items.filter((i) => i.status === 'partial').length,
    uncovered: items.filter((i) => i.status === 'uncovered').length,
    total: items.length,
  }
  const profile = await prisma.coverageProfile.create({
    data: { projectId, runIds: JSON.stringify(runs.map((r) => r.id)), summary: JSON.stringify(summary), items: { create: items } },
    include: { items: { include: { requirement: true } } },
  })
  return profile
}
