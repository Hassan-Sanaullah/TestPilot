/**
 * Explorer — walks the application like a user and builds a map of it.
 *
 * This is what makes "press one button and get tests" possible. A flat list of
 * element labels is not enough to write a judgeable test; what matters is:
 *   - which FORMS exist and what FIELDS they have (type, required, options),
 *   - the RULES the page states in its own words ("At least 8 characters",
 *     "SAVE10 = 10% off") — the only honest basis for an expected outcome,
 *   - which pages need a login.
 *
 * It reuses the project's recorded login session when there is one, so the
 * logged-in half of the application is mapped too.
 */
import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { config } from "../config";
import { prisma } from "../db";
import { sharedBrowser } from "./browserPool";
import { detectBlocker } from "./blockers";
import { InventoryCollector, normalizeUrl } from "./inventory";
import { observe } from "./perception";
import { captureAutoSession } from "./session";
import { settlePage } from "./settle";
import { registrableDomain } from "./urls";

export interface FormField {
  label: string;
  type: string;
  required: boolean;
  hint: string;
  options?: string[];
  /**
   * The constraints the page declares in HTML, kept as numbers instead of being
   * flattened into the `hint` sentence. This is what lets boundary values be
   * COMPUTED — "at least 8 characters" as prose can only be pasted into a
   * prompt and hoped for; `minLength: 8` can be turned into a test for 7.
   * Undefined means the page does not declare it.
   */
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  pattern?: string;
  inputMode?: string;
  autocomplete?: string;
  name?: string;
}

export interface FormDescriptor {
  name: string;
  fields: FormField[];
  submitLabel: string;
}

export interface DiscoveredPage {
  url: string;
  title: string;
  kind: string;
  forms: FormDescriptor[];
  actions: string[];
  rules: string[];
  headings: string[];
  reachedVia: string;
  requiresAuth: boolean;
  /**
   * Titles of a few items found in a repeated structure on this page. A
   * generated search test has to search for something that actually exists, and
   * these are the only names we can be sure the application knows.
   */
  samples: string[];
}

