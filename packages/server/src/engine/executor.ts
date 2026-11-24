/**
 * M3 — maps a validated action to Playwright operations. Elements are resolved
 * by the `data-tp-id` stamped during perception, in whichever frame they live;
 * Playwright's CSS engine pierces open shadow roots, so shadow-DOM elements
 * resolve with the same selector.
 *
 * Secrets: the model never sees the test password. It types the literal
 * `{{test_password}}` and the executor substitutes the real value here, so the
 * secret exists only in this process and the browser.
 */
import type { Frame, Locator, Page } from 'playwright'
import { type Action, type ElementRef, type ObservationData } from '@testpilot/shared'
import { captureRef } from './locator'
import { sampleFile } from './sampleFiles'
import { ELEMENT_ATTR, findElements, renderElement } from './perception'
import type { PlaceholderValues } from './placeholders'
import { applySecretPlaceholders } from './placeholders'
import { armSettle, settlePage, type SettleOptions } from './settle'
import { mark, timed, type TimingSink } from './timing'

export interface ExecResult {
  ok: boolean
  message: string
  /** extra content handed back to the model (extract / find results) */
  data?: string
}

const ASSERT_WAIT_MS = 5000

/**
 * Playwright reports an intercepted click as
 *   `<div id="cookie">…</div> intercepts pointer events`
 * Pull the offending element out so the model is told what to dismiss.
 */
export function interceptingElement(error: string): string | null {
  const m = /(<[^>]{1,120}>)[^\n]*intercepts pointer events/.exec(error)
  if (m) return m[1]
  return /intercepts pointer events/.test(error) ? 'another element' : null
}

export class Executor {
  private observation: ObservationData | null = null
  /**
   * A verified locator for the element the last action targeted. The runner
   * stores it so a passing run can be compiled into a script that replays
   * without the AI.
   */
  lastRef: ElementRef | null = null

  constructor(
    private page: Page,
    private readonly values: PlaceholderValues,
    private readonly onTiming?: TimingSink,
  ) {}

  /** The runner swaps this when a popup/new tab becomes active. */
  setPage(page: Page): void {
    this.page = page
  }

  /** The runner supplies the observation the model just saw. */
  setObservation(obs: ObservationData): void {
    this.observation = obs
  }

  private async resolve(index: number): Promise<Locator> {
    return timed(this.onTiming, 'resolve', () => this.resolveNow(index))
  }

  private async resolveNow(index: number): Promise<Locator> {
    const sel = `[${ELEMENT_ATTR}="${index}"]`
    for (const frame of this.page.frames()) {
      const loc = frame.locator(sel).first()
      try {
        if ((await loc.count()) > 0) {
          // Must happen before the action runs: afterwards the page may have
          // navigated and the element is gone.
          await this.rememberRef(frame, loc, index)
          return loc
        }
      } catch {
        /* detached frame */
      }
    }
    return this.page.locator(sel).first()
  }

  /** Record a replayable locator for this element, best effort. */
  private async rememberRef(scope: Frame, loc: Locator, index: number): Promise<void> {
    try {
      this.lastRef = await captureRef(scope, loc, index)
    } catch {
      this.lastRef = null
    }
  }

  async execute(action: Action): Promise<ExecResult> {
    this.lastRef = null
    // Watch the page from BEFORE the action, so a change that starts a moment
    // later is still seen. Reads cannot change anything, so they skip this.
    if (settleProfile(action)) await armSettle(this.page)
    const t0 = performance.now()
    try {
      const r = await this.run(action)
      mark(this.onTiming, 'act', performance.now() - t0)
      await timed(this.onTiming, 'settle', () => this.settle(action))
      return r
    } catch (e) {
      mark(this.onTiming, 'act', performance.now() - t0)
      const raw = (e as Error).message
      const blocker = interceptingElement(raw)
      if (blocker) {
        return {
          ok: false,
          message: `${action.type} on the target was blocked: ${blocker} is covering it. Dismiss that overlay first (Accept / Close / ✕ / Escape), then try again.`,
        }
      }
      return { ok: false, message: `${action.type} failed: ${raw.split('\n')[0]}` }
    }
  }

