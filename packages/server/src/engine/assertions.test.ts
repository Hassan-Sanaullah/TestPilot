/**
 * The assertions added so that negative, counting and ordering tests can be
 * written at all, each against a real browser.
 *
 * `assertValidation` is the important one: on most real forms an empty required
 * field or a malformed email is refused by the browser itself, with a message
 * that is not in the page. Before this, a negative test had nothing it could
 * check and either failed for the wrong reason or passed without verifying
 * anything.
 */
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Action, ObservationData } from '@testpilot/shared'
import { closeSharedBrowser, sharedBrowser } from './browserPool'
import { Executor } from './executor'
import { makePlaceholderValues } from './placeholders'
import { observe } from './perception'
import { sampleFile } from './sampleFiles'

let browser: Browser
let page: Page

const values = makePlaceholderValues({ baseUrl: 'http://assert.test/', seed: 'test' })

beforeAll(async () => {
  browser = await sharedBrowser(true)
  page = await browser.newPage()
})

afterAll(async () => {
  await page.close().catch(() => undefined)
  await closeSharedBrowser()
})

/** Observe, then run one action the way the runner does. */
async function act(action: Action): Promise<{ ok: boolean; message: string; data?: string }> {
  const obs: ObservationData = await observe(page)
  const executor = new Executor(page, values)
  executor.setObservation(obs)
  return executor.execute(action)
}

/** The observed index of the element with this label. */
async function indexOf(label: string): Promise<number> {
  const obs = await observe(page)
  const el = obs.elements.find((e) => e.label.toLowerCase().includes(label.toLowerCase()))
  if (!el) throw new Error(`no observed element labelled "${label}" — saw: ${obs.elements.map((e) => e.label).join(', ')}`)
  return el.index
}

describe('assertValidation', () => {
  it('sees that an empty required field is refused by the browser', async () => {
    await page.setContent(`<form><label for="e">Email</label><input id="e" type="email" required></form>`)
    const i = await indexOf('Email')
    const invalid = await act({ type: 'assertValidation', index: i, valid: false })
    expect(invalid.ok).toBe(true)
    expect(invalid.message).toMatch(/ASSERTION PASSED/)
    const valid = await act({ type: 'assertValidation', index: i, valid: true })
    expect(valid.ok).toBe(false)
  })

  it('sees that a malformed email is refused, and can check the message', async () => {
    await page.setContent(`<form><label for="e">Email</label><input id="e" type="email" required value="not-an-email"></form>`)
    const i = await indexOf('Email')
    expect((await act({ type: 'assertValidation', index: i, valid: false })).ok).toBe(true)
    // Chromium says "Please include an '@' in the email address."
    const withMessage = await act({ type: 'assertValidation', index: i, valid: false, message: '@' })
    expect(withMessage.ok).toBe(true)
    const wrongMessage = await act({ type: 'assertValidation', index: i, valid: false, message: 'this will never be the wording' })
    expect(wrongMessage.ok).toBe(false)
    expect(wrongMessage.message).toMatch(/invalid as expected, but the message/)
  })

  it('accepts a field the browser is happy with', async () => {
    await page.setContent(`<form><label for="e">Email</label><input id="e" type="email" required value="ada@example.com"></form>`)
    const i = await indexOf('Email')
    expect((await act({ type: 'assertValidation', index: i, valid: true })).ok).toBe(true)
  })

  it('believes a page that marks its own field invalid, with no native constraint', async () => {
    await page.setContent(
      `<form><label for="c">Coupon</label><input id="c" aria-invalid="true" aria-describedby="err" value="NOPE">` +
        `<p id="err">That coupon code is not recognised.</p></form>`,
    )
    const i = await indexOf('Coupon')
    const r = await act({ type: 'assertValidation', index: i, valid: false, message: 'not recognised' })
    expect(r.ok).toBe(true)
  })
})

