/**
 * Regression test for the v1 defect: on a realistically complex page the old
 * perception layer reported 4 of 1,206 interactive elements. Everything below
 * the fold and everything inside a shadow root was invisible to the model.
 */
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findElements, observe, renderObservation } from './perception'

const COMPLEX_PAGE = `<!doctype html><html><head><title>Complex</title></head><body>
<nav><a href="#a">Home</a><a href="#b">Shop</a><a href="#c">About</a></nav>
<input id="top" placeholder="Search at top">
<div style="height:1500px">tall hero section</div>
<h2>Below the fold</h2>
<button id="buy-below">Buy now</button>
<input id="coupon-below" placeholder="Coupon code">
<select id="country"><option value="pk">Pakistan</option><option value="uk">United Kingdom</option></select>
<input type="checkbox" id="terms" checked><label for="terms">Accept terms</label>
<button disabled id="locked">Locked action</button>
<div id="list"></div>
<my-widget></my-widget>
<div id="hidden-wrap" style="display:none"><button>Never visible</button></div>
<script>
  const list = document.getElementById('list');
  for (let i = 0; i < 400; i++) {
    const row = document.createElement('div');
    row.innerHTML = '<button>Add item ' + i + '</button><input placeholder="qty ' + i + '">';
    list.appendChild(row);
  }
  class MyWidget extends HTMLElement {
    constructor() {
      super();
      const s = this.attachShadow({ mode: 'open' });
      s.innerHTML = '<button id="shadow-btn">Checkout in shadow</button><input placeholder="shadow field">';
    }
  }
  customElements.define('my-widget', MyWidget);
</script>
</body></html>`

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
})

describe('perception on a complex page', () => {
  it('sees content below the fold, in shadow DOM, and reports the true total', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(COMPLEX_PAGE)
    await page.waitForTimeout(200)
    const obs = await observe(page)

    // v1 reported 4 elements here.
    expect(obs.elements.length).toBeGreaterThan(400)
    expect(obs.totalFound).toBeGreaterThan(800)

    const labels = obs.elements.map((e) => e.label)
    expect(labels).toContain('Buy now') //  below the fold
    expect(labels).toContain('Coupon code') //  below the fold
    expect(labels).toContain('Checkout in shadow') //  inside an open shadow root
    expect(labels).not.toContain('Never visible') //  display:none stays hidden

    // Off-screen elements are flagged so the model knows the page is scrolled.
    const buy = obs.elements.find((e) => e.label === 'Buy now')!
    expect(buy.inViewport).toBe(false)
    expect(buy.off).toBe('below')
    expect(obs.elements.some((e) => e.inViewport)).toBe(true)

    // Shadow elements are marked and still resolvable by Playwright selectors.
    const shadowBtn = obs.elements.find((e) => e.label === 'Checkout in shadow')!
    expect(shadowBtn.shadow).toBe(true)
    expect(await page.locator(`[data-tp-id="${shadowBtn.index}"]`).count()).toBe(1)

    await page.close()
  })

  it('reports select options, checkbox state and disabled elements', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(COMPLEX_PAGE)
    const obs = await observe(page)

    const select = obs.elements.find((e) => e.role === 'select')!
    expect(select.options).toEqual(['Pakistan', 'United Kingdom'])

    const checkbox = obs.elements.find((e) => e.role === 'checkbox')!
    expect(checkbox.checked).toBe(true)

    expect(obs.elements.find((e) => e.label === 'Locked action')!.disabled).toBe(true)
    await page.close()
  })

  it('renders a prioritised list that puts visible elements first and admits what it omitted', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(COMPLEX_PAGE)
    const obs = await observe(page)
    const text = renderObservation(obs, 50)

    const lines = text.split('\n').filter((l) => l.startsWith('  ['))
    expect(lines.length).toBe(50)
    // The first listed elements are the ones actually on screen.
    expect(lines[0]).toContain('Home')
    expect(text).toContain('more element(s) not listed')
    expect(text).toMatch(/Interactive elements: \d+ on the page/)
    expect(text).toContain('find(')
    await page.close()
  })

  it('find() locates an element that was never rendered into the prompt', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(COMPLEX_PAGE)
    const obs = await observe(page)

    const rendered = renderObservation(obs, 50)
    expect(rendered).not.toContain('Add item 390')

    const hits = findElements(obs, 'Add item 390')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].label).toBe('Add item 390')
    expect(await page.locator(`[data-tp-id="${hits[0].index}"]`).count()).toBe(1)
    await page.close()
  })

  it('tracks scroll position so the model knows where it is', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(COMPLEX_PAGE)
    await page.evaluate(() => window.scrollTo({ top: 1400 }))
    await page.waitForTimeout(150)
    const obs = await observe(page)

    expect(obs.scrollY).toBeGreaterThan(1000)
    expect(renderObservation(obs)).toMatch(/Scroll: \d+% down a page/)
    // After scrolling, the below-the-fold button is now in view.
    expect(obs.elements.find((e) => e.label === 'Buy now')!.inViewport).toBe(true)
    await page.close()
  })
})
