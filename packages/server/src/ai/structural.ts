/**
 * Coverage for someone who has not written a requirements list — which is most
 * people, most of the time.
 *
 * Requirement coverage can only answer "of the things you wrote down, how many
 * are tested?". If you wrote nothing down it has nothing to say, and the old
 * implementation simply refused. But the application itself is a specification
 * of sorts: it has pages, forms, fields and stated rules, and how many of those
 * a suite touches is a real, checkable number.
 *
 * Deliberately conservative. A step that cannot be matched to a field counts
 * for nothing: a coverage figure that flatters the suite is worse than none.
 */
import type { Action } from '@testpilot/shared'
import { json, prisma } from '../db'
import { shapeOf, type FormDescriptor } from '../engine/explorer'

export interface Measure {
  /** how many were touched */
  covered: number
  /** how many exist */
  total: number
  /** the names of a few that were not, so the number is actionable */
  missing: string[]
}

export interface StructuralCoverage {
  pages: Measure
  forms: Measure
  fields: Measure
  rules: Measure
  /** 0–100 across all four, for a single headline number */
  overall: number
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Does a step's target plausibly refer to this field? */
function matchesField(stepLabel: string, fieldLabel: string): boolean {
  const a = norm(stepLabel)
  const b = norm(fieldLabel)
  if (!a || !b) return false
  if (a === b) return true
  // Containment only in the direction that is safe: a locator description is
  // usually longer than the label ("textbox Email address" vs "Email address").
  return b.length >= 4 && a.includes(b)
}

const pct = (m: Measure): number => (m.total === 0 ? 100 : Math.round((100 * m.covered) / m.total))

export async function computeStructuralCoverage(projectId: string): Promise<StructuralCoverage> {
  const [pages, cases] = await Promise.all([
    prisma.appPage.findMany({ where: { projectId } }),
    prisma.testCase.findMany({
      where: { projectId },
      select: {
        id: true,
        quarantined: true,
        oracleText: true,
        runs: {
          where: { kind: 'normal', status: { in: ['passed', 'failed'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, steps: { orderBy: { index: 'asc' }, select: { action: true, url: true, locator: true, status: true } } },
        },
      },
    }),
  ])

  // Every step of every test's most recent deciding run.
  const steps = cases
    .filter((c) => !c.quarantined)
    .flatMap((c) => c.runs[0]?.steps ?? [])
    .map((s) => ({
      action: json<Action | null>(s.action, null),
      url: s.url,
      shape: s.url ? shapeOf(s.url) : '',
      locator: s.locator ? (json<{ description?: string } | null>(s.locator, null)?.description ?? '') : '',
      ok: s.status === 'ok',
    }))

  const visitedShapes = new Set(steps.filter((s) => s.shape).map((s) => s.shape))

  // ---- pages
  const pageMeasure: Measure = { covered: 0, total: 0, missing: [] }
  for (const p of pages) {
    if (p.kind === 'blocked') continue
    pageMeasure.total++
    if (visitedShapes.has(shapeOf(p.url))) pageMeasure.covered++
    else if (pageMeasure.missing.length < 8) pageMeasure.missing.push(p.url)
  }

  // ---- forms and fields
  const formMeasure: Measure = { covered: 0, total: 0, missing: [] }
  const fieldMeasure: Measure = { covered: 0, total: 0, missing: [] }

  for (const page of pages) {
    const shape = shapeOf(page.url)
    const forms = json<FormDescriptor[]>(page.forms, [])
    const onThisPage = steps.filter((s) => s.shape === shape)

    for (const form of forms) {
      const dataFields = form.fields.filter((f) => f.type !== 'hidden' && f.type !== 'submit')
      if (dataFields.length === 0) continue
      formMeasure.total++

      const typedFields = new Set<string>()
      for (const field of dataFields) {
        fieldMeasure.total++
        const touched = onThisPage.some((s) => {
          const a = s.action
          if (!a || (a.type !== 'type' && a.type !== 'select' && a.type !== 'upload')) return false
          const label = s.locator || ('text' in a ? String((a as { text?: string }).text ?? '') : '')
          return matchesField(label, field.label)
        })
        if (touched) {
          typedFields.add(field.label)
          fieldMeasure.covered++
        } else if (fieldMeasure.missing.length < 10) {
          fieldMeasure.missing.push(`${field.label} (${page.url})`)
        }
      }

      // A form counts as covered only when something was entered AND the form
      // was submitted: filling a field and walking away tests nothing.
      const submitted = onThisPage.some((s) => {
        const a = s.action
        if (!a) return false
        if (a.type === 'type' && a.submit) return true
        if (a.type === 'click' && form.submitLabel) return matchesField(s.locator, form.submitLabel)
        return false
      })
      if (typedFields.size > 0 && submitted) formMeasure.covered++
      else if (formMeasure.missing.length < 8) {
        formMeasure.missing.push(`${form.submitLabel || form.name || 'a form'} on ${page.url}${typedFields.size > 0 ? ' (filled in but never submitted)' : ''}`)
      }
    }
  }

  // ---- stated rules
  const ruleMeasure: Measure = { covered: 0, total: 0, missing: [] }
  const testedRules = new Set(cases.filter((c) => c.oracleText && c.runs.length > 0).map((c) => norm(c.oracleText!)))
  for (const page of pages) {
    for (const rule of json<string[]>(page.rules, [])) {
      if (!rule.trim()) continue
      ruleMeasure.total++
      const key = norm(rule)
      const tested = testedRules.has(key) || [...testedRules].some((t) => t.length >= 8 && (t.includes(key) || key.includes(t)))
      if (tested) ruleMeasure.covered++
      else if (ruleMeasure.missing.length < 10) ruleMeasure.missing.push(rule.slice(0, 120))
    }
  }

  const parts = [pageMeasure, formMeasure, fieldMeasure, ruleMeasure]
  const weighted = parts.filter((m) => m.total > 0)
  const overall = weighted.length === 0 ? 0 : Math.round(weighted.reduce((a, m) => a + pct(m), 0) / weighted.length)

  return { pages: pageMeasure, forms: formMeasure, fields: fieldMeasure, rules: ruleMeasure, overall }
}
