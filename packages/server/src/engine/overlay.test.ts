/**
 * A blocking overlay must never be silently clicked through. The v1 executor
 * fell back to `force: true`, which clicks the coordinates — hitting the
 * overlay instead of the button. The action reported success, the form was
 * never submitted, and the agent then "verified" that validation had worked.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import { Executor, interceptingElement } from './executor'
import { observe } from './perception'
import { makePlaceholderValues } from './placeholders'

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

const values = makePlaceholderValues({ baseUrl: 'http://x', testUser: 'u', testPassword: 'p' })

describe('overlay handling', () => {
  it('extracts the blocking element from a Playwright interception error', () => {
    // the opening tag is what identifies the blocker to the model
    expect(interceptingElement('... <div id="cookie">…</div> intercepts pointer events ...')).toBe('<div id="cookie">')
    expect(interceptingElement('intercepts pointer events')).toBe('another element')
    expect(interceptingElement('element is not visible')).toBeNull()
  })

  it('reports the blocker instead of pretending the click worked', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${base}/register`, { waitUntil: 'domcontentloaded' })
    const obs = await observe(page)
    const submit = obs.elements.find((e) => e.role === 'button' && e.label === 'Register')!
    expect(submit).toBeTruthy()

    const ex = new Executor(page, values)
    ex.setObservation(obs)
    const res = await ex.execute({ type: 'click', index: submit.index })

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/blocked/)
    expect(res.message).toMatch(/cookie/)
    expect(res.message).toMatch(/Dismiss/)
    // and we are still on the registration page, i.e. nothing silently happened
    expect(page.url()).toContain('/register')
    await page.close()
  })

  it('works normally once the overlay is dismissed', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${base}/register`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Accept all cookies' }).click()

    const obs = await observe(page)
    const ex = new Executor(page, values)
    ex.setObservation(obs)
    const byLabel = (label: string) => obs.elements.find((e) => e.label === label)!

    await ex.execute({ type: 'type', index: byLabel('Full name').index, text: 'Short Pwd' })
    await ex.execute({ type: 'type', index: byLabel('Email address').index, text: 'shortpwd@example.com' })
    await ex.execute({ type: 'type', index: byLabel('Password').index, text: '123' })
    await ex.execute({ type: 'type', index: byLabel('Confirm password').index, text: '123' })
    const click = await ex.execute({ type: 'click', index: obs.elements.find((e) => e.role === 'button' && e.label === 'Register')!.index })

    expect(click.ok).toBe(true)
    // SEEDED BUG #5: a 3-character password containing a digit is accepted, so
    // the app leaves /register. This is the bug a correct test must report.
    await page.waitForTimeout(500)
    expect(page.url()).not.toContain('/register')
    await page.close()
  })
})
