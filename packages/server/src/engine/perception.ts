/**
 * M1 — Observe. Turns the live page into a compact, indexed list of
 * interactive elements that the model refers to by index (`click 7`).
 *
 * Built for real websites, not just small demos:
 *   - collects every CSS-visible interactive element, in the viewport or not
 *     (Playwright auto-scrolls on click, so off-screen elements are actionable),
 *   - walks OPEN SHADOW ROOTS and every iframe,
 *   - de-duplicates wrapper/child pairs that occupy the same box,
 *   - reports <select> options, checkbox state, disabled state,
 *   - renders a prioritised subset (in-viewport first) and says how much was
 *     left out, so the model knows to scroll or use `find`.
 */
import type { Frame, Page } from 'playwright'
import type { ObservationData, ObservedElement } from '@testpilot/shared'

export const ELEMENT_ATTR = 'data-tp-id'

/** Collected in the page context. Returns elements for ONE frame. */
const COLLECT_JS = `
(opts) => {
  const START = opts.startIndex;
  const LIMIT = opts.limit;
  const ATTR = 'data-tp-id';

  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY']);
  const CLICKABLE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','menuitemcheckbox',
    'menuitemradio','switch','combobox','textbox','searchbox','slider','spinbutton','treeitem','option','listbox']);
  const TEXT_INPUT_TYPES = new Set(['text','email','password','search','tel','url','number','date','time',
    'datetime-local','month','week','']);

  // --- walk light DOM + open shadow roots, in document order -----------------
  function collectNodes(root, out, depth) {
    if (depth > 60) return;
    const kids = root.children ? Array.from(root.children) : [];
    for (const el of kids) {
      out.push(el);
      if (el.shadowRoot) collectNodes(el.shadowRoot, out, depth + 1);
      collectNodes(el, out, depth + 1);
    }
  }

  function isHidden(el) {
    // checkVisibility covers content-visibility / display:contents in modern Chromium
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) return true;
    if (el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const parts = labelledBy.split(/\\s+/).map(id => {
        const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
        return n ? n.innerText || n.textContent || '' : '';
      }).join(' ').trim();
      if (parts) return parts.replace(/\\s+/g, ' ').slice(0, 140);
    }
    if (el.id) {
      try {
        const root = el.getRootNode();
        const lab = (root.querySelector ? root : document).querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab && (lab.innerText || '').trim()) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 140);
      } catch (e) {}
    }
    const closestLabel = el.closest ? el.closest('label') : null;
    if (closestLabel && (closestLabel.innerText || '').trim()) {
      return closestLabel.innerText.trim().replace(/\\s+/g, ' ').slice(0, 140);
    }
    if (el.placeholder) return el.placeholder.trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) return text.slice(0, 140);
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim().slice(0, 140);
    if (el.name) return String(el.name).trim();
    if (el.value) return String(el.value).trim().slice(0, 80);
    return '';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') return (el.type || 'text').toLowerCase();
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textarea';
    if (el.getAttribute('contenteditable') === 'true') return 'textbox';
    return t;
  }

  function isEditable(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase());
    if (el.getAttribute('contenteditable') === 'true') return true;
    const r = el.getAttribute('role');
    return r === 'textbox' || r === 'searchbox';
  }

  function isInteractive(el) {
    if (el.tagName === 'OPTION') return false;            // handled by its <select>
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const r = el.getAttribute('role');
    if (r && CLICKABLE_ROLES.has(r)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (el.tabIndex >= 0 && (el.onclick || el.getAttribute('role'))) return true;
    // common SPA pattern: a div/span styled as a button
    if (el.tabIndex >= 0 && getComputedStyle(el).cursor === 'pointer' &&
        (el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'LI')) return true;
    return false;
  }

  // --- clear stale ids (light + shadow) --------------------------------------
  const all = [];
  collectNodes(document, all, 0);
  for (const el of all) { if (el.hasAttribute && el.hasAttribute(ATTR)) el.removeAttribute(ATTR); }

  const vh = window.innerHeight, vw = window.innerWidth;
  const out = [];
  const seen = new Set();
  let idx = START;
  let found = 0;

  for (const el of all) {
    if (!el.getBoundingClientRect) continue;
    if (!isInteractive(el)) continue;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
    // A file input is almost always hidden behind a styled label or button, so
    // the usual visibility and size filters would drop the one element an
    // upload test needs. setInputFiles does not require it to be visible.
    const isFileInput = el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file';
    if (!isFileInput) {
      if (isHidden(el)) continue;
      const r0 = el.getBoundingClientRect();
      if (r0.width < 2 || r0.height < 2) continue;        // zero-size / clipped
    }
    const r = el.getBoundingClientRect();

    const label = labelOf(el);
    const role = roleOf(el);
    // de-duplicate wrapper/child pairs sharing the same box and label
    const key = role + '|' + label + '|' + Math.round(r.x) + '|' + Math.round(r.y) + '|' +
                Math.round(r.width) + '|' + Math.round(r.height) + '|' + (isFileInput ? (el.name || el.id || '') : '');
    if (seen.has(key)) continue;
    seen.add(key);

    found++;
    if (out.length >= LIMIT) continue;                    // keep counting, stop storing

    const inViewport = !isFileInput && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    const item = {
      index: idx,
      role: role,
      label: label,
      value: (el.value != null ? String(el.value) : '').slice(0, 80),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      editable: isEditable(el),
      inViewport: inViewport,
    };
    if (!inViewport) item.off = r.top >= vh ? 'below' : 'above';
    if (el.tagName === 'SELECT' && el.options) {
      item.options = Array.from(el.options).slice(0, 15).map(o => (o.label || o.value || '').trim()).filter(Boolean);
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) item.checked = !!el.checked;
    if (el.tagName === 'A' && el.href) item.href = el.href;
    if (el.getRootNode() instanceof ShadowRoot) item.shadow = true;

    el.setAttribute(ATTR, String(idx));
    out.push(item);
    idx++;
  }

  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
    viewportHeight: vh,
    count: out.length,
    found: found,
    elements: out,
  };
}
`

