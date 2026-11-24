import { Router } from 'express'
import { z } from 'zod'
import { json, prisma } from '../db'
import { HttpError, h, parseBody } from '../http'
import { nextKeyNumber, proposeRequirements } from '../ai/requirements'
import { exploreApp } from '../engine/explorer'
import { cancelCapture, captureStatus, clearSavedAuth, saveCapture, startCapture } from '../services/authCapture'
import { projectStats } from '../services/stats'

export const projects = Router()

const ProjectBody = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  description: z.string().max(2000).optional().default(''),
  resetUrl: z.string().url().optional().nullable(),
  testUser: z.string().max(200).optional().nullable(),
  testPassword: z.string().max(200).optional().nullable(),
  llmCallBudget: z.number().int().min(5).max(200).optional(),
  retryOnFail: z.boolean().optional(),
  allowedDomains: z.array(z.string().max(200)).optional(),
  viewportWidth: z.number().int().min(320).max(3840).optional(),
  viewportHeight: z.number().int().min(320).max(2160).optional(),
  maxSteps: z.number().int().min(3).max(120).optional(),
  dialogAction: z.enum(['accept', 'dismiss']).optional(),
  /** off when the project's tests share data and would trip over each other */
  parallel: z.boolean().optional(),
  /**
   * Values this application will actually accept: a coupon code, a product
   * name, a postcode. A test uses them as {{data.<key>}}. Never secrets — the
   * only secret is the test password, which is stored separately and never
   * shown to the model.
   */
  testData: z.record(z.string().max(200)).optional(),
})

const domainsJson = (d: string[]) => JSON.stringify(d.map((x) => x.trim()).filter(Boolean))

/** Partial patch for an update: only the fields actually supplied. */
function toPatch(data: Partial<z.infer<typeof ProjectBody>>) {
  const { allowedDomains, resetUrl, testUser, testPassword, testData, ...rest } = data
  return {
    ...rest,
    ...(allowedDomains !== undefined ? { allowedDomains: domainsJson(allowedDomains) } : {}),
    ...(resetUrl !== undefined ? { resetUrl: resetUrl || null } : {}),
    ...(testUser !== undefined ? { testUser: testUser || null } : {}),
    ...(testPassword !== undefined ? { testPassword: testPassword || null } : {}),
    ...(testData !== undefined ? { testData: JSON.stringify(testData) } : {}),
  }
}

type ProjectRow = { allowedDomains: string; testPassword: string | null; storageState: string | null; testData?: string; autoSession?: string | null }
/** Never ship the stored password to the browser; just say whether one exists. */
function toDto<T extends ProjectRow>(p: T) {
  const { testPassword, autoSession, ...rest } = p
  return {
    ...rest,
    allowedDomains: json<string[]>(p.allowedDomains, []),
    testData: json<Record<string, string>>(p.testData ?? '{}', {}),
    hasPassword: Boolean(testPassword),
    hasSavedLogin: Boolean(p.storageState),
    // The path itself is of no use to the browser; whether one exists is.
    hasAutoSession: Boolean(autoSession),
  }
}

projects.get(
  '/projects',
  h(async (_req, res) => {
    const rows = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { testCases: true, requirements: true, bugReports: true } } },
    })
    res.json(rows.map(toDto))
  }),
)

projects.post(
  '/projects',
  h(async (req, res) => {
    const { allowedDomains, resetUrl, testUser, testPassword, testData, ...rest } = parseBody(ProjectBody, req.body)
    const row = await prisma.project.create({
      data: {
        ...rest,
        allowedDomains: domainsJson(allowedDomains ?? []),
        resetUrl: resetUrl || null,
        testUser: testUser || null,
        testPassword: testPassword || null,
        testData: JSON.stringify(testData ?? {}),
      },
    })
    res.status(201).json(toDto(row))
  }),
)

projects.get(
  '/projects/:id',
  h(async (req, res) => {
    const row = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        requirements: { orderBy: { createdAt: 'asc' } },
        testCases: { orderBy: { createdAt: 'desc' }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        _count: { select: { bugReports: true, gapScenarios: true } },
      },
    })
    if (!row) throw new HttpError(404, 'project not found')
    res.json(toDto(row))
  }),
)

projects.put(
  '/projects/:id',
  h(async (req, res) => {
    const data = parseBody(ProjectBody.partial(), req.body)
    const row = await prisma.project.update({ where: { id: req.params.id }, data: toPatch(data) })
    res.json(toDto(row))
  }),
)

projects.get(
  '/projects/:id/stats',
  h(async (req, res) => {
    res.json(await projectStats(req.params.id))
  }),
)

// ---- Recorded login session (for sites behind authentication) --------------

projects.get(
  '/projects/:id/auth',
  h(async (req, res) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: req.params.id }, select: { storageState: true } })
    res.json({ ...(await captureStatus(req.params.id)), saved: Boolean(p.storageState) })
  }),
)