/** Runs in the page. Returns the structure a test author would need. */
const EXTRACT_JS = `
() => {
  const txt = (el) => (el ? (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ') : '');

  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','INPUT','SELECT','TEXTAREA','BUTTON','OPTION','SVG','PATH','IMG']);
  // Elements with no element children, i.e. the ones that actually hold text.
  // Class-name-independent, so it works on any site or framework.
  function leafText(root) {
    return Array.from(root.querySelectorAll('*'))
      .filter((n) => n.children.length === 0 && !SKIP_TAGS.has(n.tagName))
      .map(txt)
      .filter(Boolean);
  }

  function labelFor(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return txt(l).replace(/\\*$/, '').trim();
    }
    const wrap = el.closest('label');
    if (wrap) return txt(wrap).slice(0, 80);
    if (el.placeholder) return el.placeholder.trim();
    if (el.name) return el.name;
    return el.type || el.tagName.toLowerCase();
  }

  // The rule a field must satisfy. Preference order matters: the HTML standard
  // first, then machine-readable constraints, and only then nearby small print.
  // (Scraping an app's own CSS class names does not generalise.)
  function hintFor(el) {
    // 1. aria-describedby is the standard way to attach help text to a field.
    const described = el.getAttribute('aria-describedby');
    if (described) {
      const t = described.split(/\\s+/)
        .map((id) => { const n = document.getElementById(id); return n ? txt(n) : ''; })
        .filter(Boolean).join(' ');
      if (t) return t.slice(0, 140);
    }
    // 2. Constraints declared in HTML — exact, and present on any framework.
    const c = [];
    if (el.minLength > 0) c.push('at least ' + el.minLength + ' characters');
    if (el.maxLength > 0 && el.maxLength < 2048) c.push('at most ' + el.maxLength + ' characters');
    if (el.min !== undefined && el.min !== '') c.push('minimum value ' + el.min);
    if (el.max !== undefined && el.max !== '') c.push('maximum value ' + el.max);
    if (el.pattern) c.push('must match ' + el.pattern);
    if (el.getAttribute('title')) c.push(el.getAttribute('title'));
    if (c.length) return c.join(', ').slice(0, 140);
    // 3. The help text immediately AFTER the field. This is the commonest
    //    pattern of all and an ancestor scope misses it entirely: on a flat
    //    form the note is a sibling of the input, not a child of a wrapper, so
    //    el.closest('div') lands on something that wraps the whole form and
    //    returns the first two unrelated labels instead of the rule.
    let sib = el.nextElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      const tag = sib.tagName;
      // Stop at the next field: anything past it belongs to that one.
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL' || tag === 'BUTTON') break;
      const t = txt(sib);
      if (t && t.length > 3 && t.length < 160) return t.slice(0, 140);
      sib = sib.nextElementSibling;
    }

    // 4. Fall back to the small print around the field. Read short LEAF text
    //    nodes rather than guessing at class names, which differ per app and
    //    per framework and never generalise.
    const scope = el.closest('div,p,fieldset,li,td') || el.parentElement;
    if (!scope) return '';
    const own = labelFor(el);
    const bits = leafText(scope).filter((t) => t !== own && t.length > 3 && t.length < 160);
    return bits.slice(0, 2).join(' ').slice(0, 140);
  }

  const forms = Array.from(document.querySelectorAll('form')).map((f) => {
    const fields = Array.from(f.querySelectorAll('input,select,textarea'))
      .filter((el) => (el.type || '').toLowerCase() !== 'hidden')
      .slice(0, 25)
      .map((el) => {
        const o = {
          label: labelFor(el),
          type: (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')).toLowerCase(),
          required: !!el.required,
          hint: hintFor(el),
        };
        // Keep the constraints as data, not prose: these are what boundary
        // values are computed from. maxLength is -1 or huge when unset.
        if (el.minLength > 0) o.minLength = el.minLength;
        if (el.maxLength > 0 && el.maxLength < 2048) o.maxLength = el.maxLength;
        if (el.min !== undefined && el.min !== '') o.min = String(el.min);
        if (el.max !== undefined && el.max !== '') o.max = String(el.max);
        if (el.step !== undefined && el.step !== '') o.step = String(el.step);
        if (el.pattern) o.pattern = el.pattern;
        if (el.inputMode) o.inputMode = el.inputMode;
        if (el.getAttribute('autocomplete')) o.autocomplete = el.getAttribute('autocomplete');
        if (el.name) o.name = el.name;
        if (el.tagName === 'SELECT') o.options = Array.from(el.options).slice(0, 12).map((x) => (x.label || x.value || '').trim()).filter(Boolean);
        return o;
      });
    const submit = f.querySelector('button[type=submit],input[type=submit],button:not([type])');
    return {
      name: f.getAttribute('name') || f.getAttribute('action') || '',
      fields,
      submitLabel: submit ? (txt(submit) || submit.value || 'Submit') : '',
    };
  }).filter((f) => f.fields.length > 0 || f.submitLabel);

  // Sample items from any repeated structure. Keyed on repetition, never on
  // class names or the word "product", so it works on any site.
  const samples = (() => {
    const groups = new Map();
    for (const parent of Array.from(document.querySelectorAll('ul,ol,div,section,tbody,main'))) {
      const kids = Array.from(parent.children || []);
      if (kids.length < 4) continue;
      const signature = kids[0].tagName + '|' + (kids[0].className || '');
      const alike = kids.filter((k) => k.tagName + '|' + (k.className || '') === signature);
      if (alike.length < 4) continue;
      const titles = [];
      for (const k of alike.slice(0, 5)) {
        const head = k.querySelector('h1,h2,h3,h4,h5,a[href],td');
        const t = txt(head).slice(0, 80);
        if (t && t.length >= 3) titles.push(t);
      }
      // Identical rows are a layout grid, not a list of things.
      if (titles.length >= 3 && new Set(titles).size === titles.length) groups.set(signature, titles);
    }
    // The biggest alike-group on the page is the one that holds its content.
    let best = [];
    for (const v of groups.values()) if (v.length > best.length) best = v;
    return best;
  })();

  const actions = Array.from(document.querySelectorAll('button,a[href],[role=button]'))
    .map(txt).map((t) => t.slice(0, 60)).filter(Boolean).slice(0, 40);

  // Rules the page states. Two sources: constraints declared in HTML (exact,
  // language-independent) and visible sentences that read like a rule.
  const declared = [];
  for (const el of Array.from(document.querySelectorAll('input[minlength],input[maxlength],input[pattern],input[min],input[max],input[required][type=email]')).slice(0, 20)) {
    const name = labelFor(el);
    if (el.minLength > 0) declared.push(name + ': at least ' + el.minLength + ' characters');
    if (el.pattern) declared.push(name + ': must match ' + el.pattern);
    if (el.min !== '' && el.min !== undefined && el.type === 'number') declared.push(name + ': minimum ' + el.min);
    if (el.max !== '' && el.max !== undefined && el.type === 'number') declared.push(name + ': maximum ' + el.max);
    if (el.type === 'email' && el.required) declared.push(name + ': must be a valid email address');
  }

  const RULE = /(at least|must be|must contain|minimum|maximum|no more than|required|% off|percent off|free|only|cannot|can't|invalid|not valid|already (exists|registered|taken)|do not match|does not match|too (short|long|weak))/i;
  // Any short piece of visible text that reads like a rule, wherever it lives.
  const placeholders = Array.from(document.querySelectorAll('[placeholder]')).map((el) => el.getAttribute('placeholder') || '');
  const visible = [...leafText(document.body || document), ...placeholders]
    .filter((t) => t && t.length > 6 && t.length < 160 && RULE.test(t));

  const rules = Array.from(new Set([...declared, ...visible])).slice(0, 14);

  const headings = Array.from(document.querySelectorAll('h1,h2')).map(txt).filter(Boolean).slice(0, 8);

  const links = Array.from(document.querySelectorAll('a[href]'))
    .filter((a) => { const h = a.getAttribute('href') || ''; return h && h !== '#' && !h.startsWith('javascript:'); })
    .map((a) => a.href).filter(Boolean);

  // Single-page apps route with JavaScript: the anchor has no usable href, so
  // the only way to find where it goes is to click it.
  const DESTRUCTIVE = /(log ?out|sign ?out|delete|remove|cancel order|unsubscribe|deactivate|reset)/i;
  const anchors = Array.from(document.querySelectorAll('a'));
  const jsNav = anchors
    .map((a, i) => ({ i, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60), href: a.getAttribute('href') || '' }))
    .filter((x) => (!x.href || x.href === '#' || x.href.startsWith('javascript:')) && !DESTRUCTIVE.test(x.text))
    .slice(0, 12);

  return { title: document.title, forms, actions, rules, headings, links, jsNav, samples };
}
`;
const extractFn = new Function(`return (${EXTRACT_JS})`)() as () => {
  title: string;
  forms: FormDescriptor[];
  actions: string[];
  rules: string[];
  headings: string[];
  links: string[];
  jsNav: { i: number; text: string; href: string }[];
  samples: string[];
};

