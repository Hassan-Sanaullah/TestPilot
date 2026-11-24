/**
 * Turning a live element into a locator that will still work tomorrow.
 *
 * Playwright's own guidance is to prefer user-facing locators — role and
 * accessible name, then label, placeholder and text — and to treat CSS as a
 * last resort. Rather than reimplement the accessible-name algorithm (and get
 * it subtly wrong), we propose candidates and then VERIFY each one against the
 * live page: a candidate is accepted only if it resolves to the very element we
 * meant. A bad guess simply fails and we move on.
 */
import type { Frame, Locator, Page } from 'playwright'
import type { ElementRef, LocatorCandidate } from '@testpilot/shared'
import { ELEMENT_ATTR } from './perception'

/** Read the facts needed to propose locators, from the element itself. */
const DESCRIBE_JS = `
(el) => {
  const text = (n) => (n ? (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ') : '');
  const TEST_ATTRS = ['data-testid','data-test-id','data-test','data-cy','data-qa','data-pw'];
  let testId = '';
  for (const a of TEST_ATTRS) { const v = el.getAttribute(a); if (v) { testId = v; break; } }

  // Role as assistive technology sees it, not the tag name.
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const TEXTBOX = ['text','email','password','search','tel','url','number','date','time','datetime-local','month','week',''];
  let role = el.getAttribute('role') || '';
  if (!role) {
    if (tag === 'a' && el.hasAttribute('href')) role = 'link';
    else if (tag === 'button') role = 'button';
    else if (tag === 'select') role = el.multiple ? 'listbox' : 'combobox';
    else if (tag === 'textarea') role = 'textbox';
    else if (tag === 'summary') role = 'button';
    else if (tag === 'input') {
      if (type === 'checkbox') role = 'checkbox';
      else if (type === 'radio') role = 'radio';
      else if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') role = 'button';
      else if (type === 'range') role = 'slider';
      else if (type === 'number') role = 'spinbutton';
      else if (type === 'search') role = 'searchbox';
      else if (TEXTBOX.indexOf(type) !== -1) role = 'textbox';
    }
    else if (el.getAttribute('contenteditable') === 'true') role = 'textbox';
  }

  // Approximate the accessible name the way browsers do, in priority order.
  let name = el.getAttribute('aria-label') || '';
  if (!name) {
    const by = el.getAttribute('aria-labelledby');
    if (by) name = by.split(/\\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
  }
  let labelText = '';
  if (el.id) {
    try { labelText = text(document.querySelector('label[for="' + CSS.escape(el.id) + '"]')); } catch (e) {}
  }
  if (!labelText) {
    const wrap = el.closest ? el.closest('label') : null;
    if (wrap) labelText = text(wrap);
  }
  if (!name) name = labelText;
  if (!name && (tag === 'button' || tag === 'a' || tag === 'summary')) name = text(el);
  if (!name && tag === 'input' && (type === 'submit' || type === 'button')) name = el.value || '';
  if (!name) name = el.getAttribute('title') || '';

  return {
    testId: testId,
    role: role,
    name: (name || '').trim().slice(0, 120),
    label: (labelText || '').trim().slice(0, 120),
    placeholder: (el.getAttribute('placeholder') || '').trim().slice(0, 120),
    text: text(el).slice(0, 80),
    tag: tag,
    type: type,
    id: el.id || '',
    nameAttr: el.getAttribute('name') || '',
  };
}
`

export interface ElementFacts {
  testId: string
  role: string
  name: string
  label: string
  placeholder: string
  text: string
  tag: string
  type: string
  id: string
  nameAttr: string
}

/** Build a Playwright locator from a candidate, on a page or a frame. */
export function toLocator(scope: Page | Frame, c: LocatorCandidate): Locator {
  switch (c.by) {
    case 'testId':
      return scope.getByTestId(c.value)
    case 'role':
      return c.name ? scope.getByRole(c.role as Parameters<Page['getByRole']>[0], { name: c.name, exact: true }) : scope.getByRole(c.role as Parameters<Page['getByRole']>[0])
    case 'label':
      return scope.getByLabel(c.value, { exact: true })
    case 'placeholder':
      return scope.getByPlaceholder(c.value, { exact: true })
    case 'text':
      return scope.getByText(c.value, { exact: true })
    case 'css':
      return scope.locator(c.value)
  }
}

