/**
 * What is NOT tested yet — from three sources, cheapest and most certain first.
 *
 *   1. Designs with no test case. Computed from the application's own declared
 *      constraints, so each one already knows the rule it would check. Free,
 *      deterministic, and the most valuable gaps there are.
 *   2. Structural gaps: forms never submitted, pages never visited. The
 *      application says these exist and no test touches them.
 *   3. Requirement gaps: requirements that are uncovered, partly tested, or
 *      VIOLATED with only one test behind them. This is where the model earns
 *      its keep, because a requirement is prose.
 *
 * De-duplication changed too. The old filter rejected anything with 80% word
 * overlap, which meant "register with a valid email" and "register with an
 * INVALID email" were treated as the same test and the negative case was
 * silently dropped. Designs now de-duplicate on their key — exactly, with no
 * fuzzy matching — and model candidates must agree on page, form, kind AND
 * requirement before overlap is even consulted.
 */
import { z } from 'zod'
import { json, prisma } from '../db'
import { type DiscoveredPage, type FormDescriptor, shapeOf } from '../engine/explorer'
import { inventorySummary } from '../engine/inventory'
import { designTests, type TestDesign } from './design'
import { checkFeasibility, jaccard } from './gapFilter'
import { GAPS_SYSTEM } from './prompts'
import { computeStructuralCoverage } from './structural'
import { computeCoverage } from './traceability'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

const CandidatesSchema = z.object({
  candidates: z.array(
    z.object({
      title: z.string().min(1),
      instruction: z.string().min(1),
      requirementKey: z.string().optional(),
      targetUrl: z.string().optional(),
      targetForm: z.string().optional(),
      kind: z.enum(['happy-path', 'negative', 'edge', 'flow']).default('flow'),
      neededUi: z.array(z.string()).default([]),
    }),
  ),
})

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** The identity of a model-written candidate, for de-duplication. */
const candidateKey = (c: { targetUrl?: string; targetForm?: string; kind: string; requirementKey?: string }): string =>
  [c.targetUrl ? shapeOf(c.targetUrl) : '', norm(c.targetForm ?? ''), c.kind, (c.requirementKey ?? '').toUpperCase()].join('|')

