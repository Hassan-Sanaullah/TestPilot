/**
 * The seeded defects must genuinely switch off.
 *
 * This is what makes the evaluation mean anything. "TestPilot found 5 of 5
 * seeded bugs" is not a result on its own — a tool that called everything
 * broken would score the same. The same suite has to run against a shop that
 * behaves correctly, where the right answer is zero reports, and that is only
 * possible if turning the defects off really does fix the behaviour.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'

let buggy: Server
let correct: Server
let buggyUrl: string
let correctUrl: string

beforeAll(() => {
  buggy = createShopApp().listen(0) // the default: all five live
  correct = createShopApp({ bugs: [] }).listen(0)
  buggyUrl = `http://127.0.0.1:${(buggy.address() as AddressInfo).port}`
  correctUrl = `http://127.0.0.1:${(correct.address() as AddressInfo).port}`
})

afterAll(() => {
  buggy.close()
  correct.close()
})

/** A browsing session: keeps the cookie, follows redirects, like a browser. */
function session(base: string) {
  let cookie = ''
  const keep = (res: Response) => {
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    return res
  }
  const headers = (): Record<string, string> => (cookie ? { cookie } : {})
  return {
    async get(path: string): Promise<string> {
      return keep(await fetch(base + path, { headers: headers() })).text()
    },
    async json<T>(path: string): Promise<T> {
      return (await keep(await fetch(base + path, { headers: headers() })).json()) as T
    },
    async post(path: string, body: Record<string, string>): Promise<void> {
      const res = keep(
        await fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers() },
          body: new URLSearchParams(body).toString(),
          redirect: 'manual',
        }),
      )
      // The shop answers a form POST with a redirect; follow it so the flash
      // message is consumed on the page the user would land on.
      const to = res.headers.get('location')
      if (to) await this.get(to.startsWith('http') ? to.replace(base, '') : to)
    },
  }
}

/** The discount the cart applies, as a percentage of the subtotal. */
async function couponRate(base: string): Promise<number> {
  const s = session(base)
  const products = await s.json<{ items: { id: string }[] }>('/api/products')
  await s.post('/cart/add', { id: products.items[0].id, qty: '1' })
  await s.post('/cart/coupon', { coupon: 'SAVE10' })
  const cart = await s.get('/cart')
  const subtotal = Number(/id="subtotal">\$?([\d,.]+)/.exec(cart)?.[1]?.replace(/,/g, '') ?? 0)
  const discount = Number(/id="discount">-?\$?([\d,.]+)/.exec(cart)?.[1]?.replace(/,/g, '') ?? 0)
  expect(subtotal).toBeGreaterThan(0)
  return Math.round((100 * discount) / subtotal)
}

describe('bug 1 — the advertised coupon rate', () => {
  it('takes 20% off when live, and the advertised 10% when not', async () => {
    expect(await couponRate(buggyUrl)).toBe(20)
    expect(await couponRate(correctUrl)).toBe(10)
  })
})

describe('bug 2 — case-sensitive search', () => {
  it('finds nothing for a lower-case query when live, and finds the product when not', async () => {
    // Every product name is capitalised, so a lower-case query is the test.
    const all = await session(buggyUrl).json<{ items: { name: string }[] }>('/api/products')
    // A word that starts with a letter, so lower-casing it actually differs.
    const word = all.items.flatMap((p) => p.name.split(/\s+/)).find((w) => /^[A-Z][a-z]{3,}/.test(w))!
    expect(word).toBeTruthy()

    const broken = await session(buggyUrl).json<{ items: unknown[] }>(`/api/products?q=${encodeURIComponent(word.toLowerCase())}`)
    const fixed = await session(correctUrl).json<{ items: unknown[] }>(`/api/products?q=${encodeURIComponent(word.toLowerCase())}`)
    expect(broken.items).toHaveLength(0)
    expect(fixed.items.length).toBeGreaterThan(0)

    // Both find it when the case matches, so the only difference is the casing.
    const exact = await session(buggyUrl).json<{ items: unknown[] }>(`/api/products?q=${encodeURIComponent(word)}`)
    expect(exact.items.length).toBeGreaterThan(0)
  })
})

describe('bug 3 — the filter is dropped when changing page', () => {
  it('omits the category from the next-page link when live, and keeps it when not', async () => {
    // The catalogue listing is the home page; /products/:id is one product.
    const path = '/?category=Computers'
    const nextLink = (html: string) => [...html.matchAll(/href="([^"]*page=2[^"]*)"/g)].map((m) => m[1])

    const brokenLinks = nextLink(await session(buggyUrl).get(path))
    const fixedLinks = nextLink(await session(correctUrl).get(path))
    expect(brokenLinks.length).toBeGreaterThan(0)
    expect(fixedLinks.length).toBeGreaterThan(0)
    expect(brokenLinks.some((l) => l.includes('category='))).toBe(false)
    expect(fixedLinks.every((l) => l.includes('category='))).toBe(true)
  })
})

describe('bug 5 — the password length rule', () => {
  it('accepts a 3-character password containing a digit when live, and refuses it when not', async () => {
    for (const [base, shouldBeAccepted] of [
      [buggyUrl, true],
      [correctUrl, false],
    ] as const) {
      const s = session(base)
      const email = `tp.${Math.random().toString(36).slice(2, 8)}@example.com`
      await s.post('/register', { name: 'Ada', email, password: 'Ab1', confirm: 'Ab1' })
      // A successful registration signs the user in; a refusal does not.
      const home = await s.get('/')
      const signedIn = home.includes(email) || /log ?out/i.test(home)
      expect(signedIn).toBe(shouldBeAccepted)
    }
  })

  it('refuses a short password with no digit either way — that rule was never broken', async () => {
    for (const base of [buggyUrl, correctUrl]) {
      const s = session(base)
      const email = `tp.${Math.random().toString(36).slice(2, 8)}@example.com`
      await s.post('/register', { name: 'Ada', email, password: 'abc', confirm: 'abc' })
      const home = await s.get('/')
      expect(home.includes(email)).toBe(false)
    }
  })
})

describe('switching defects individually', () => {
  it('reports which ones are live and leaves the others correct', async () => {
    const some = createShopApp({ bugs: [2, 5] }).listen(0)
    try {
      const url = `http://127.0.0.1:${(some.address() as AddressInfo).port}`
      const health = (await (await fetch(`${url}/__health`)).json()) as { bugs: number[] }
      expect(health.bugs).toEqual([2, 5])
      // Bug 1 is off in that configuration, so the coupon behaves as advertised.
      expect(await couponRate(url)).toBe(10)
    } finally {
      some.close()
    }
  })

  it('defaults to all five, so every existing caller is unaffected', async () => {
    const health = (await (await fetch(`${buggyUrl}/__health`)).json()) as { bugs: number[] }
    expect(health.bugs).toEqual([1, 2, 3, 4, 5])
  })
})