  private async run(a: Action): Promise<ExecResult> {
    switch (a.type) {
      // ---- navigate --------------------------------------------------------
      case 'navigate': {
        await this.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        return { ok: true, message: `navigated to ${a.url}` }
      }
      case 'goBack': {
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        return { ok: true, message: `went back to ${this.page.url()}` }
      }
      case 'switchTab':
        // handled by the runner (it owns the page list) — never reaches here
        return { ok: false, message: 'switchTab must be handled by the runner' }

      // ---- interact --------------------------------------------------------
      case 'click': {
        const loc = await this.resolve(a.index)
        await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined)
        try {
          await loc.click({ timeout: 6000 })
          return { ok: true, message: `clicked [${a.index}]` }
        } catch (e) {
          const blocker = interceptingElement((e as Error).message)
          if (blocker) {
            // Never "force" past an overlay: force clicks the coordinates, which
            // lands on the overlay itself, and the action silently does nothing
            // while appearing to succeed. A real user has to dismiss it, so the
            // test must too — report it and let the model deal with it.
            return {
              ok: false,
              message:
                `click on [${a.index}] was blocked: ${blocker} is covering it. ` +
                `Dismiss that overlay first (a cookie banner, modal or consent dialog — look for Accept, Close, ✕, or press Escape), then try again.`,
            }
          }
          // Not an overlay: the element may just be awkward to hit. Fire the
          // click on the element itself, which still triggers form submission.
          await loc.evaluate((el) => (el as HTMLElement).click())
          return { ok: true, message: `clicked [${a.index}] (via a direct element click)` }
        }
      }
      case 'type': {
        const text = applySecretPlaceholders(a.text, this.values)
        const shownText = a.text // keep the placeholder in the log, never the secret
        const loc = await this.resolve(a.index)
        await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined)
        try {
          if (a.clear === false) await loc.pressSequentially(text, { timeout: 6000 })
          else await loc.fill(text, { timeout: 6000 })
        } catch {
          await loc.focus()
          await loc.fill(text, { timeout: 4000 })
        }
        if (a.submit) await loc.press('Enter')
        const shown = shownText.length > 40 ? shownText.slice(0, 37) + '…' : shownText
        return { ok: true, message: `typed "${shown}" into [${a.index}]${a.submit ? ' and pressed Enter' : ''}` }
      }
      case 'select': {
        const loc = await this.resolve(a.index)
        let how = 'value'
        try {
          await loc.selectOption({ value: a.value }, { timeout: 3000 })
        } catch {
          try {
            await loc.selectOption({ label: a.value }, { timeout: 3000 })
            how = 'label'
          } catch {
            const n = Number(a.value)
            if (!Number.isNaN(n)) {
              await loc.selectOption({ index: n }, { timeout: 3000 })
              how = 'position'
            } else throw new Error(`no option matching "${a.value}"`)
          }
        }
        return { ok: true, message: `selected "${a.value}" in [${a.index}] (by ${how})` }
      }
      case 'hover': {
        const loc = await this.resolve(a.index)
        await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined)
        try {
          await loc.hover({ timeout: 5000 })
        } catch (e) {
          const blocker = interceptingElement((e as Error).message)
          if (blocker) return { ok: false, message: `hover on [${a.index}] was blocked: ${blocker} is covering it. Dismiss that overlay first, then try again.` }
          throw e
        }
        await settlePage(this.page, { quiet: 80, max: 600 }) // let the menu open
        return { ok: true, message: `hovered [${a.index}]` }
      }
      case 'upload': {
        const loc = await this.resolve(a.index)
        const file = sampleFile(a.file, a.name)
        // A styled upload control usually hides the real input behind a label,
        // so the element is not clickable. setInputFiles does not need it to be.
        await loc.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer }, { timeout: 8000 })
        return { ok: true, message: `attached ${file.name} (${file.buffer.length} bytes) to [${a.index}]` }
      }
      case 'pressKey': {
        if (a.index !== undefined) {
          const loc = await this.resolve(a.index)
          await loc.press(a.key, { timeout: 5000 })
        } else {
          await this.page.keyboard.press(a.key)
        }
        return { ok: true, message: `pressed ${a.key}` }
      }
      case 'scroll': {
        if (a.direction === 'element') {
          if (a.index === undefined) return { ok: false, message: 'scroll to element needs an index' }
          const loc = await this.resolve(a.index)
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 })
          return { ok: true, message: `scrolled to [${a.index}]` }
        }
        const amount = a.amount ?? 0
        const before = await this.page.evaluate(() => window.scrollY)
        if (a.direction === 'top') await this.page.evaluate(() => window.scrollTo({ top: 0 }))
        else if (a.direction === 'bottom') await this.page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }))
        else {
          const dy = a.direction === 'down' ? 1 : -1
          await this.page.evaluate(([d, px]) => window.scrollBy({ top: d * (px || window.innerHeight * 0.85) }), [dy, amount] as [number, number])
        }
        await settlePage(this.page, { quiet: 80, max: 600 }) // allow lazy-loaded content to arrive
        const after = await this.page.evaluate(() => window.scrollY)
        if (Math.abs(after - before) < 4 && a.direction !== 'top') {
          return { ok: true, message: `scrolled ${a.direction} but the page did not move (already at the ${a.direction === 'up' ? 'top' : 'bottom'})` }
        }
        return { ok: true, message: `scrolled ${a.direction} (y: ${Math.round(before)} → ${Math.round(after)})` }
      }

      // ---- observe ---------------------------------------------------------
      case 'wait': {
        if (a.forText) {
          const loc = this.page.getByText(a.forText, { exact: false }).first()
          const ok = await loc.waitFor({ state: 'visible', timeout: a.ms ?? 10_000 }).then(() => true, () => false)
          return ok
            ? { ok: true, message: `"${a.forText}" appeared` }
            : { ok: false, message: `"${a.forText}" did not appear within ${(a.ms ?? 10_000) / 1000}s` }
        }
        if (a.ms) {
          await this.page.waitForTimeout(a.ms)
          return { ok: true, message: `waited ${a.ms}ms` }
        }
        await this.page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined)
        return { ok: true, message: 'waited for the page to settle' }
      }
      case 'find': {
        if (!this.observation) return { ok: false, message: 'no observation available' }
        const hits = findElements(this.observation, a.text)
        if (hits.length === 0) {
          return { ok: false, message: `no element matching "${a.text}" — try extract to read the page, or scroll` }
        }
        const list = hits.slice(0, 20).map(renderElement).join('\n')
        return {
          ok: true,
          message: `found ${hits.length} element(s) matching "${a.text}"`,
          data: list + (hits.length > 20 ? `\n  … ${hits.length - 20} more` : ''),
        }
      }
      case 'extract': {
        const parts: string[] = []
        for (const f of this.page.frames().slice(0, 12)) {
          const t = await f.evaluate(() => document.body?.innerText ?? '').catch(() => '')
          if (t.trim()) parts.push(t.trim())
        }
        let text = parts.join('\n---\n').replace(/\n{3,}/g, '\n\n')
        if (text.length > 6000) text = text.slice(0, 6000) + '\n…[truncated]'
        return { ok: true, message: `extracted ${text.length} characters of page text`, data: text }
      }

      // ---- assert ----------------------------------------------------------
      case 'assertVisible': {
        if (a.index !== undefined) {
          const loc = await this.resolve(a.index)
          const ok = await loc.waitFor({ state: 'visible', timeout: ASSERT_WAIT_MS }).then(() => true, () => false)
          return ok
            ? { ok: true, message: `ASSERTION PASSED: [${a.index}] is visible` }
            : { ok: false, message: `ASSERTION FAILED: [${a.index}] is not visible` }
        }
        const loc = this.page.getByText(a.text!, { exact: false }).first()
        const ok = await loc.waitFor({ state: 'visible', timeout: ASSERT_WAIT_MS }).then(() => true, () => false)
        return ok
          ? { ok: true, message: `ASSERTION PASSED: text "${a.text}" is visible` }
          : { ok: false, message: `ASSERTION FAILED: text "${a.text}" is not visible on the page` }
      }
      case 'assertText': {
        const read = async (): Promise<string> => {
          if (a.index !== undefined) {
            const loc = await this.resolve(a.index)
            const inner = await loc.innerText().catch(() => '')
            const val = await loc.inputValue().catch(() => '')
            return `${inner}\n${val}`
          }
          const parts: string[] = []
          for (const f of this.page.frames().slice(0, 12)) {
            parts.push(await f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))
          }
          return parts.join('\n')
        }
        // `exact` means the text equals a whole visible line, case-sensitively.
        // Substring matching is forgiving to the point of being meaningless on
        // short strings: "10" is on almost every page.
        const present = (text: string): boolean =>
          a.exact
            ? text.split(/\r?\n/).some((line) => line.trim() === a.text.trim())
            : text.toLowerCase().includes(a.text.toLowerCase())
        const want = !a.absent
        const deadline = Date.now() + ASSERT_WAIT_MS
        let has = present(await read())
        while (has !== want && Date.now() < deadline) {
          await this.page.waitForTimeout(250)
          has = present(await read())
        }
        const where = a.index !== undefined ? `element [${a.index}]` : 'the page'
        const how = a.exact ? 'exactly ' : ''
        if (has === want) {
          return { ok: true, message: `ASSERTION PASSED: ${where} ${a.absent ? 'does not contain' : 'contains'} ${how}"${a.text}"` }
        }
        return { ok: false, message: `ASSERTION FAILED: ${where} ${a.absent ? `contains ${how}"${a.text}" but should not` : `does not contain ${how}"${a.text}"`}` }
      }
      case 'assertUrl': {
        const deadline = Date.now() + ASSERT_WAIT_MS
        while (!this.page.url().includes(a.contains) && Date.now() < deadline) await this.page.waitForTimeout(200)
        const url = this.page.url()
        return url.includes(a.contains)
          ? { ok: true, message: `ASSERTION PASSED: URL "${url}" contains "${a.contains}"` }
          : { ok: false, message: `ASSERTION FAILED: URL "${url}" does not contain "${a.contains}"` }
      }
      case 'assertValue': {
        const loc = await this.resolve(a.index)
        const expected = applySecretPlaceholders(a.text, this.values).toLowerCase()
        const deadline = Date.now() + ASSERT_WAIT_MS
        const read = async (): Promise<{ value: string; ticked: boolean }> => {
          // A checkbox or radio has no useful value; what the test means is
          // whether it is ticked.
          const checked = await loc.isChecked().catch(() => null)
          if (checked !== null) return { value: checked ? 'checked' : 'unchecked', ticked: true }
          const v = await loc.inputValue().catch(() => null)
          if (v !== null) return { value: v, ticked: false }
          return { value: (await loc.innerText().catch(() => '')) || '', ticked: false }
        }
        // "unchecked" contains "checked", so a ticked state must be compared
        // exactly or every expectation about it passes.
        const matches = (r: { value: string; ticked: boolean }): boolean =>
          r.ticked ? r.value === expected.trim() : r.value.toLowerCase().includes(expected)
        let actual = await read()
        while (!matches(actual) && Date.now() < deadline) {
          await this.page.waitForTimeout(250)
          actual = await read()
        }
        if (matches(actual)) return { ok: true, message: `ASSERTION PASSED: [${a.index}] is "${actual.value}"` }
        return {
          ok: false,
          message: actual.ticked
            ? `ASSERTION FAILED: [${a.index}] is "${actual.value}", expected "${a.text}"`
            : `ASSERTION FAILED: [${a.index}] value is "${actual.value}", expected it to contain "${a.text}"`,
        }
      }

      case 'assertValidation': {
        const loc = await this.resolve(a.index)
        const deadline = Date.now() + ASSERT_WAIT_MS
        let state = await readValidity(loc)
        const matches = () => {
          if (state.invalid === a.valid) return false // invalid when valid was wanted, or the reverse
          if (!a.valid && a.message) return state.message.toLowerCase().includes(a.message.toLowerCase())
          return true
        }
        while (!matches() && Date.now() < deadline) {
          await this.page.waitForTimeout(250)
          state = await readValidity(loc)
        }
        const shown = state.message ? ` ("${state.message}")` : ''
        if (matches()) {
          return { ok: true, message: `ASSERTION PASSED: the page reports [${a.index}] as ${a.valid ? 'valid' : 'invalid'}${shown}` }
        }
        if (state.invalid === a.valid) {
          return { ok: false, message: `ASSERTION FAILED: expected [${a.index}] to be reported as ${a.valid ? 'valid' : 'invalid'}, but the page reports it as ${state.invalid ? 'invalid' : 'valid'}${shown}` }
        }
        return { ok: false, message: `ASSERTION FAILED: [${a.index}] is invalid as expected, but the message is${shown || ' empty'}, not "${a.message}"` }
      }
      case 'assertCount': {
        const deadline = Date.now() + ASSERT_WAIT_MS
        let n = await this.countMatches(a)
        const ok = () => (a.equals === undefined || n === a.equals) && (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max)
        while (!ok() && Date.now() < deadline) {
          await this.page.waitForTimeout(250)
          n = await this.countMatches(a)
        }
        const what = a.text ? `elements containing "${a.text}"` : `${a.role} elements${a.nameContains ? ` named like "${a.nameContains}"` : ''}`
        const wanted = a.equals !== undefined ? `exactly ${a.equals}` : [a.min !== undefined ? `at least ${a.min}` : '', a.max !== undefined ? `at most ${a.max}` : ''].filter(Boolean).join(' and ')
        return ok()
          ? { ok: true, message: `ASSERTION PASSED: found ${n} ${what} (wanted ${wanted})` }
          : { ok: false, message: `ASSERTION FAILED: found ${n} ${what}, expected ${wanted}` }
      }
      case 'assertOrder': {
        const deadline = Date.now() + ASSERT_WAIT_MS
        let report = await this.checkOrder(a.text)
        while (!report.ok && Date.now() < deadline) {
          await this.page.waitForTimeout(250)
          report = await this.checkOrder(a.text)
        }
        return report.ok
          ? { ok: true, message: `ASSERTION PASSED: these appear in order — ${a.text.join(' → ')}` }
          : { ok: false, message: `ASSERTION FAILED: ${report.message}` }
      }

      case 'finish':
        return { ok: true, message: `finish(${a.verdict}): ${a.reason}` }
    }
  }

  private async settle(action: Action): Promise<void> {
    const profile = settleProfile(action)
    if (profile) await settlePage(this.page, profile)
  }

  /** Count visible matches across every frame. */
  private async countMatches(a: { text?: string; role?: string; nameContains?: string }): Promise<number> {
    let total = 0
    for (const frame of this.page.frames().slice(0, 12)) {
      try {
        const loc = a.text
          ? frame.getByText(a.text, { exact: false })
          : frame.getByRole(a.role as Parameters<Frame['getByRole']>[0], a.nameContains ? { name: a.nameContains, exact: false } : {})
        const n = await loc.count()
        for (let i = 0; i < Math.min(n, 300); i++) {
          if (await loc.nth(i).isVisible().catch(() => false)) total++
        }
      } catch {
        /* a role name the page does not use, or a detached frame */
      }
    }
    return total
  }

  /** Do these strings appear down the page in the order given? */
  private async checkOrder(texts: string[]): Promise<{ ok: boolean; message: string }> {
    const parts: string[] = []
    for (const f of this.page.frames().slice(0, 12)) {
      parts.push(await f.evaluate(() => document.body?.innerText ?? '').catch(() => ''))
    }
    const haystack = parts.join('\n').toLowerCase()
    let cursor = 0
    for (const [i, raw] of texts.entries()) {
      const needle = raw.toLowerCase().trim()
      const at = haystack.indexOf(needle, cursor)
      if (at < 0) {
        const anywhere = haystack.indexOf(needle)
        if (anywhere < 0) return { ok: false, message: `"${raw}" is not on the page at all` }
        return { ok: false, message: `"${raw}" appears before "${texts[i - 1]}", not after it` }
      }
      cursor = at + needle.length
    }
    return { ok: true, message: 'in order' }
  }
}

