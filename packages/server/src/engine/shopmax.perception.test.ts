/**
 * Perception against the real complex evaluation app (ShopMax), which has a
 * blocking cookie overlay, 120 products behind pagination, a shadow-DOM
 * component, an iframe and a hover mega-menu.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type Page, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import { findElements, observe, renderObservation } from './perception'

let server: Server
let browser: Browser
let base: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  server?.close()
})

async function open(path: string, { acceptCookies = true, height = 900 } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height } })
  await page.goto(base + path, { waitUntil: 'domcontentloaded' })
  if (acceptCookies) {
    await page.getByRole('button', { name: 'Accept all cookies' }).click({ timeout: 5000 }).catch(() => undefined)
  }
  await page.waitForTimeout(400)
  return page
}

describe('perception on ShopMax', () => {
  it('surfaces the blocking cookie overlay as an actionable element', async () => {
    const page = await open('/', { acceptCookies: false })
    const obs = await observe(page)
    expect(obs.elements.map((e) => e.label)).toContain('Accept all cookies')

    // The overlay really does block the page — this is the obstacle the agent
    // must clear before anything else works.
    const blocked = await page
      .locator('#categories-menu')
      .hover({ timeout: 2000 })
      .then(() => false, () => true)
    expect(blocked).toBe(true)
    await page.close()
  })

  it('sees the whole catalogue page including everything below the fold', async () => {
    // A 600px-tall laptop viewport leaves most of the catalogue off-screen —
    // the exact situation in which v1 reported almost nothing.
    const page = await open('/', { height: 600 })
    const obs = await observe(page)

    expect(obs.elements.length).toBeGreaterThan(50)
    const offscreen = obs.elements.filter((e) => !e.inViewport)
    expect(offscreen.length).toBeGreaterThan(20)
    expect(offscreen.every((e) => e.off === 'above' || e.off === 'below')).toBe(true)
    // the very bottom of the page is captured despite never being scrolled to
    expect(obs.elements.find((e) => e.label === 'Load more products')?.off).toBe('below')

    const labels = obs.elements.map((e) => e.label)
    expect(labels.some((l) => l.startsWith('Add ') && l.endsWith(' to cart'))).toBe(true)
    expect(labels).toContain('Load more products') // at the very bottom
    expect(labels.some((l) => /^\d+$/.test(l))).toBe(true) // pagination numbers

    // the sort <select> exposes its options so the model need not guess
    const sort = obs.elements.find((e) => e.role === 'select' && e.label.toLowerCase().includes('sort'))
    expect(sort?.options).toContain('Price: low to high')
    await page.close()
  })

  it('reaches the shadow-DOM rating widget and the iframe reviews on a product page', async () => {
    const page = await open('/products/p1')
    const obs = await observe(page)

    const shadow = obs.elements.filter((e) => e.shadow)
    expect(shadow.map((e) => e.label)).toContain('Rate this product')

    const inFrame = obs.elements.filter((e) => e.frame)
    expect(inFrame.map((e) => e.label)).toContain('Show more reviews')

    // both are resolvable by the stamped id, so actions can target them
    for (const el of [shadow[0], inFrame[0]]) {
      const counts = await Promise.all(page.frames().map((f) => f.locator(`[data-tp-id="${el.index}"]`).count()))
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    }
    await page.close()
  })

  it('find() reaches a product that the rendered prompt omitted', async () => {
    const page = await open('/')
    const obs = await observe(page)
    const rendered = renderObservation(obs, 25)
    expect(rendered.split('\n').filter((l) => l.startsWith('  ['))).toHaveLength(25)
    expect(rendered).toContain('not listed')

    const hits = findElements(obs, 'Load more products')
    expect(hits[0]?.label).toBe('Load more products')
    await page.close()
  })

  it('exposes the hover mega-menu only after hovering', async () => {
    const page = await open('/')

    const before = await observe(page)
    expect(before.elements.some((e) => e.label === 'Audio' && e.role === 'link')).toBe(false)

    await page.locator('#categories-menu').hover()
    await page.waitForTimeout(300)
    const after = await observe(page)
    expect(after.elements.some((e) => e.label === 'Audio' && e.role === 'link')).toBe(true)
    await page.close()
  })
})
