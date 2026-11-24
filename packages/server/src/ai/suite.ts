/**
 * "What do you want to test?" — turns a few words, or nothing at all, into a
 * set of complete test cases.
 *
 * This is the path for someone with no testing experience: they type
 * "password rules" and get the cases a professional would write, each with an
 * explicit expected outcome. Writing a long instruction by hand stays
 * available, but it is no longer the price of entry.
 */
import { z } from 'zod'
import { lintInstruction } from '@testpilot/shared'
import { json, prisma } from '../db'
import { appMapSummary, exploreApp, type DiscoveredPage } from '../engine/explorer'
import { inventorySummary } from '../engine/inventory'
import { designTests, type TestDesign } from './design'
import { jaccard, nearest } from './gapFilter'
import { SUITE_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

const Schema = z.object({
  tests: z.array(
    z.object({
      title: z.string().min(1).max(160),
      instruction: z.string().min(20).max(4000),
      kind: z.enum(['happy-path', 'negative', 'edge']).default('happy-path'),
      why: z.string().default(''),
    }),
  ),
})

export interface DraftTest {
  title: string
  instruction: string
  kind: 'happy-path' | 'negative' | 'edge' | 'flow'
  why: string
  /** already covered by an existing test case */
  duplicateOf?: string
  /** deterministic quality check on the generated text */
  warnings: string[]
  /**
   * `designed` = computed from the application's own declared constraints;
   * `model` = written by the model for something that cannot be computed.
   * Worth showing the user: one is repeatable, the other is a suggestion.
   */
  source: 'designed' | 'model'
  technique?: string
  area?: string
  targetUrl?: string
  targetForm?: string
  targetField?: string
  designKey?: string
  oracle?: string
  oracleText?: string
  auth?: string
  priority?: number
  requirementKeys?: string[]
}

export interface SuiteResult {
  drafts: DraftTest[]
  crawled: string[]
  message: string
  /** things the designer could not do, and why */
  notes: string[]
}

/** Area words a person would use, mapped to the explorer's page kinds. */
const AREA_WORDS: Record<string, string[]> = {
  auth: ['login', 'log in', 'signin', 'sign in', 'signup', 'sign up', 'register', 'registration', 'password', 'account', 'auth'],
  checkout: ['checkout', 'payment', 'pay', 'order', 'shipping', 'billing'],
  cart: ['cart', 'basket', 'trolley'],
  listing: ['search', 'filter', 'sort', 'catalogue', 'catalog', 'listing', 'browse', 'results', 'pagination'],
  admin: ['admin', 'administrator', 'management', 'back office'],
  form: ['form', 'field', 'validation', 'input'],
}

/** Does this design match what the user asked for? */
function matchesTopic(d: TestDesign, topic: string): boolean {
  const t = topic.toLowerCase()
  if (!t) return true
  const words = t.split(/[^a-z]+/).filter((w) => w.length >= 3)
  const haystack = [d.title, d.pageUrl, d.form, d.field ?? '', d.technique, d.area].join(' ').toLowerCase()
  if (words.some((w) => haystack.includes(w))) return true
  // "test the login" should reach pages the explorer classified as `auth`.
  for (const [area, synonyms] of Object.entries(AREA_WORDS)) {
    if (d.area === area && synonyms.some((syn) => t.includes(syn))) return true
  }
  return false
}

export async function generateTests(
  projectId: string,
  opts: { prompt?: string; explore?: boolean; llm?: LLMRouter } = {},
): Promise<SuiteResult> {
  const llm = opts.llm ?? defaultLlm
  const topic = (opts.prompt ?? '').trim()
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })

  // Explore when asked, or when we have never looked at this application.
  const known = await prisma.appPage.count({ where: { projectId } })
  const crawled: string[] = []
  if (opts.explore || known === 0) {
    const r = await exploreApp(projectId)
    crawled.push(...r.pages.map((p) => p.url))
  }

  const [appMap, inventory, requirements, existing, pageRows] = await Promise.all([
    appMapSummary(projectId),
    inventorySummary(projectId, 8, 20),
    prisma.requirement.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 30 }),
    prisma.testCase.findMany({ where: { projectId }, select: { id: true, title: true, instruction: true, designKey: true } }),
    prisma.appPage.findMany({ where: { projectId } }),
  ])

  // ---- Layer one: tests computed from the application's own constraints.
  // These need no model, so they exist even with no API key configured, and
  // the same application always yields the same set.
  const pages: DiscoveredPage[] = pageRows.map((p) => ({
    url: p.url,
    title: p.title,
    kind: p.kind,
    forms: json(p.forms, []),
    actions: json(p.actions, []),
    rules: json(p.rules, []),
    headings: json(p.headings, []),
    samples: json(p.samples, []),
    reachedVia: p.reachedVia,
    requiresAuth: p.requiresAuth,
  }))
  const designed = designTests({ pages, testUser: project.testUser, testData: json(project.testData, {}) })
  const alreadyDesigned = new Set(existing.map((t) => t.designKey).filter(Boolean) as string[])
  let designs = designed.designs.filter((d) => !alreadyDesigned.has(d.designKey))
  if (topic) designs = designs.filter((d) => matchesTopic(d, topic))

  const designDrafts: DraftTest[] = designs.map((d) => ({
    title: d.title,
    instruction: d.instruction,
    kind: d.kind,
    why: `${describeTechnique(d)} — the page states: ${d.oracleText}`,
    warnings: lintInstruction(d.instruction).map((i) => i.message),
    source: 'designed',
    technique: d.technique,
    area: d.area,
    targetUrl: d.pageUrl,
    targetForm: d.form,
    targetField: d.field,
    designKey: d.designKey,
    oracle: d.oracle,
    oracleText: d.oracleText,
    auth: d.auth,
    priority: d.priority,
  }))

  // ---- Layer two: the model, for what cannot be computed — business flows,
  // what "a successful checkout" means. Skipped entirely when no provider is
  // configured, so the designed suite above is still delivered.
  if (!hasProvider(llm)) {
    return {
      drafts: designDrafts,
      crawled,
      notes: [...designed.notes, 'No AI provider is configured, so only the tests that can be computed from the application itself were produced. Add a key in .env to get flow tests as well.'],
      message: `${designDrafts.length} test${designDrafts.length === 1 ? '' : 's'} designed from the application's own rules`,
    }
  }

  const res = await llm.reason({
    messages: [
      { role: 'system', content: SUITE_SYSTEM },
      {
        role: 'user',
        content:
          `APPLICATION: ${project.name} — ${project.baseUrl}\n` +
          (project.description ? `DESCRIPTION: ${project.description}\n` : '') +
          (project.testUser ? `A test account exists: ${project.testUser} (use {{test_user}} / {{test_password}}).\n` : '') +
          (requirements.length ? `\nREQUIREMENTS CHECKLIST\n${requirements.map((r) => `${r.key}: ${r.text}`).join('\n')}\n` : '') +
          (existing.length ? `\nTESTS THAT ALREADY EXIST (do not repeat these)\n${existing.map((t) => `- ${t.title}: ${t.instruction.slice(0, 160)}`).join('\n')}\n` : '') +
          (designDrafts.length
            ? `\nALREADY DESIGNED — do not repeat these. Field-level validation, boundaries and required fields are covered mechanically; write the FLOWS and business rules they cannot express.\n${designDrafts.map((d) => `- ${d.title}`).join('\n')}\n`
            : '') +
          `\nMAP OF THE APPLICATION\n${appMap || inventory}\n\n` +
          (topic ? `WHAT THEY WANT TESTED: ${topic}` : 'WHAT THEY WANT TESTED: nothing specific — cover the most important behaviours of the whole application.'),
      },
    ],
    json: true,
    temperature: 0.3,
  })

  const { tests } = Schema.parse(parseJsonObject(res.content))

  // Filter against what already exists, against the designed set, and against
  // each other.
  const existingText = existing.map((t) => `${t.title}. ${t.instruction}`)
  const designedText = designDrafts.map((d) => `${d.title}. ${d.instruction}`)
  const modelDrafts: DraftTest[] = []
  for (const t of tests) {
    const text = `${t.title}. ${t.instruction}`
    const near = nearest(text, existingText)
    const selfDup = modelDrafts.some((d) => jaccard(text, `${d.title}. ${d.instruction}`) >= 0.8)
    if (selfDup) continue
    const overlapsDesigned = nearest(text, designedText)
    modelDrafts.push({
      ...t,
      duplicateOf:
        near && near.score >= 0.8
          ? existing[near.index].title
          : overlapsDesigned && overlapsDesigned.score >= 0.8
            ? designDrafts[overlapsDesigned.index].title
            : undefined,
      // The generator is held to the same standard we hold the user to.
      warnings: lintInstruction(t.instruction).map((i) => i.message),
      source: 'model',
    })
  }

  // Designed first: they are the repeatable ones.
  const drafts = [...designDrafts, ...modelDrafts]
  const usable = drafts.filter((d) => !d.duplicateOf).length
  return {
    drafts,
    crawled,
    notes: designed.notes,
    message: topic
      ? `${usable} test${usable === 1 ? '' : 's'} for "${topic}" — ${designDrafts.length} designed from the application's rules, ${modelDrafts.length} written by the AI`
      : `${usable} test${usable === 1 ? '' : 's'} covering the application — ${designDrafts.length} designed from its own rules, ${modelDrafts.length} written by the AI`,
  }
}

/** Plain words for a technique, for someone who is not a tester. */
function describeTechnique(d: TestDesign): string {
  switch (d.technique) {
    case 'boundary':
      return 'a boundary case: the value right at the edge of what the rule allows'
    case 'required':
      return 'a required field left empty'
    case 'format':
      return 'a value of the wrong kind'
    case 'equivalence':
      return 'two values that must agree'
    case 'uniqueness':
      return 'a value that is already taken'
    case 'selection':
      return 'one of the options the page offers'
    case 'flow':
      return 'a sequence a user would actually perform'
    default:
      return 'designed from the application'
  }
}

/** Is any real model available, or would this be the mock standing in? */
function hasProvider(llm: LLMRouter): boolean {
  return llm.order('reason').some((p) => p.name !== 'mock' && p.configured)
}
