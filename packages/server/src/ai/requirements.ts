/**
 * Proposing a requirements checklist for someone who has not written one.
 *
 * It used to come from a separate depth-1 crawl of the home page, signed out.
 * That crawl saw none of the application behind the login and none of the rules
 * the pages state, so the proposed checklist missed exactly the things worth
 * testing. It now reads the app map the explorer already built, which has the
 * forms, the fields and the stated rules, from both sides of the sign-in.
 *
 * Two layers, deliberately:
 *
 *   computed  one requirement per rule the application states about itself
 *             ("Password must be at least 8 characters on Create account").
 *             These are exact, they quote their source, and the designed tests
 *             link to them automatically.
 *   written   behavioural requirements a rule cannot express ("a signed-in
 *             user can place an order"), from the model.
 */
import { z } from 'zod'
import { json, prisma } from '../db'
import { appMapSummary, exploreApp, type FormDescriptor } from '../engine/explorer'
import { constraintsFor } from './design'
import { REQUIREMENTS_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

const Schema = z.object({ requirements: z.array(z.object({ key: z.string().optional(), text: z.string().min(1) })) })

export interface ProposedRequirement {
  text: string
  /** where it came from: a rule the page states, or the model's reading of it */
  source: 'rule' | 'dom'
  pageUrl?: string
  ruleText?: string
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * One requirement per constraint the application declares, phrased as a
 * sentence a person can read and keeping the original wording so a bug report
 * can quote it.
 */
export function requirementsFromMap(pages: { url: string; kind: string; forms: FormDescriptor[]; rules: string[] }[]): ProposedRequirement[] {
  const out: ProposedRequirement[] = []
  const seen = new Set<string>()

  const push = (r: ProposedRequirement) => {
    const key = norm(r.text)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(r)
  }

  for (const page of pages) {
    if (page.kind === 'blocked') continue
    for (const form of page.forms ?? []) {
      const where = form.submitLabel || form.name
      for (const field of form.fields) {
        const c = constraintsFor(field, page.rules ?? [])
        if (field.required) {
          push({ text: `"${field.label}" is required${where ? ` on the "${where}" form` : ''}`, source: 'rule', pageUrl: page.url, ruleText: 'the field is marked required' })
        }
        if (c.minLength !== undefined && c.minLength > 1) {
          push({
            text: `"${field.label}" must be at least ${c.minLength} characters${where ? ` on the "${where}" form` : ''}`,
            source: 'rule',
            pageUrl: page.url,
            ruleText: c.minLengthText ?? `at least ${c.minLength} characters`,
          })
        }
        if (c.maxLength !== undefined) {
          push({
            text: `"${field.label}" must be at most ${c.maxLength} characters${where ? ` on the "${where}" form` : ''}`,
            source: 'rule',
            pageUrl: page.url,
            ruleText: c.maxLengthText ?? `at most ${c.maxLength} characters`,
          })
        }
        if (field.type.toLowerCase() === 'email') {
          push({ text: `"${field.label}" must be a valid email address${where ? ` on the "${where}" form` : ''}`, source: 'rule', pageUrl: page.url, ruleText: 'type="email"' })
        }
        if (field.min !== undefined && (field.type === 'number' || field.type === 'range')) {
          push({ text: `"${field.label}" must be at least ${field.min}${where ? ` on the "${where}" form` : ''}`, source: 'rule', pageUrl: page.url, ruleText: `min="${field.min}"` })
        }
        if (field.max !== undefined && (field.type === 'number' || field.type === 'range')) {
          push({ text: `"${field.label}" must be at most ${field.max}${where ? ` on the "${where}" form` : ''}`, source: 'rule', pageUrl: page.url, ruleText: `max="${field.max}"` })
        }
      }
    }
    // Rules the page states in its own words but does not declare in HTML.
    for (const rule of page.rules ?? []) {
      const text = rule.trim()
      if (text.length < 10 || text.length > 160) continue
      // Skip the ones already turned into a field requirement above.
      if ([...seen].some((s) => s.includes(norm(text)) || norm(text).includes(s))) continue
      push({ text: `The application honours its stated rule: "${text}"`, source: 'rule', pageUrl: page.url, ruleText: text })
    }
  }
  return out
}

export async function proposeRequirements(projectId: string, llm: LLMRouter = defaultLlm) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { requirements: true } })

  // The map is the input now. Build one if this application has never been
  // explored, rather than falling back to a weaker view of it.
  let pageRows = await prisma.appPage.findMany({ where: { projectId } })
  if (pageRows.length === 0) {
    await exploreApp(projectId)
    pageRows = await prisma.appPage.findMany({ where: { projectId } })
  }
  const pages = pageRows.map((p) => ({ url: p.url, kind: p.kind, forms: json<FormDescriptor[]>(p.forms, []), rules: json<string[]>(p.rules, []) }))

  const existingByText = new Map(project.requirements.map((r) => [norm(r.text), r]))
  const existingRules = new Set(project.requirements.map((r) => (r.ruleText ? norm(r.ruleText) : '')).filter(Boolean))

  const proposals: ProposedRequirement[] = requirementsFromMap(pages).filter((p) => {
    if (existingByText.has(norm(p.text))) return false
    // Two requirements derived from the same stated rule are the same
    // requirement, however differently they are phrased.
    return !(p.ruleText && existingRules.has(norm(p.ruleText)))
  })

  // The model, for behaviour no constraint can express.
  try {
    const existing = [...project.requirements.map((r) => `${r.key}: ${r.text}`), ...proposals.map((p) => `(new) ${p.text}`)].join('\n')
    const res = await llm.reason({
      messages: [
        { role: 'system', content: REQUIREMENTS_SYSTEM },
        {
          role: 'user',
          content:
            `APPLICATION: ${project.name} — ${project.baseUrl}\n` +
            (project.description ? `DESCRIPTION: ${project.description}\n` : '') +
            (existing ? `\nALREADY DEFINED (do not repeat these, and do not restate field-level validation rules — those are covered):\n${existing}\n` : '') +
            `\nMAP OF THE APPLICATION\n${await appMapSummary(projectId)}`,
        },
      ],
      json: true,
      temperature: 0.3,
    })
    const parsed = Schema.parse(parseJsonObject(res.content))
    for (const r of parsed.requirements) {
      const text = r.text.trim()
      if (!text || existingByText.has(norm(text)) || proposals.some((p) => norm(p.text) === norm(text))) continue
      proposals.push({ text, source: 'dom' })
    }
  } catch (e) {
    console.warn('[requirements] the model step was skipped:', (e as Error).message)
  }

  let n = nextKeyNumber(project.requirements.map((r) => r.key))
  const created = []
  for (const p of proposals) {
    const row = await prisma.requirement.create({
      data: { projectId, key: `R${n++}`, text: p.text, source: p.source === 'rule' ? 'rule' : 'dom', pageUrl: p.pageUrl ?? null, ruleText: p.ruleText ?? null },
    })
    created.push(row)
  }
  return { pagesCrawled: pages.map((p) => p.url), created, computed: proposals.filter((p) => p.source === 'rule').length }
}

export function nextKeyNumber(keys: string[]): number {
  let max = 0
  for (const k of keys) {
    const m = /^R(\d+)$/i.exec(k.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}
