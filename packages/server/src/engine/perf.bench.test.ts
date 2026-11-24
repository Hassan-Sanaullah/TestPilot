/**
 * Where does a step's wall-clock time actually go? Measures the parts we
 * control (observation, prompt size, screenshot) against the real app, so
 * performance work is driven by data rather than guesswork. Thresholds are
 * deliberately loose — this guards against regressions, not jitter.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import { observe, renderObservation } from './perception'

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

describe('step cost breakdown', () => {
  it('observes the heaviest page quickly and keeps the prompt affordable', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${base}/products/p1`, { waitUntil: 'domcontentloaded' }) // iframe + shadow DOM
    await page.waitForTimeout(400)

    // warm, then measure
    await observe(page)
    const t0 = Date.now()
    const obs = await observe(page)
    const observeMs = Date.now() - t0

    const text = renderObservation(obs)
    const approxTokens = Math.round(text.length / 4)

    const t1 = Date.now()
    await page.screenshot({ type: 'png' })
    const shotMs = Date.now() - t1

    console.log(`observe ${observeMs}ms · render ${text.length} chars (~${approxTokens} tokens) · screenshot ${shotMs}ms · ${obs.totalFound} elements`)

    expect(observeMs).toBeLessThan(2500)
    expect(shotMs).toBeLessThan(2000)
    // A bloated prompt is both slow and expensive; keep it in budget.
    expect(approxTokens).toBeLessThan(4000)
    await page.close()
  })

  it('observes the 120-product catalogue without blowing the prompt budget', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(400)
    await observe(page)

    const t0 = Date.now()
    const obs = await observe(page)
    const observeMs = Date.now() - t0
    const text = renderObservation(obs)
    console.log(`catalogue: observe ${observeMs}ms · ${obs.elements.length} stored · ${obs.totalFound} found · ~${Math.round(text.length / 4)} prompt tokens`)

    expect(observeMs).toBeLessThan(2500)
    expect(Math.round(text.length / 4)).toBeLessThan(4000)
    await page.close()
  })
})