function classify(p: {
  url: string;
  forms: FormDescriptor[];
  headings: string[];
  actions: string[];
}): string {
  let path = p.url.toLowerCase();
  let search = "";
  try {
    const u = new URL(p.url);
    path = u.pathname.toLowerCase();
    search = u.search.toLowerCase();
  } catch {
    /* keep the raw string */
  }
  const hasPassword = p.forms.some((f) =>
    f.fields.some((x) => x.type === "password"),
  );
  if (hasPassword || /login|signin|register|signup|account\/new/.test(path))
    return "auth";
  if (/admin|dashboard|manage/.test(path)) return "admin";
  if (/checkout|payment|shipping/.test(path)) return "checkout";
  if (/cart|basket/.test(path)) return "cart";
  // A single entity: /products/42, /item/abc, or inventory-item.html?id=4
  const entityish = /(product|item|detail|article|post)/.test(path);
  if (
    entityish &&
    (/\/[^/]+$/.test(path.replace(/\.(html?|php|aspx)$/, "")) ||
      /\b(id|sku|slug|pid)=/.test(search))
  ) {
    if (/\bid=|\/[a-z]*\d/.test(search + path)) return "detail";
  }
  // A catalogue is many tiny repeated forms ("Add to cart" per card), not a
  // data-entry page. Check that before treating any form as a form page.
  const tiny = p.forms.filter((f) => f.fields.length <= 1).length;
  if (p.forms.length >= 3 && tiny >= p.forms.length - 1) return "listing";
  if (
    p.actions.filter((a) => /add to cart|buy now|view details/i.test(a))
      .length >= 3
  )
    return "listing";
  if (p.forms.some((f) => f.fields.length >= 2)) return "form";
  return "other";
}