projects.post(
  '/projects/:id/auth/start',
  h(async (req, res) => {
    res.json(await startCapture(req.params.id))
  }),
)

projects.post(
  '/projects/:id/auth/save',
  h(async (req, res) => {
    res.json(await saveCapture(req.params.id))
  }),
)

projects.post(
  '/projects/:id/auth/cancel',
  h(async (req, res) => {
    await cancelCapture(req.params.id)
    res.json({ ok: true })
  }),
)

projects.delete(
  '/projects/:id/auth',
  h(async (req, res) => {
    await clearSavedAuth(req.params.id)
    res.status(204).end()
  }),
)

projects.delete(
  '/projects/:id',
  h(async (req, res) => {
    await prisma.project.delete({ where: { id: req.params.id } })
    res.status(204).end()
  }),
)

// ---- Requirements -----------------------------------------------------------

projects.get(
  '/projects/:id/requirements',
  h(async (req, res) => {
    res.json(await prisma.requirement.findMany({ where: { projectId: req.params.id }, orderBy: { createdAt: 'asc' } }))
  }),
)

projects.post(
  '/projects/:id/requirements',
  h(async (req, res) => {
    const { items } = parseBody(z.object({ items: z.array(z.string().min(3)).min(1) }), req.body)
    const existing = await prisma.requirement.findMany({ where: { projectId: req.params.id }, select: { key: true } })
    let n = nextKeyNumber(existing.map((r) => r.key))
    const created = []
    for (const text of items) {
      created.push(await prisma.requirement.create({ data: { projectId: req.params.id, key: `R${n++}`, text: text.trim() } }))
    }
    res.status(201).json(created)
  }),
)

projects.put(
  '/requirements/:id',
  h(async (req, res) => {
    const { text } = parseBody(z.object({ text: z.string().min(3) }), req.body)
    res.json(await prisma.requirement.update({ where: { id: req.params.id }, data: { text } }))
  }),
)

projects.delete(
  '/requirements/:id',
  h(async (req, res) => {
    await prisma.requirement.delete({ where: { id: req.params.id } })
    res.status(204).end()
  }),
)

projects.post(
  '/projects/:id/requirements/propose',
  h(async (req, res) => {
    res.json(await proposeRequirements(req.params.id))
  }),
)

// ---- Element inventory (DOM knowledge) ------------------------------------

projects.get(
  '/projects/:id/inventory',
  h(async (req, res) => {
    res.json(await prisma.elementInventory.findMany({ where: { projectId: req.params.id }, orderBy: [{ url: 'asc' }, { label: 'asc' }] }))
  }),
)

// ---- Application map (explorer) -------------------------------------------

projects.post(
  '/projects/:id/explore',
  h(async (req, res) => {
    const r = await exploreApp(req.params.id)
    res.json({ visited: r.visited, loggedIn: r.loggedIn, pages: r.pages.map((p) => ({ url: p.url, kind: p.kind, title: p.title, forms: p.forms.length, requiresAuth: p.requiresAuth })) })
  }),
)

projects.get(
  '/projects/:id/map',
  h(async (req, res) => {
    const pages = await prisma.appPage.findMany({ where: { projectId: req.params.id }, orderBy: [{ kind: 'asc' }, { url: 'asc' }] })
    res.json({
      pages: pages.map((p) => ({
        ...p,
        forms: json<unknown[]>(p.forms, []),
        actions: json<string[]>(p.actions, []),
        rules: json<string[]>(p.rules, []),
        headings: json<string[]>(p.headings, []),
      })),
      // Things worth testing, named after what this application actually has —
      // never a hardcoded list of e-commerce words.
      topics: suggestTopics(pages),
    })
  }),
)

/** Derive "what could I test here?" prompts from the discovered pages. */
function suggestTopics(pages: { kind: string; forms: string; headings: string; requiresAuth: boolean }[]): string[] {
  const topics = new Set<string>()
  const kindTopic: Record<string, string> = {
    auth: 'signing in',
    checkout: 'the checkout',
    cart: 'the cart',
    admin: 'the admin area',
    listing: 'searching and filtering',
    detail: 'a single item page',
  }
  for (const p of pages) {
    const t = kindTopic[p.kind]
    if (t) topics.add(t)
    if (p.requiresAuth) topics.add('pages that need a login')
    // Name forms after their own heading, e.g. "Create an account".
    const forms = json<{ submitLabel?: string }[]>(p.forms, [])
    for (const f of forms) {
      const label = (f.submitLabel ?? '').trim()
      if (!label || label.length >= 24) continue
      // Skip generic chrome, and anything destructive — nobody wants "test the
      // delete-everything button" offered as a friendly suggestion.
      if (/^(search|go|apply|ok|submit|close|×|next|previous|update)$/i.test(label)) continue
      if (/(log ?out|sign ?out|delete|remove|cancel|clear|reset|deactivate)/i.test(label)) continue
      topics.add(`the "${label}" form`)
    }
  }
  return [...topics].slice(0, 7)
}