interface FrameResult {
  url: string
  title: string
  scrollY: number
  scrollHeight: number
  viewportHeight: number
  count: number
  found: number
  elements: ObservedElement[]
}

// Playwright (Node) evaluates a bare string as an expression and will not call
// it with an argument, so materialise the source into a real function once.
const collectFn = new Function(`return (${COLLECT_JS})`)() as (opts: { startIndex: number; limit: number }) => FrameResult

// Collecting is cheap (plain objects); only RENDERING costs prompt tokens. So
// we store a lot — which is what makes `find` able to reach an element the
// prompt never listed — and render a prioritised slice.
const MAX_COLLECT = 1500
const MAX_FRAMES = 20

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}

export async function observe(page: Page, opts: { maxElements?: number; tabCount?: number; activeTab?: number } = {}): Promise<ObservationData> {
  const maxElements = opts.maxElements ?? MAX_COLLECT
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
  } catch {
    /* best effort */
  }

  let main: FrameResult | null = null
  const elements: ObservedElement[] = []
  let offset = 0
  let totalFound = 0
  let frameNo = 0

  for (const frame of page.frames() as Frame[]) {
    if (offset >= maxElements || frameNo >= MAX_FRAMES) break
    const thisFrame = frameNo++
    let data: FrameResult
    try {
      data = await withTimeout(frame.evaluate(collectFn, { startIndex: offset, limit: maxElements - offset }), 3000)
    } catch {
      continue // detached, cross-origin-restricted or slow frame
    }
    if (!data || !Array.isArray(data.elements)) continue
    if (!main) main = data
    for (const el of data.elements) {
      if (thisFrame > 0) el.frame = thisFrame
      elements.push(el)
    }
    offset += data.count
    totalFound += data.found
  }

  if (!main) {
    main = { url: page.url(), title: '', scrollY: 0, scrollHeight: 0, viewportHeight: 0, count: 0, found: 0, elements: [] }
  }

  return {
    url: main.url,
    title: main.title,
    scrollY: main.scrollY,
    scrollHeight: main.scrollHeight,
    viewportHeight: main.viewportHeight,
    elements,
    totalFound,
    tabCount: opts.tabCount,
    activeTab: opts.activeTab,
  }
}

/**
 * Find elements whose label matches `text` (the `find` action). Ranked, so an
 * exact match always beats a loose one: searching "Add item 390" must not
 * return "Add item 3" first.
 */