const SKIP =
  /logout|signout|sign-out|__reset|\.(png|jpe?g|gif|svg|pdf|zip|css|js|ico)$/i;

/**
 * Keep the query string — on a great many real sites `?id=4` or `?page=2` IS
 * the page identity, and dropping it collapses the whole catalogue into one
 * entry. Only the fragment is removed.
 */
function canonical(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/"))
      u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * The shape of a URL, with identifiers collapsed: /products/p43 and
 * /products/p7 are both `/products/:id`. Used to stop a crawl spending its
 * whole budget on 50 near-identical product pages instead of finding the
 * checkout.
 */
export function shapeOf(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split("/")
      .map((seg) =>
        /^[0-9]+$/.test(seg) ||
        /^[0-9a-f-]{8,}$/i.test(seg) ||
        (/\d/.test(seg) && /^[a-z]*\d+[a-z0-9-]*$/i.test(seg))
          ? ":id"
          : seg,
      )
      .join("/");
    const params = [...u.searchParams.keys()].sort().join(",");
    return path + (params ? `?${params}` : "");
  } catch {
    return raw;
  }
}

const MAX_PER_SHAPE = 3;
/** Clicking to discover routes is slow, so bound it across the whole crawl. */
const MAX_JS_PROBES = 20;

export interface ExploreResult {
  pages: DiscoveredPage[];
  visited: number;
  loggedIn: boolean;
  /** pages that only became reachable after signing in */
  behindLogin: string[];
}

/**
 * Sign in using the project's test account so the logged-in half of the
 * application gets mapped too. Most of an app's interesting behaviour — orders,
 * admin, account settings — is invisible to a signed-out crawl, and nothing
 * even links to it.
 */
/**
 * Sign in, best effort, by finding the obvious fields. Exported because a run
 * whose saved session has expired needs exactly this, once, before giving up.
 */
export async function tryLogin(
  page: Page,
  loginUrl: string,
  user: string,
  password: string,
): Promise<boolean> {
  const idSelector =
    'input[type=email], input[type=text], input[type=tel], input[name*=email i], input[name*=user i], input[autocomplete="username"]';
  const submitSelector =
    "button[type=submit], input[type=submit], button:not([type]), [role=button]";

  try {
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await dismissOverlays(page);

    const visiblePassword = async () =>
      page
        .locator("input[type=password]:visible")
        .count()
        .catch(() => 0);

    // A registration form has two password fields; a sign-in form has one (or,
    // on a two-step flow, none yet).
    if ((await visiblePassword()) > 1) return false;

    const id = page.locator(idSelector).first();
    if ((await id.count()) === 0) return false;
    await id.fill(user);

    // Two-step sign-in (Google, Microsoft, Okta and many SaaS apps): the
    // password field only appears after submitting the identifier.
    if ((await visiblePassword()) === 0) {
      const next = page.locator(submitSelector).first();
      if ((await next.count()) > 0)
        await next.click({ timeout: 5000 }).catch(() => undefined);
      else await id.press("Enter");
      await page.waitForTimeout(1200);
      await page
        .locator("input[type=password]:visible")
        .first()
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => undefined);
    }

    const pass = page.locator("input[type=password]:visible").first();
    if ((await pass.count()) === 0) return false;
    await pass.fill(password);

    const submit = page.locator(submitSelector).last();
    if ((await submit.count()) > 0)
      await submit.click({ timeout: 5000 }).catch(() => undefined);
    else await pass.press("Enter");

    await page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(600);
    // Signed in if no password field remains wherever we landed.
    return (await visiblePassword()) === 0;
  } catch {
    return false;
  }
}

