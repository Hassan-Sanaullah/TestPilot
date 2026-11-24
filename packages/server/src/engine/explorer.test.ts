/**
 * The explorer is what makes "press one button and get tests" possible, so it
 * has to capture the things a test author needs: each form's fields, and the
 * rules the page states in its own words.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import { prisma } from '../db'
import { constraintsFor } from '../ai/design'
import { appMapSummary, exploreApp, type FormField } from './explorer'

let server: Server
let projectId: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({
    data: { name: 'Explorer test', baseUrl: base, testUser: 'admin@example.com', testPassword: 'Admin123!' },
  })
  projectId = p.id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
  server.close()
})

describe('explorer', () => {
  it('walks the app past the cookie wall and maps its pages, forms and rules', async () => {
    const result = await exploreApp(projectId, { maxPages: 10 })
    expect(result.visited).toBeGreaterThan(4)

    const pages = await prisma.appPage.findMany({ where: { projectId } })
    const kinds = new Set(pages.map((p) => p.kind))
    expect(kinds.has('auth')).toBe(true) // /login and /register
    expect(pages.some((p) => p.url.endsWith('/cart'))).toBe(true)

    // The registration form is captured field by field, with its rule.
    const register = pages.find((p) => p.url.includes('/register'))!
    const forms = JSON.parse(register.forms) as { fields: { label: string; type: string; required: boolean }[]; submitLabel: string }[]
    const fields = forms.flatMap((f) => f.fields)
    expect(fields.map((f) => f.label)).toEqual(expect.arrayContaining(['Full name', 'Email address', 'Password', 'Confirm password']))
    expect(fields.find((f) => f.label === 'Password')?.type).toBe('password')
    expect(fields.every((f) => f.required)).toBe(true)
    expect(forms.some((f) => f.submitLabel === 'Register')).toBe(true)

    // "At least 8 characters." is the basis for a judgeable expected outcome.
    const rules = JSON.parse(register.rules) as string[]
    expect(rules.join(' ')).toMatch(/at least 8 characters/i)
  })

  it('renders a map a generator can write tests from', async () => {
    const summary = await appMapSummary(projectId)
    expect(summary).toMatch(/PAGE http/)
    expect(summary).toMatch(/\[auth\]/)
    expect(summary).toMatch(/FORM submitted by "Register"/)
    expect(summary).toMatch(/Password \(password, required/)
    expect(summary).toMatch(/RULES THE PAGE STATES/)
  })

  it('captures what each field declares as data, and recovers what it only says in words', async () => {
    const register = (await prisma.appPage.findMany({ where: { projectId } })).find((p) => p.url.includes('/register'))!
    const forms = JSON.parse(register.forms) as { fields: FormField[] }[]
    const fields = forms.flatMap((f) => f.fields)
    const password = fields.find((f) => f.label === 'Password')!

    // Declared constraints arrive as numbers, not prose — that is what lets a
    // boundary value be computed rather than guessed.
    expect(password.name).toBe('password')
    expect(fields.find((f) => f.label === 'Email address')?.type).toBe('email')

    // ShopMax declares NO minlength: like many real applications it states the
    // rule in words and enforces it in code. So the number has to be recovered
    // from the sentence, and marked as the weaker source that it is.
    expect(password.minLength).toBeUndefined()
    const rules = JSON.parse(register.rules) as string[]
    const recovered = constraintsFor(password, rules)
    expect(recovered.minLength).toBe(8)
    expect(recovered.declaredLength).toBe(false)
    expect(recovered.minLengthText).toMatch(/at least 8 characters/i)
  })

  it('finds sample items on the catalogue, so a search test can look for something real', async () => {
    const pages = await prisma.appPage.findMany({ where: { projectId } })
    const withSamples = pages.filter((p) => (JSON.parse(p.samples) as string[]).length > 0)
    expect(withSamples.length).toBeGreaterThan(0)
    const samples = JSON.parse(withSamples[0].samples) as string[]
    expect(samples.length).toBeGreaterThanOrEqual(3)
    // Distinct names, not a repeated layout cell.
    expect(new Set(samples).size).toBe(samples.length)
  })

  it('keeps the session it signed in with, so later tests need not sign in again', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(project.autoSession).toBeTruthy()
    expect(project.autoSessionAt).toBeTruthy()
  })

  it('signs in and maps the pages that do not even exist as links until you do', async () => {
    const pages = await prisma.appPage.findMany({ where: { projectId } })
    // Signed out, ShopMax's header has no link to orders or admin at all, so a
    // single-pass crawl can never reach them.
    const gated = pages.filter((p) => p.requiresAuth).map((p) => p.url)
    expect(gated.length).toBeGreaterThan(0)
    expect(gated.join(' ')).toMatch(/\/orders|\/admin/)
  })
})