export function findElements(obs: ObservationData, text: string): ObservedElement[] {
  const needle = text.toLowerCase().trim()
  if (!needle) return []
  const exact: ObservedElement[] = []
  const contains: ObservedElement[] = []
  const contained: ObservedElement[] = []
  const byValue: ObservedElement[] = []
  for (const el of obs.elements) {
    const label = el.label.toLowerCase().trim()
    if (!label && !el.value) continue
    if (label === needle) exact.push(el)
    else if (label.includes(needle)) contains.push(el)
    // the model often adds a noun ("Search products field") — allow the reverse,
    // but only for labels substantial enough not to match everything
    else if (label.length >= 4 && needle.includes(label)) contained.push(el)
    else if (el.value && el.value.toLowerCase().includes(needle)) byValue.push(el)
  }
  const byLabelLength = (a: ObservedElement, b: ObservedElement) => a.label.length - b.label.length
  return [...exact, ...contains.sort(byLabelLength), ...contained.sort((a, b) => b.label.length - a.label.length), ...byValue]
}

export function renderElement(el: ObservedElement): string {
  const bits: string[] = []
  if (el.value) bits.push(`value="${el.value}"`)
  if (el.options?.length) bits.push(`options: ${el.options.join(' | ')}`)
  if (el.checked !== undefined) bits.push(el.checked ? 'checked' : 'unchecked')
  if (el.disabled) bits.push('disabled')
  if (el.off) bits.push(el.off === 'below' ? '↓ below view' : '↑ above view')
  if (el.frame) bits.push(`iframe ${el.frame}`)
  if (el.shadow) bits.push('shadow')
  const extra = bits.length ? `  (${bits.join(', ')})` : ''
  return `  [${el.index}] ${el.role} "${el.label}"${extra}`
}

/**
 * Compact text fed to the model. Elements in the viewport are listed first so
 * that a truncated list still contains what the user can see.
 */
export function renderObservation(obs: ObservationData, maxElements = 180): string {
  const lines = [`URL: ${obs.url}`, `Title: ${obs.title}`]

  if (obs.scrollHeight > obs.viewportHeight && obs.viewportHeight > 0) {
    const max = Math.max(1, obs.scrollHeight - obs.viewportHeight)
    const pct = Math.min(100, Math.round((100 * obs.scrollY) / max))
    lines.push(`Scroll: ${pct}% down a page ${obs.scrollHeight}px tall (viewport ${obs.viewportHeight}px)`)
  }
  if (obs.tabCount && obs.tabCount > 1) {
    lines.push(`Tabs: ${obs.tabCount} open, you are on tab ${obs.activeTab ?? 0} — use switchTab to change`)
  }

  const inView = obs.elements.filter((e) => e.inViewport)
  const offView = obs.elements.filter((e) => !e.inViewport)
  const shown = [...inView, ...offView].slice(0, maxElements)
  const omitted = obs.totalFound - shown.length

  lines.push(
    `Interactive elements: ${obs.totalFound} on the page, ${shown.length} listed below ` +
      `(${inView.length} currently in view). You may act on ANY listed index — the browser scrolls to it automatically.`,
  )
  lines.push('[index] role "label"  (details)')
  for (const el of shown) lines.push(renderElement(el))

  if (omitted > 0) {
    lines.push(`  … ${omitted} more element(s) not listed. Use find("text") to locate one by label, or scroll.`)
  }
  if (obs.elements.length === 0) {
    lines.push('  (no interactive elements found — the page may still be loading; try wait, or extract to read it)')
  }
  return lines.join('\n')
}

/**
 * A cheap signature of the page, used to decide whether a planned sequence of
 * actions is still about the page the model looked at.
 *
 * It deliberately does NOT touch `data-tp-id`: `observe()` strips those
 * attributes, so anything that observes between resolving an element and
 * acting on it breaks the action. Counting how many elements still carry one is
 * itself a useful signal — a re-render drops them all.
 */
const FINGERPRINT_JS = `
() => {
  const q = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open]';
  let n = 0, tagged = 0;
  const list = document.querySelectorAll(q);
  for (const el of list) { n++; if (el.hasAttribute('data-tp-id')) tagged++; }
  const dialogs = document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]').length;
  return location.href + '|' + n + '|' + tagged + '|' + dialogs;
}`
const fingerprintFn = new Function('return (' + FINGERPRINT_JS + ')')() as () => string

export async function pageFingerprint(page: Page): Promise<string> {
  if (page.isClosed()) return 'closed'
  return page.evaluate(fingerprintFn)
}

