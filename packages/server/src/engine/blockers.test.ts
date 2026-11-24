/**
 * Telling the user the truth about a page that cannot be tested.
 *
 * The cost of getting this wrong runs both ways: miss a bot wall and the run
 * wanders until it runs out of steps, then reports something that reads like a
 * defect; flag too eagerly and an ordinary sparse page is declared untestable.
 */
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectBlocker } from './blockers'
import { closeSharedBrowser, sharedBrowser } from './browserPool'

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await sharedBrowser(true)
  page = await browser.newPage()
})

afterAll(async () => {
  await page.close().catch(() => undefined)
  await closeSharedBrowser()
})

describe('detectBlocker', () => {
  it('recognises a CAPTCHA widget in the page', async () => {
    await page.setContent(`<h1>Sign in</h1><div class="g-recaptcha" data-sitekey="abc"></div><button>Continue</button>`)
    const b = await detectBlocker(page)
    expect(b?.kind).toBe('captcha')
    expect(b?.advice).toMatch(/CAPTCHA/)
  })

  it('recognises a bot wall by its words and its emptiness', async () => {
    await page.setContent(`<title>Just a moment...</title><h1>Checking your browser</h1><p>Please enable JavaScript and cookies to continue.</p>`)
    const b = await detectBlocker(page)
    expect(b?.kind).toBe('bot-wall')
    expect(b?.advice).toMatch(/staging/)
  })

  it('reports a page that rendered nothing usable', async () => {
    await page.setContent(`<div id="root"></div>`)
    const b = await detectBlocker(page)
    expect(b?.kind).toBe('empty')
  })

  it('leaves an ordinary sparse page alone', async () => {
    await page.setContent(`<h1>Thanks for your order</h1><p>Order #4182 is confirmed.</p><a href="/">Back to the shop</a>`)
    expect(await detectBlocker(page)).toBeNull()
  })

  it('does not flag a real page that merely contains an alarming word', async () => {
    // "Access denied" on a page with plenty to click is a permission message,
    // not a bot wall. Flagging it would hide a genuine authorisation defect.
    await page.setContent(
      `<h1>Access denied</h1><p>You do not have permission to view the admin area.</p>` +
        `<nav><a href="/">Home</a><a href="/products">Products</a><a href="/cart">Cart</a><a href="/login">Sign in</a><button>Request access</button></nav>`,
    )
    expect(await detectBlocker(page)).toBeNull()
  })
})
