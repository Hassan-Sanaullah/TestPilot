/**
 * The claim, end to end, on a real application: explore ShopMax and the right
 * tests fall out of its own markup, with no model involved.
 *
 * The one that matters most is the seven-character password. ShopMax declares
 * no `minlength` — like a great many real applications it states the rule in
 * words ("At least 8 characters.") and enforces it in code. So the chain has to
 * hold all the way through: the explorer must attach that sentence to the
 * Password field, the design engine must read the number out of it, and the
 * value it builds must differ from a valid password in LENGTH ONLY. ShopMax's
 * seeded bug 5 accepts a short password when it contains a digit, so a test
 * using "123" is refused for the wrong reason and never finds it.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import { json, prisma } from '../db'
import { closeSharedBrowser } from '../engine/browserPool'
import { exploreApp, type DiscoveredPage, type FormDescriptor } from '../engine/explorer'
import { designTests, type TestDesign } from './design'

let server: Server
let projectId: string
let designs: TestDesign[]
let notes: string[]

beforeAll(async () => {
  server = createShopApp().listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({
    data: { name: 'Design integration', baseUrl: base, testUser: 'test@example.com', testPassword: 'Password123!' },
  })
  projectId = p.id
  await exploreApp(projectId, { maxPages: 10 })

  const rows = await prisma.appPage.findMany({ where: { projectId } })
  const pages: DiscoveredPage[] = rows.map((r) => ({
    url: r.url,
    title: r.title,
    kind: r.kind,
    forms: json<FormDescriptor[]>(r.forms, []),
    actions: json(r.actions, []),
    rules: json(r.rules, []),
    headings: json(r.headings, []),
    samples: json(r.samples, []),
    reachedVia: r.reachedVia,
    requiresAuth: r.requiresAuth,
  }))
  const result = designTests({ pages, testUser: 'test@example.com' })
  designs = result.designs
  notes = result.notes
}, 120_000)

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await closeSharedBrowser()
  await prisma.$disconnect()
  server.close()
})

describe('designing tests for ShopMax from its own markup', () => {
  it('produces tests at all, with no model involved', () => {
    expect(designs.length).toBeGreaterThan(5)
    void notes
  })

  it('designs the seven-character password case, from a rule stated only in words', () => {
    const boundary = designs.find((d) => d.technique === 'boundary' && d.field === 'Password' && d.title.includes('7 characters'))
    expect(boundary, `no 7-character password design among: ${designs.map((d) => d.title).join(' | ')}`).toBeTruthy()

    expect(boundary!.expectAccepted).toBe(false)
    // The rule came from the sentence on the page, so it is quoted and marked
    // as the weaker source it is.
    expect(boundary!.confidence).toBe('parsed-text')
    expect(boundary!.oracleText).toMatch(/at least 8 characters/i)

    const value = boundary!.input['Password']
    expect(value).toHaveLength(7)
    // Length is the ONLY thing wrong with it.
    expect(value).toMatch(/[A-Z]/)
    expect(value).toMatch(/[a-z]/)
    expect(value).toMatch(/[0-9]/)
    expect(value).toMatch(/[^A-Za-z0-9]/)
    // And the confirmation field follows it, or the test fails for that reason.
    expect(boundary!.input['Confirm password']).toBe(value)
  })

  it('designs the eight-character case too, which must be accepted', () => {
    const atMin = designs.find((d) => d.technique === 'boundary' && d.field === 'Password' && d.title.includes('exactly 8'))
    expect(atMin).toBeTruthy()
    expect(atMin!.expectAccepted).toBe(true)
    expect(atMin!.input['Password']).toHaveLength(8)
  })

  it('designs a required-field case for every required field of the registration form', () => {
    const required = designs.filter((d) => d.technique === 'required' && d.form === 'Register')
    expect(required.map((d) => d.field)).toEqual(expect.arrayContaining(['Full name', 'Email address', 'Password']))
    expect(required.every((d) => !d.expectAccepted)).toBe(true)
  })

  it('designs a malformed-email case from type="email"', () => {
    const format = designs.find((d) => d.technique === 'format' && d.field === 'Email address')
    expect(format).toBeTruthy()
    expect(format!.input['Email address']).toBe('not-an-email')
    expect(format!.oracleText).toBe('type="email"')
    expect(format!.confidence).toBe('declared')
  })

  it('designs a mismatched-confirmation case', () => {
    const mismatch = designs.find((d) => d.technique === 'equivalence' && d.field === 'Confirm password')
    expect(mismatch).toBeTruthy()
    expect(mismatch!.input['Confirm password']).not.toBe(mismatch!.input['Password'])
    expect(mismatch!.expectAccepted).toBe(false)
  })

  it('designs a search test that looks for a product that exists', () => {
    const search = designs.find((d) => d.technique === 'flow' && /Searching for/.test(d.title))
    expect(search).toBeTruthy()
    // The term came from a sample item the explorer actually saw.
    expect(search!.instruction).toMatch(/Search for "/)
  })

  it('writes every instruction with its expected outcome and its rule', () => {
    for (const d of designs) {
      if (d.technique === 'flow') continue
      expect(d.instruction).toMatch(/Verify that the submission is (ACCEPTED|REJECTED)/)
      expect(d.instruction).toContain('The page states:')
    }
  })

  it('gives every design a distinct key, as the database requires', () => {
    const keys = designs.map((d) => d.designKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is reproducible: exploring is not needed twice to get the same tests', async () => {
    const rows = await prisma.appPage.findMany({ where: { projectId } })
    const pages: DiscoveredPage[] = rows.map((r) => ({
      url: r.url,
      title: r.title,
      kind: r.kind,
      forms: json<FormDescriptor[]>(r.forms, []),
      actions: json(r.actions, []),
      rules: json(r.rules, []),
      headings: json(r.headings, []),
      samples: json(r.samples, []),
      reachedVia: r.reachedVia,
      requiresAuth: r.requiresAuth,
    }))
    const again = designTests({ pages, testUser: 'test@example.com' })
    expect(again.designs.map((d) => d.designKey)).toEqual(designs.map((d) => d.designKey))
  })
})