function candidatesFor(f: ElementFacts): LocatorCandidate[] {
  const out: LocatorCandidate[] = []
  if (f.testId) out.push({ by: 'testId', value: f.testId })
  if (f.role && f.name) out.push({ by: 'role', role: f.role, name: f.name })
  if (f.label) out.push({ by: 'label', value: f.label })
  if (f.placeholder) out.push({ by: 'placeholder', value: f.placeholder })
  if (f.role && !f.name) out.push({ by: 'role', role: f.role })
  if (f.text && f.text.length <= 60 && f.tag !== 'input') out.push({ by: 'text', value: f.text })
  // Last resorts: stable-ish attributes before anything structural.
  if (f.id) out.push({ by: 'css', value: `#${CSS_escape(f.id)}` })
  if (f.nameAttr) out.push({ by: 'css', value: `${f.tag}[name="${f.nameAttr}"]` })
  return out
}

function CSS_escape(v: string): string {
  return v.replace(/([^\w-])/g, '\\$1')
}

/**
 * Record how to find this element again. Each candidate is tried against the
 * live page and kept only if it actually resolves to this same element, so a
 * stored locator is one that has already been proven to work.
 */
export async function captureRef(scope: Page | Frame, target: Locator, agentId: number): Promise<ElementRef | null> {
  let facts: ElementFacts
  try {
    facts = (await target.evaluate(new Function(`return (${DESCRIBE_JS})`)() as (el: Element) => ElementFacts)) as ElementFacts
  } catch {
    return null
  }

  const description = [facts.role || facts.tag, facts.name || facts.label || facts.placeholder || facts.text].filter(Boolean).join(' ').trim() || facts.tag

  // Keep looking after the first match: the extras become `alternates`, which
  // let replay repair a renamed attribute without consulting a model.
  const verified: { candidate: LocatorCandidate; nth?: number }[] = []
  for (const candidate of candidatesFor(facts)) {
    if (verified.length > MAX_ALTERNATES) break
    try {
      const loc = toLocator(scope, candidate)
      const count = await loc.count()
      if (count === 0) continue
      if (count === 1) {
        if (await matchesTarget(loc, agentId)) verified.push({ candidate })
        continue
      }
      // Ambiguous: accept it only if we can say which one we meant.
      for (let i = 0; i < Math.min(count, 8); i++) {
        if (await matchesTarget(loc.nth(i), agentId)) {
          verified.push({ candidate, nth: i })
          break
        }
      }
    } catch {
      /* a candidate that throws is simply not usable */
    }
  }
  if (verified.length === 0) return null
  const [primary, ...rest] = verified
  return { candidate: primary.candidate, nth: primary.nth, description, ...(rest.length ? { alternates: rest } : {}) }
}

/** Primary plus this many spares; more than a few is wasted capture time. */
const MAX_ALTERNATES = 3

/** Is this locator pointing at the element the agent actually acted on? */
async function matchesTarget(loc: Locator, agentId: number): Promise<boolean> {
  try {
    const attr = await loc.getAttribute(ELEMENT_ATTR, { timeout: 1500 })
    return attr === String(agentId)
  } catch {
    return false
  }
}

/** Resolve a stored reference on a page, searching frames as perception does. */
export async function resolveRef(page: Page, ref: ElementRef): Promise<Locator | null> {
  return resolveCandidate(page, ref.candidate, ref.nth)
}

async function resolveCandidate(page: Page, candidate: LocatorCandidate, nth?: number): Promise<Locator | null> {
  for (const frame of page.frames()) {
    try {
      const base = toLocator(frame, candidate)
      const count = await base.count()
      if (count === 0) continue
      const loc = nth !== undefined && count > 1 ? base.nth(nth) : base.first()
      if ((await loc.count()) > 0) return loc
    } catch {
      /* detached frame */
    }
  }
  return null
}

export interface ResolveOutcome {
  locator: Locator | null
  /** set when an alternate matched instead of the primary candidate */
  repairedTo?: { candidate: LocatorCandidate; nth?: number }
}

/**
 * Resolve a reference, giving the page time to produce the element.
 *
 * The old replay resolved once, immediately. Anything rendered a moment later
 * — most of a single-page app — was declared missing, and a model was asked to
 * find a replacement for an element that was simply not there yet.
 */
export async function resolveRefWaiting(page: Page, ref: ElementRef, timeoutMs = 5000): Promise<ResolveOutcome> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await resolveCandidate(page, ref.candidate, ref.nth)
    if (hit) return { locator: hit }
    // The primary may be gone for good (a renamed test id). Spend the rest of
    // the budget on the spares, which were verified against the same element.
    for (const alt of ref.alternates ?? []) {
      const found = await resolveCandidate(page, alt.candidate, alt.nth)
      if (found) return { locator: found, repairedTo: alt }
    }
    if (Date.now() >= deadline) return { locator: null }
    await page.waitForTimeout(150).catch(() => undefined)
    if (page.isClosed()) return { locator: null }
  }
}
