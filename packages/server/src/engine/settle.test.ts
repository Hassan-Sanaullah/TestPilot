/**
 * Settling used to be a fixed sleep. These are the cases that decide whether
 * watching the DOM is actually better: it must be fast when nothing happens,
 * patient when something does, bounded when the page never stops, and survive
 * the execution context being destroyed by a navigation.
 */
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser } from './browserPool'
import { armSettle, settlePage } from './settle'

let browser: Browser
let page: Page

/** Serve two pages from a fake origin: a data: URL cannot be navigated to. */
const FIRST = `<a id="leave" href="/second">Leave</a>`
const SECOND = `<h1 id="other">Other page</h1>`

beforeAll(async () => {
  const { sharedBrowser } = await import('./browserPool')
  browser = await sharedBrowser(true)
  page = await browser.newPage()
  await page.route('https://settle.test/**', (route) => {
    const body = route.request().url().endsWith('/second') ? SECOND : FIRST
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` })
  })
})

afterAll(async () => {
  await page.close().catch(() => undefined)
  await closeSharedBrowser()
})

describe('settlePage', () => {
  it('returns quickly when the action changes nothing', async () => {
    await page.setContent('<main><h1>Nothing moves here</h1></main>')
    await armSettle(page)
    const r = await settlePage(page, { quiet: 120, max: 1500, grace: 150 })
    expect(r.why).toBe('no-change')
    expect(r.ms).toBeLessThan(400)
  })

  it('waits for content that arrives well after the click', async () => {
    await page.setContent('<button id="go">Go</button><div id="host"></div>')
    await page.evaluate(() => {
      document.getElementById('go')!.addEventListener('click', () => {
        setTimeout(() => {
          const p = document.createElement('p')
          p.id = 'late'
          p.textContent = 'arrived'
          document.getElementById('host')!.appendChild(p)
        }, 300)
      })
    })
    // The executor arms before acting; that is what makes the late change
    // visible at all. The grace window is comfortably longer than the delay —
    // sitting exactly on the boundary would be a coin toss on a busy machine.
    await armSettle(page)
    await page.click('#go')
    const r = await settlePage(page, { quiet: 120, max: 2000, grace: 800 })
    expect(await page.locator('#late').count()).toBe(1)
    expect(r.why).toBe('quiet')
  })

  it('does not wait for a change that starts after the grace window', async () => {
    // The documented limit: nothing can tell "this page is finished" apart from
    // "this page has not started yet". A change that begins after the grace
    // window is missed by the settle, and the next step's assertion — which
    // polls for five seconds — is what catches it instead.
    await page.setContent('<div id="host"></div>')
    await page.evaluate(() => {
      setTimeout(() => {
        document.getElementById('host')!.textContent = 'very late'
      }, 900)
    })
    await armSettle(page)
    const r = await settlePage(page, { quiet: 120, max: 2000, grace: 200 })
    expect(r.why).toBe('no-change')
    expect(await page.locator('#host').innerText()).toBe('')
  })

  it('gives up at the cap on a page that never stops changing', async () => {
    await page.setContent('<div id="tick">0</div>')
    await page.evaluate(() => {
      const el = document.getElementById('tick')!
      // A ticking clock never goes quiet; only the cap ends this wait.
      window.setInterval(() => {
        el.textContent = String(Number(el.textContent) + 1)
      }, 20)
    })
    await armSettle(page)
    const r = await settlePage(page, { quiet: 120, max: 600, grace: 300 })
    expect(r.why).toBe('max')
    expect(r.ms).toBeGreaterThanOrEqual(500)
    expect(r.ms).toBeLessThan(2500)
  })

  it('survives a click that navigates away mid-wait', async () => {
    await page.goto('https://settle.test/first')
    await armSettle(page)
    await page.click('#leave')
    await settlePage(page)
    expect(await page.locator('#other').count()).toBe(1)
    expect(page.url()).toContain('/second')
  })

  it('does nothing on a closed page instead of throwing', async () => {
    const temp = await browser.newPage()
    await temp.close()
    await expect(settlePage(temp)).resolves.toMatchObject({ why: 'no-change' })
    await expect(armSettle(temp)).resolves.toBeUndefined()
  })

  it('works without arming, by watching from after the action', async () => {
    await page.setContent('<div id="host"></div>')
    await page.evaluate(() => {
      setTimeout(() => {
        document.getElementById('host')!.textContent = 'changed'
      }, 100)
    })
    const r = await settlePage(page, { quiet: 100, max: 1500, grace: 300 })
    expect(r.changes).toBeGreaterThan(0)
    expect(await page.locator('#host').innerText()).toBe('changed')
  })
})