/**
 * Every piece of text a person could read on the page right now.
 *
 * The element list tells the model what it can click; it says nothing about
 * error messages, totals, confirmations or headings. Without this the model has
 * to spend a step on `extract` just to find out what happened — and when it
 * does not, it guesses the wording of the message it is supposed to verify, and
 * a wrong guess becomes a failed assertion that gets filed as a bug.
 */
const TEXT_JS = `
() => {
  const out = [];
  const push = (t) => {
    if (!t) return;
    const s = String(t).replace(/\\s+/g, ' ').trim();
    if (s.length >= 3 && s.length <= 200) out.push(s);
  };

  // Leaf text: elements with no element children hold the actual words.
  const walk = (root, depth) => {
    if (depth > 40) return;
    for (const el of Array.from(root.children || [])) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (el.children && el.children.length) walk(el, depth + 1);
      else if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') push(el.innerText || el.textContent);
    }
  };
  walk(document.body || document, 0);

  // Things that exist specifically to announce a change.
  const alerts = [];
  for (const el of document.querySelectorAll('[role=alert],[role=status],[aria-live],.error,.alert,[aria-invalid=true]')) {
    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t && t.length <= 200) alerts.push(t);
  }
  // Native validation messages, which are not in the DOM at all.
  for (const el of document.querySelectorAll('input,select,textarea')) {
    if (typeof el.checkValidity === 'function' && !el.checkValidity() && el.validationMessage) {
      alerts.push(el.validationMessage.replace(/\\s+/g, ' ').trim());
    }
  }
  for (const a of alerts) push(a);

  const seen = new Set();
  const unique = [];
  for (const t of out) { if (!seen.has(t)) { seen.add(t); unique.push(t); } }
  return { text: unique.slice(0, 400), alerts: Array.from(new Set(alerts)).slice(0, 10) };
}`
const textFn = new Function('return (' + TEXT_JS + ')')() as () => { text: string[]; alerts: string[] }

export interface PageText {
  /** every readable string, de-duplicated, in document order */
  text: string[]
  /** the subset that the page is actively announcing */
  alerts: string[]
}

/** Readable text across every frame. */
export async function collectText(page: Page): Promise<PageText> {
  const text: string[] = []
  const alerts: string[] = []
  for (const frame of page.frames().slice(0, 12)) {
    try {
      const r = await frame.evaluate(textFn)
      text.push(...r.text)
      alerts.push(...r.alerts)
    } catch {
      /* detached or navigating */
    }
  }
  const seen = new Set<string>()
  const unique = text.filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
  return { text: unique.slice(0, 400), alerts: [...new Set(alerts)].slice(0, 10) }
}

export interface TextChanges {
  appeared: string[]
  disappeared: string[]
  alerts: string[]
  /** true when the page navigated, so almost everything is new by definition */
  navigated?: boolean
}

/** What changed between two readings of the page. */
export function diffText(before: PageText | null, after: PageText, navigated = false): TextChanges {
  if (!before || navigated) {
    // After a navigation everything is new, so listing it all is noise. Keep
    // what announces itself, the headings, and a short sample.
    return { appeared: after.text.slice(0, 8), disappeared: [], alerts: after.alerts, navigated: true }
  }
  const was = new Set(before.text)
  const now = new Set(after.text)
  return {
    appeared: after.text.filter((t) => !was.has(t)).slice(0, 12),
    disappeared: before.text.filter((t) => !now.has(t)).slice(0, 6),
    alerts: after.alerts,
  }
}

/** The block appended to an observation so the model can see what it caused. */
export function renderChanges(c: TextChanges): string {
  const lines: string[] = []
  if (c.appeared.length || c.disappeared.length) {
    lines.push(c.navigated ? 'ON THIS NEW PAGE' : 'SINCE YOUR LAST ACTION')
    if (c.appeared.length) lines.push(`  appeared: ${c.appeared.map((t) => `"${t}"`).join(' · ')}`)
    if (c.disappeared.length) lines.push(`  disappeared: ${c.disappeared.map((t) => `"${t}"`).join(' · ')}`)
  }
  if (c.alerts.length) lines.push(`ALERTS ON THE PAGE: ${c.alerts.map((t) => `"${t}"`).join(' · ')}`)
  return lines.join('\n')
}