const VALIDITY_JS = `
(el) => {
  const native = typeof el.checkValidity === 'function' ? el.checkValidity() : true;
  const aria = el.getAttribute('aria-invalid') === 'true';
  const ids = (el.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
  let described = '';
  for (const id of ids) {
    const n = document.getElementById(id);
    if (n) described += ' ' + (n.innerText || n.textContent || '');
  }
  return { invalid: !native || aria, message: (el.validationMessage || described || '').trim().slice(0, 300) };
}`
const validityFn = new Function('return (' + VALIDITY_JS + ')')() as (el: Element) => { invalid: boolean; message: string }

/**
 * Is the page treating this field as invalid, and what does it say?
 *
 * Three sources, because sites use all three: the browser's own constraint
 * validation, `aria-invalid` for hand-rolled validation, and the text of
 * whatever `aria-describedby` points at.
 */
async function readValidity(loc: Locator): Promise<{ invalid: boolean; message: string }> {
  try {
    return await loc.evaluate(validityFn)
  } catch {
    return { invalid: false, message: '' }
  }
}

/**
 * How long to wait after each kind of action, or null for "do not wait".
 *
 * Assertions poll for five seconds by themselves and reads cannot change the
 * page, so both would only be waiting for nothing.
 */
function settleProfile(action: Action): SettleOptions | null {
  switch (action.type) {
    case 'finish':
    case 'find':
    case 'extract':
    case 'wait':
    case 'switchTab':
    case 'assertVisible':
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
    case 'assertValidation':
    case 'assertCount':
    case 'assertOrder':
      return null
    case 'type':
      // A keystroke without a submit renders at most an inline hint.
      return action.submit ? { quiet: 120, max: 1500, grace: 300 } : { quiet: 80, max: 600, grace: 120 }
    case 'hover':
    case 'scroll':
      return { quiet: 80, max: 600, grace: 120 }
    default:
      // click, navigate, goBack, select, pressKey, upload: these can start a
      // navigation or an XHR render.
      return { quiet: 120, max: 1500, grace: 300 }
  }
}
