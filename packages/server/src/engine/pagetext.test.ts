/**
 * Showing the model what its last action did.
 *
 * Without this the model only ever sees what it can click, so when a test says
 * "verify the error message" it has to guess the wording — and a wrong guess
 * becomes a failed assertion, which gets filed as a defect in the application.
 */
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser, sharedBrowser } from './browserPool'
import { collectText, diffText, pageFingerprint, renderChanges } from './perception'

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

describe('collectText', () => {
  it('reads the words a person can see', async () => {
    await page.setContent(`<h1>Create an account</h1><p>At least 8 characters</p><button>Sign up</button>`)
    const t = await collectText(page)
    expect(t.text).toContain('Create an account')
    expect(t.text).toContain('At least 8 characters')
  })

  it('picks up what the page announces', async () => {
    await page.setContent(`<div role="alert">Password must be at least 8 characters.</div><p>Create an account</p>`)
    const t = await collectText(page)
    expect(t.alerts).toContain('Password must be at least 8 characters.')
  })

  it('includes a native validation message, which is not in the page at all', async () => {
    await page.setContent(`<form><input id="e" type="email" required value="nope"></form>`)
    const t = await collectText(page)
    expect(t.alerts.join(' ')).toMatch(/@/)
  })

  it('leaves out script and style content', async () => {
    await page.setContent(`<style>.a{color:red}</style><script>var secret = "do not read me"</script><p>Visible copy</p>`)
    const t = await collectText(page)
    expect(t.text).toContain('Visible copy')
    expect(t.text.join(' ')).not.toContain('do not read me')
  })
})

describe('what changed since the last action', () => {
  it('shows the error that appeared on submit', async () => {
    await page.setContent(`<form id="f"><input id="p" value="abc"><button type="submit">Sign up</button></form><div id="host"></div>`)
    const before = await collectText(page)

    await page.evaluate(() => {
      const d = document.createElement('div')
      d.setAttribute('role', 'alert')
      d.textContent = 'Password must be at least 8 characters.'
      document.getElementById('host')!.appendChild(d)
    })

    const after = await collectText(page)
    const changes = diffText(before, after)
    expect(changes.appeared).toContain('Password must be at least 8 characters.')
    expect(changes.alerts).toContain('Password must be at least 8 characters.')

    const rendered = renderChanges(changes)
    expect(rendered).toContain('SINCE YOUR LAST ACTION')
    expect(rendered).toContain('appeared:')
    expect(rendered).toContain('ALERTS ON THE PAGE')
  })

  it('reports what went away', async () => {
    await page.setContent(`<p id="gone">Loading your cart</p><p>Your cart</p>`)
    const before = await collectText(page)
    await page.evaluate(() => document.getElementById('gone')!.remove())
    const changes = diffText(before, await collectText(page))
    expect(changes.disappeared).toContain('Loading your cart')
  })

  it('keeps it short after a navigation, where everything is new', async () => {
    await page.setContent(`<p>Old page</p>`)
    const before = await collectText(page)
    await page.setContent(`<h1>New page</h1>${Array.from({ length: 40 }, (_, i) => `<p>Row ${i}</p>`).join('')}`)
    const changes = diffText(before, await collectText(page), true)
    expect(changes.navigated).toBe(true)
    expect(changes.appeared.length).toBeLessThanOrEqual(8)
    expect(renderChanges(changes)).toContain('ON THIS NEW PAGE')
  })

  it('says nothing when nothing happened', async () => {
    await page.setContent(`<p>Steady state</p>`)
    const t = await collectText(page)
    expect(renderChanges(diffText(t, t))).toBe('')
  })
})

describe('pageFingerprint', () => {
  it('is stable when only a field value changes', async () => {
    await page.setContent(`<form><input id="a"><input id="b"><button>Go</button></form>`)
    const before = await pageFingerprint(page)
    await page.fill('#a', 'typed something')
    expect(await pageFingerprint(page)).toBe(before)
  })

  it('changes when a dialog opens', async () => {
    await page.setContent(`<button>Go</button><div id="host"></div>`)
    const before = await pageFingerprint(page)
    await page.evaluate(() => {
      const d = document.createElement('div')
      d.setAttribute('role', 'dialog')
      d.innerHTML = '<button>Confirm</button>'
      document.getElementById('host')!.appendChild(d)
    })
    expect(await pageFingerprint(page)).not.toBe(before)
  })

  it('changes when the page navigates', async () => {
    await page.setContent(`<a href="#x">x</a>`)
    const before = await pageFingerprint(page)
    await page.setContent(`<a href="#y">y</a><a href="#z">z</a>`)
    expect(await pageFingerprint(page)).not.toBe(before)
  })

  it('does not disturb the element tags the executor relies on', async () => {
    // observe() strips every data-tp-id; the fingerprint must not, or an
    // element resolved a moment ago would stop being addressable.
    await page.setContent(`<button data-tp-id="7">Go</button>`)
    await pageFingerprint(page)
    expect(await page.getAttribute('button', 'data-tp-id')).toBe('7')
  })
})