export async function generateGaps(projectId: string, llm: LLMRouter = defaultLlm) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      requirements: { orderBy: { createdAt: 'asc' } },
      testCases: { select: { id: true, title: true, instruction: true, designKey: true, targetUrl: true, targetForm: true, kind: true } },
      gapScenarios: { where: { status: { in: ['suggested', 'accepted', 'converted'] } } },
    },
  })

  const pageRows = await prisma.appPage.findMany({ where: { projectId } })
  const pages: DiscoveredPage[] = pageRows.map((p) => ({
    url: p.url,
    title: p.title,
    kind: p.kind,
    forms: json<FormDescriptor[]>(p.forms, []),
    actions: json(p.actions, []),
    rules: json(p.rules, []),
    headings: json(p.headings, []),
    samples: json(p.samples, []),
    reachedVia: p.reachedVia,
    requiresAuth: p.requiresAuth,
  }))

  const [coverage, structural] = await Promise.all([computeCoverage(projectId), computeStructuralCoverage(projectId)])

  type Candidate = {
    title: string
    instruction: string
    rationale: string
    requirementId?: string | null
    designKey?: string
    feasibility: 'feasible' | 'infeasible' | 'unknown'
    neededUi: string[]
    priority: number
    duplicateOf?: string | null
    dupReason?: string
  }
  const candidates: Candidate[] = []

  // ---------------------------------------------------- 1. unrun designs
  const designed = designTests({ pages, testUser: project.testUser, testData: json(project.testData, {}) })
  const haveKeys = new Set(project.testCases.map((t) => t.designKey).filter(Boolean) as string[])
  const suggestedKeys = new Set(project.gapScenarios.map((g) => g.duplicateOf).filter(Boolean) as string[])

  const requirementForRule = new Map(project.requirements.filter((r) => r.ruleText).map((r) => [norm(r.ruleText!), r.id]))

  for (const d of designed.designs) {
    if (haveKeys.has(d.designKey) || suggestedKeys.has(d.designKey)) continue
    candidates.push({
      title: d.title,
      instruction: d.instruction,
      rationale: `No test exercises the rule ${d.oracleText} on "${d.form}".`,
      requirementId: requirementForRule.get(norm(d.oracleText)) ?? null,
      designKey: d.designKey,
      feasibility: 'feasible', // it was derived from the page's own structure
      neededUi: [d.form, d.field].filter(Boolean) as string[],
      priority: d.priority,
    })
  }

  // ---------------------------------------------------- 2. structural gaps
  const untouchedForms = structural.forms.missing.slice(0, 6)
  const unvisitedPages = structural.pages.missing.slice(0, 6)
  const designedTargets = new Set(designed.designs.map((d) => `${shapeOf(d.pageUrl)}|${norm(d.form)}`))

  const structuralTargets = untouchedForms.filter((f) => {
    // Only mention a form the design engine could not already cover.
    const match = /on (\S+)$/.exec(f.replace(/ \(.*\)$/, ''))
    const url = match?.[1]
    if (!url) return true
    return ![...designedTargets].some((t) => t.startsWith(`${shapeOf(url)}|`))
  })

  // ---------------------------------------------------- 3. requirement gaps
  const needingTests = coverage.rows.filter((r) => r.status === 'uncovered' || r.status === 'partial' || (r.status === 'violated' && r.tests.length < 2))

  const askModel = (structuralTargets.length > 0 || unvisitedPages.length > 0 || needingTests.length > 0) && hasProvider(llm)
  if (askModel) {
    try {
      const inventory = await inventorySummary(projectId)
      const body =
        `APPLICATION: ${project.baseUrl}\n\n` +
        (needingTests.length
          ? `REQUIREMENTS THAT NEED A TEST\n${needingTests.map((r) => `${r.key} [${r.status}]: ${r.text}${r.status === 'violated' ? ' (a test for this is failing — a second test would confirm the defect)' : ''}`).join('\n')}\n\n`
          : '') +
        (structuralTargets.length ? `FORMS NO TEST HAS EVER SUBMITTED\n${structuralTargets.join('\n')}\n\n` : '') +
        (unvisitedPages.length ? `PAGES NO TEST HAS EVER OPENED\n${unvisitedPages.join('\n')}\n\n` : '') +
        `TESTS THAT ALREADY EXIST\n${project.testCases.map((t) => `- ${t.title}`).join('\n') || '(none)'}\n\n` +
        `ALREADY DESIGNED MECHANICALLY — do not repeat. Field validation, boundaries and required fields are covered; write FLOWS.\n${designed.designs
          .slice(0, 30)
          .map((d) => `- ${d.title}`)
          .join('\n') || '(none)'}\n\n` +
        `OBSERVED UI INVENTORY\n${inventory}`

      const res = await llm.reason({
        messages: [
          { role: 'system', content: GAPS_SYSTEM },
          { role: 'user', content: body },
        ],
        json: true,
        temperature: 0.3,
      })
      const parsed = CandidatesSchema.parse(parseJsonObject(res.content))
      const reqByKey = new Map(project.requirements.map((r) => [r.key.toUpperCase(), r]))
      const inventoryLabels = (await prisma.elementInventory.findMany({ where: { projectId }, select: { label: true } })).map((r) => r.label)

      const existingKeys = new Map(
        project.testCases.map((t) => [candidateKey({ targetUrl: t.targetUrl ?? undefined, targetForm: t.targetForm ?? undefined, kind: t.kind }), t]),
      )

      for (const c of parsed.candidates) {
        const key = candidateKey(c)
        const text = `${c.title}. ${c.instruction}`

        // Two candidates are the same test only when they target the same
        // thing in the same way AND read alike. Overlap alone no longer
        // rejects anything, which is what used to drop negative cases.
        const sameTarget = existingKeys.get(key)
        const overlap = sameTarget ? jaccard(text, `${sameTarget.title}. ${sameTarget.instruction}`) : 0
        const dup = sameTarget && overlap >= 0.6

        const feasible = feasibilityOf(c, pages, inventoryLabels)
        const req = c.requirementKey ? reqByKey.get(c.requirementKey.toUpperCase()) : undefined
        const status = req ? coverage.rows.find((r) => r.requirementId === req.id)?.status : undefined

        candidates.push({
          title: c.title,
          instruction: c.instruction,
          rationale: [
            req ? `targets ${req.key} (${status ?? 'uncovered'})` : 'covers a form or page no test touches',
            dup ? `rejected: already covered by "${sameTarget!.title}"` : null,
            feasible.feasibility === 'infeasible' ? `infeasible: ${feasible.reason}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          requirementId: req?.id ?? null,
          feasibility: feasible.feasibility,
          neededUi: c.neededUi,
          priority: status === 'violated' ? 1 : 2,
          duplicateOf: dup ? sameTarget!.id : null,
          dupReason: dup ? `the same target and wording as "${sameTarget!.title}"` : undefined,
        })
      }
    } catch (e) {
      console.warn('[gaps] the model step was skipped:', (e as Error).message)
    }
  }

  // A requirement with a failing test and no second test comes first: that is
  // where a confirming test is worth the most.
  candidates.sort((a, b) => a.priority - b.priority)

  const created = []
  for (const c of candidates) {
    const row = await prisma.gapScenario.create({
      data: {
        projectId,
        requirementId: c.requirementId ?? null,
        title: c.title,
        instruction: c.instruction,
        status: c.duplicateOf ? 'rejected' : 'suggested',
        rationale: c.rationale,
        feasibility: c.feasibility,
        neededUi: JSON.stringify(c.neededUi),
        // For a design this holds its key, so re-running the finder cannot
        // suggest the same design twice.
        duplicateOf: c.duplicateOf ?? c.designKey ?? null,
      },
    })
    created.push(row)
  }

  const kept = created.filter((c) => c.status === 'suggested').length
  return {
    created,
    notes: designed.notes,
    message:
      created.length === 0
        ? 'Nothing is missing that TestPilot can see — every rule the application states has a test, and every form has been submitted.'
        : `${kept} missing test${kept === 1 ? '' : 's'} found${created.length - kept > 0 ? ` (${created.length - kept} were already covered)` : ''}`,
  }
}

/**
 * Can this test actually be performed? The strong check is whether the page and
 * form it names exist in the map; the old label-overlap test is kept only for
 * candidates that named no target.
 */
function feasibilityOf(
  c: { targetUrl?: string; targetForm?: string; neededUi: string[] },
  pages: DiscoveredPage[],
  inventoryLabels: string[],
): { feasibility: 'feasible' | 'infeasible' | 'unknown'; reason: string } {
  if (c.targetUrl) {
    const shape = shapeOf(c.targetUrl)
    const page = pages.find((p) => shapeOf(p.url) === shape)
    if (!page) return { feasibility: 'infeasible', reason: `no page like ${c.targetUrl} was found in the application` }
    if (c.targetForm) {
      const found = (page.forms ?? []).some((f) => norm(f.submitLabel).includes(norm(c.targetForm!)) || norm(f.name).includes(norm(c.targetForm!)) || norm(c.targetForm!).includes(norm(f.submitLabel)))
      if (!found) return { feasibility: 'infeasible', reason: `${c.targetUrl} has no form matching "${c.targetForm}"` }
    }
    return { feasibility: 'feasible', reason: 'the page and form exist' }
  }
  const fallback = checkFeasibility(c.neededUi, inventoryLabels)
  return { feasibility: fallback.feasibility, reason: fallback.missing.length ? `not seen: ${fallback.missing.join(', ')}` : 'no target was named' }
}

function hasProvider(llm: LLMRouter): boolean {
  return llm.order('reason').some((p) => p.name !== 'mock' && p.configured)
}

export type { TestDesign }