export async function exploreApp(
  projectId: string,
  opts: { maxPages?: number } = {},
): Promise<ExploreResult> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
  });
  const maxPages = opts.maxPages ?? 14;
  const origin = new URL(project.baseUrl).origin;
  const domain = registrableDomain(new URL(project.baseUrl).hostname);

  const storageState =
    project.storageState && fs.existsSync(project.storageState)
      ? project.storageState
      : undefined;
  let context: BrowserContext | undefined;
  let loggedIn = Boolean(storageState);
  const found: DiscoveredPage[] = [];
  const inventory = new InventoryCollector();

  try {
    const browser = await sharedBrowser(true);
    context = await browser.newContext({
      viewport: {
        width: project.viewportWidth,
        height: project.viewportHeight,
      },
      storageState,
      ignoreHTTPSErrors: true,
    });
    // Consent overlays hide the page from the crawler exactly as they hide it
    // from a user; accept once and the rest of the walk sees the real app.
    context.on("page", (p) =>
      p.on("dialog", (d) => d.accept().catch(() => undefined)),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // Two more tabs in the same context: the walk runs three pages at once and
    // they share cookies, so signing in on one signs in all of them.
    const extraPages: Page[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await context.newPage();
      p.setDefaultTimeout(10_000);
      extraPages.push(p);
    }
    const walkPages = [page, ...extraPages];

    const queue: { url: string; via: string }[] = [
      { url: canonical(project.baseUrl), via: "start" },
    ];
    const seen = new Set<string>();
    const shapes = new Map<string, number>();
    let signedIn = Boolean(storageState);
    let jsProbes = 0;
    let consentHandled = false;

    /**
     * Visit one page: read it, record it, and queue what it links to.
     *
     * `allowProbe` is only true for one worker. Click-probing navigates the
     * page away and back to find JavaScript routes, and two workers doing that
     * on the same tab would each undo the other.
     */
    const visit = async (
      page: Page,
      item: { url: string; via: string },
      allowProbe: boolean,
      limit: number,
    ): Promise<void> => {
      const { url, via } = item;
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
      } catch {
        return;
      }
      if (await dismissOverlays(page, !consentHandled)) consentHandled = true;
      await settlePage(page, { quiet: 100, max: 1200, grace: 250 });

      let data: Awaited<ReturnType<typeof extractFn>>;
      try {
        data = await page.evaluate(extractFn);
      } catch {
        return;
      }

      // A page behind a CAPTCHA or a bot wall has no structure worth mapping,
      // and silently recording it as an empty page would make the app look
      // smaller than it is. Record what blocked us and move on.
      if (data.forms.length === 0 && data.actions.length < 3) {
        const blocker = await detectBlocker(page);
        if (blocker) {
          const landedUrl = canonical(page.url());
          if (!found.some((f) => f.url === landedUrl)) {
            found.push({
              url: landedUrl,
              title: data.title || "Blocked",
              kind: "blocked",
              forms: [],
              actions: [],
              rules: [blocker.advice],
              headings: data.headings,
              reachedVia: via,
              requiresAuth: false,
              samples: [],
            });
          }
          return;
        }
      }

      const landed = canonical(page.url());
      // A redirect to a login page means the original URL is gated.
      const redirectedToAuth = landed !== url && /login|signin/i.test(landed);

      const entry: DiscoveredPage = {
        url: landed,
        title: data.title,
        kind: classify({
          url: landed,
          forms: data.forms,
          headings: data.headings,
          actions: data.actions,
        }),
        forms: data.forms,
        actions: dedupe(data.actions),
        rules: data.rules,
        headings: data.headings,
        reachedVia: via,
        requiresAuth: redirectedToAuth,
        samples: data.samples ?? [],
      };
      if (!found.some((f) => f.url === entry.url)) found.push(entry);
      if (redirectedToAuth) {
        // record the gated URL too, so tests can target it
        if (!found.some((f) => f.url === url)) {
          found.push({
            ...entry,
            url,
            title: `${data.title} (requires login)`,
            forms: [],
            actions: [],
            samples: [],
            requiresAuth: true,
          });
        }
      }

      inventory.add(await observe(page));

      for (const href of data.links) {
        try {
          const u = new URL(href);
          if (u.origin !== origin && registrableDomain(u.hostname) !== domain)
            continue;
          if (SKIP.test(u.pathname)) continue;
          const n = canonical(u.toString());
          if (
            seen.has(n) ||
            queue.some((q) => q.url === n) ||
            queue.length >= 80
          )
            continue;
          // Breadth beats depth: a handful of product pages tells us as much
          // as fifty, and the budget is better spent finding the checkout.
          const shape = shapeOf(n);
          const used = shapes.get(shape) ?? 0;
          if (used >= MAX_PER_SHAPE) continue;
          shapes.set(shape, used + 1);
          queue.push({ url: n, via: landed });
        } catch {
          /* ignore */
        }
      }

      // Single-page apps: anchors with no real href route in JavaScript, so
      // following hrefs finds nothing at all. Click a few and see where they
      // lead. Bounded, and destructive labels were filtered out already.
      if (
        data.jsNav.length &&
        jsProbes < MAX_JS_PROBES &&
        found.length < limit
      ) {
        for (const cand of data.jsNav.slice(0, 5)) {
          if (jsProbes >= MAX_JS_PROBES) break;
          jsProbes++;
          try {
            if (canonical(page.url()) !== landed) {
              await page.goto(landed, {
                waitUntil: "domcontentloaded",
                timeout: 12_000,
              });
              await dismissOverlays(page);
            }
            const a = page.locator("a").nth(cand.i);
            if ((await a.count()) === 0) continue;
            await a.click({ timeout: 4000 });
            await settlePage(page, { quiet: 120, max: 1500, grace: 700 });
            const after = canonical(page.url());
            if (after === landed) continue;
            const u = new URL(after);
            if (u.origin !== origin && registrableDomain(u.hostname) !== domain)
              continue;
            if (SKIP.test(u.pathname)) continue;
            const shape = shapeOf(after);
            const used = shapes.get(shape) ?? 0;
            if (
              seen.has(after) ||
              queue.some((q) => q.url === after) ||
              used >= MAX_PER_SHAPE
            )
              continue;
            shapes.set(shape, used + 1);
            queue.push({
              url: after,
              via: `${landed} (clicked "${cand.text || "link"}")`,
            });
          } catch {
            /* a click that goes nowhere is fine */
          }
        }
      }
    };

    /**
     * Walk the queue with several tabs at once.
     *
     * Three pages in the SAME browser context, so the session from signing in
     * is shared through cookies. The subtlety is the exit condition: a worker
     * must not stop merely because the queue is momentarily empty, because
     * another worker may be loading a page that is about to add links to it.
     * `inFlight` is what makes the difference between "finished" and "waiting".
     */
    const walk = async (limit: number, pages: Page[]) => {
      let inFlight = 0;
      const worker = async (page: Page, index: number) => {
        for (;;) {
          if (found.length >= limit) return;
          const item = queue.shift();
          if (!item) {
            if (inFlight === 0) return;
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }
          // Claim it before the first await, so two workers cannot take the
          // same URL. No lock is needed because this is single-threaded up to
          // that point.
          if (seen.has(item.url)) continue;
          seen.add(item.url);
          inFlight++;
          try {
            await visit(page, item, index === 0, limit);
          } finally {
            inFlight--;
          }
        }
      };
      await Promise.all(pages.map((p, i) => worker(p, i)));
      // Three workers can overshoot the budget by up to two pages between the
      // check and the push; trim rather than pretend otherwise.
      if (found.length > limit) found.length = limit;
    };

    // Pass 1: the application as a signed-out visitor sees it.
    await walk(maxPages, walkPages);
    const publicUrls = new Set(found.map((p) => p.url));
    // Only if pass 1 ran out of links (rather than out of budget) can we infer
    // that anything new in pass 2 is genuinely behind the login.
    const exhaustedPublicLinks = queue.length === 0;

    // Pass 2: sign in and walk again. Links to orders, account and admin pages
    // simply do not exist until you are logged in, so without this the whole
    // authenticated half of the app is invisible.
    if (!signedIn && project.testUser && project.testPassword) {
      const loginPage =
        found.find((p) => /login|signin/i.test(p.url)) ??
        found.find((p) => p.kind === "auth");
      if (loginPage) {
        signedIn = await tryLogin(
          page,
          loginPage.url,
          project.testUser,
          project.testPassword,
        );
        if (signedIn) {
          // Keep the session. Every later test that needs to be signed in can
          // then start signed in, instead of spending its first five steps —
          // and five model calls — logging in again.
          await captureAutoSession(context, projectId).catch(() => undefined);
          seen.clear();
          shapes.clear();
          queue.length = 0;
          // Continue from wherever signing in landed us, not from the base URL
          // — on many sites the base URL *is* the sign-in page, so going back
          // there would never reach the authenticated area at all.
          queue.push({ url: canonical(page.url()), via: "after signing in" });
          const home = canonical(project.baseUrl);
          if (canonical(page.url()) !== home)
            queue.push({ url: home, via: "after signing in" });
          // The authenticated walk gets its own budget; otherwise a large
          // public site uses it all up and the signed-in half is never seen.
          await walk(
            found.length + Math.max(6, Math.round(maxPages / 2)),
            walkPages,
          );
        }
      }
    }
    // Pages found only on the second pass are candidates for "behind a login".
    // Guessing from that alone is wrong when pass 1 merely ran out of budget,
    // so confirm each one with a cookie-less request and see whether the app
    // bounces it to the sign-in page.
    if (signedIn) {
      const candidates = found.filter((p) => !publicUrls.has(p.url));
      await Promise.all(
        candidates.map(async (p) => {
          p.requiresAuth = await isGated(p.url);
        }),
      );
    }
    void exhaustedPublicLinks;
    loggedIn = signedIn;
  } finally {
    // Close the context, not the browser: it is shared with every run.
    await context?.close().catch(() => undefined);
  }

  await inventory.persist(projectId);
  for (const p of found) {
    await prisma.appPage
      .upsert({
        where: { projectId_url: { projectId, url: p.url } },
        create: {
          projectId,
          url: p.url,
          title: p.title,
          kind: p.kind,
          forms: JSON.stringify(p.forms),
          actions: JSON.stringify(p.actions),
          rules: JSON.stringify(p.rules),
          headings: JSON.stringify(p.headings),
          reachedVia: p.reachedVia,
          requiresAuth: p.requiresAuth,
          samples: JSON.stringify(p.samples ?? []),
        },
        update: {
          title: p.title,
          kind: p.kind,
          forms: JSON.stringify(p.forms),
          actions: JSON.stringify(p.actions),
          rules: JSON.stringify(p.rules),
          headings: JSON.stringify(p.headings),
          requiresAuth: p.requiresAuth,
          samples: JSON.stringify(p.samples ?? []),
          discoveredAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
  await prisma.project
    .update({ where: { id: projectId }, data: { lastExploredAt: new Date() } })
    .catch(() => undefined);

  return {
    pages: found,
    visited: found.length,
    loggedIn,
    behindLogin: found.filter((p) => p.requiresAuth).map((p) => p.url),
  };
}

/**
 * Does this URL require a login? Asked without any cookies, so the answer is
 * what an anonymous visitor would get: a redirect to sign-in, a 401/403, or a
 * page containing a password field.
 */
async function isGated(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) return true;
    if (
      /login|signin|sign-in/i.test(res.url) &&
      !/login|signin|sign-in/i.test(url)
    )
      return true;
    const body = await res.text();
    return (
      /<input[^>]+type=["']?password/i.test(body) &&
      !/login|signin|register/i.test(url)
    );
  } catch {
    return false;
  }
}

/** Known consent platforms, which cover a large share of real sites. */
const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  ".onetrust-close-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  'button[mode="primary"][aria-label*="Accept" i]',
  ".fc-cta-consent",
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '[data-testid="cookie-policy-manage-dialog-accept-button"]',
  '[aria-label="Accept all" i]',
  "#truste-consent-button",
];

const CONSENT_LABELS =
  /^(accept|accept all|accept all cookies|accept cookies|allow all|allow cookies|i agree|agree|got it|ok, got it|continue|understood|yes, i agree|save & ?exit)$/i;

/**
 * Clear a consent or cookie wall so the crawler sees the real page.
 *
 * Deliberately broad: real sites use consent platforms, render the banner
 * inside an iframe, and mark the control as a link or div rather than a
 * button. Best-effort — if it fails, the page is still mapped and the test
 * agent handles the banner itself at run time.
 */
async function dismissOverlays(page: Page, deep = true): Promise<boolean> {
  for (const sel of CONSENT_SELECTORS) {
    const el = page.locator(sel).first();
    if (
      await el
        .count()
        .then((c) => c > 0)
        .catch(() => false)
    ) {
      await el.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      return true;
    }
  }
  // The exhaustive sweep is expensive, so it runs only until a banner has been
  // dealt with once — after that the consent cookie is set and later pages do
  // not show one.
  if (!deep) return false;
  // Any clickable thing whose own label is exactly a consent phrase. Checking
  // the frames too, because many platforms isolate the banner in an iframe.
  for (const frame of page.frames().slice(0, 6)) {
    const candidates = frame.locator(
      'button, [role=button], a[href="#"], input[type=button], input[type=submit]',
    );
    const n = Math.min(await candidates.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      const text = (
        (await c.innerText().catch(() => "")) ||
        (await c.getAttribute("value").catch(() => "")) ||
        ""
      ).trim();
      if (text && CONSENT_LABELS.test(text)) {
        await c.click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(250);
        return true;
      }
    }
  }
  return false;
}

const dedupe = (xs: string[]) => [...new Set(xs)];

/** The map, rendered for a prompt. This is what the test generator reads. */
export async function appMapSummary(
  projectId: string,
  maxPages = 14,
): Promise<string> {
  const pages = await prisma.appPage.findMany({
    where: { projectId },
    orderBy: { discoveredAt: "asc" },
    take: maxPages,
  });
  if (pages.length === 0) return "";
  const out: string[] = [];
  for (const p of pages) {
    const forms = JSON.parse(p.forms) as FormDescriptor[];
    const actions = JSON.parse(p.actions) as string[];
    const rules = JSON.parse(p.rules) as string[];
    out.push(
      `PAGE ${p.url}  [${p.kind}]${p.requiresAuth ? " (requires login)" : ""}  "${p.title}"`,
    );
    for (const f of forms) {
      const fields = f.fields
        .map(
          (x) =>
            `${x.label} (${x.type}${x.required ? ", required" : ""}${x.options?.length ? `, options: ${x.options.join("/")}` : ""}${x.hint ? `, hint: "${x.hint}"` : ""})`,
        )
        .join("; ");
      out.push(
        `  FORM${f.submitLabel ? ` submitted by "${f.submitLabel}"` : ""}: ${fields || "(no fields)"}`,
      );
    }
    if (rules.length)
      out.push(
        `  RULES THE PAGE STATES: ${rules.map((r) => `"${r}"`).join(" · ")}`,
      );
    if (actions.length)
      out.push(`  ACTIONS: ${actions.slice(0, 14).join(" · ")}`);
  }
  void config;
  return out.join("\n");
}