describe('assertCount', () => {
  beforeAll(async () => {
    await page.setContent(
      `<ul>` +
        `<li><h3>Aurora Desk Lamp</h3><button>Add to cart</button></li>` +
        `<li><h3>Nimbus Mouse</h3><button>Add to cart</button></li>` +
        `<li><h3>Cobalt Notebook</h3><button>Add to cart</button></li>` +
        `</ul><p hidden><button>Add to cart</button></p>`,
    )
  })

  it('counts visible matches only', async () => {
    expect((await act({ type: 'assertCount', text: 'Add to cart', equals: 3 })).ok).toBe(true)
    expect((await act({ type: 'assertCount', text: 'Add to cart', equals: 4 })).ok).toBe(false)
  })

  it('checks a lower and an upper bound', async () => {
    expect((await act({ type: 'assertCount', text: 'Add to cart', min: 1 })).ok).toBe(true)
    expect((await act({ type: 'assertCount', text: 'Add to cart', max: 2 })).ok).toBe(false)
    expect((await act({ type: 'assertCount', text: 'Add to cart', min: 2, max: 4 })).ok).toBe(true)
  })

  it('counts by role and name', async () => {
    const r = await act({ type: 'assertCount', role: 'button', nameContains: 'Add to cart', equals: 3 })
    expect(r.ok).toBe(true)
  })

  it('reports zero rather than passing when nothing matches', async () => {
    const r = await act({ type: 'assertCount', text: 'Out of stock', min: 1 })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/found 0/)
  })
})

describe('assertOrder', () => {
  it('passes when the texts appear in the given order', async () => {
    await page.setContent(`<ol><li>$8.75</li><li>$24.50</li><li>$49.00</li></ol>`)
    expect((await act({ type: 'assertOrder', text: ['$8.75', '$24.50', '$49.00'] })).ok).toBe(true)
  })

  it('fails when they do not, and says which one is out of place', async () => {
    await page.setContent(`<ol><li>$49.00</li><li>$8.75</li><li>$24.50</li></ol>`)
    const r = await act({ type: 'assertOrder', text: ['$8.75', '$24.50', '$49.00'] })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/appears before/)
  })

  it('says so when a text is not on the page at all', async () => {
    await page.setContent(`<ol><li>$8.75</li></ol>`)
    const r = await act({ type: 'assertOrder', text: ['$8.75', '$99.00'] })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not on the page at all/)
  })
})

describe('assertText with exact matching', () => {
  it('refuses a substring match when exact is asked for', async () => {
    await page.setContent(`<p>Total: 100.00</p>`)
    expect((await act({ type: 'assertText', text: '10' })).ok).toBe(true)
    expect((await act({ type: 'assertText', text: '10', exact: true })).ok).toBe(false)
    expect((await act({ type: 'assertText', text: 'Total: 100.00', exact: true })).ok).toBe(true)
  })
})

describe('assertValue on a checkbox', () => {
  it('reads the ticked state instead of a value', async () => {
    await page.setContent(`<label for="t">Accept terms</label><input id="t" type="checkbox">`)
    const i = await indexOf('Accept terms')
    expect((await act({ type: 'assertValue', index: i, text: 'unchecked' })).ok).toBe(true)
    expect((await act({ type: 'assertValue', index: i, text: 'checked' })).ok).toBe(false)
    await page.check('#t')
    expect((await act({ type: 'assertValue', index: await indexOf('Accept terms'), text: 'checked' })).ok).toBe(true)
  })
})

describe('upload', () => {
  it('attaches a generated file to an input that is hidden behind a styled label', async () => {
    await page.setContent(
      `<label for="f" style="padding:8px;border:1px solid #333">Choose a picture</label>` +
        `<input id="f" type="file" style="position:absolute;width:1px;height:1px;opacity:0">` +
        `<p id="out">nothing yet</p>` +
        `<script>document.getElementById('f').addEventListener('change', (e) => { document.getElementById('out').textContent = e.target.files[0].name + ' / ' + e.target.files[0].size + ' bytes' })</script>`,
    )
    // The input is 1x1 and transparent: perception must still list it, or an
    // upload test could never name the element.
    const obs = await observe(page)
    const file = obs.elements.find((e) => e.role === 'file')
    expect(file).toBeTruthy()

    const r = await act({ type: 'upload', index: file!.index, file: 'image' })
    expect(r.ok).toBe(true)
    expect(await page.locator('#out').innerText()).toContain(sampleFile('image').name)
  })

  it('attaches each sample kind with its real type', async () => {
    for (const kind of ['pdf', 'text', 'csv'] as const) {
      await page.setContent(`<input id="f" type="file"><p id="out"></p><script>document.getElementById('f').addEventListener('change', (e) => { document.getElementById('out').textContent = e.target.files[0].type })</script>`)
      const obs = await observe(page)
      const file = obs.elements.find((e) => e.role === 'file')!
      const r = await act({ type: 'upload', index: file.index, file: kind })
      expect(r.ok).toBe(true)
      expect(await page.locator('#out').innerText()).toBe(sampleFile(kind).mimeType)
    }
  })
})
