# V2 — Real-website capability + full product UI

Measured starting point (2026-11-11). On a synthetic page with **1,206 interactive elements**,
the v1 perception layer reported **4**. Causes, each confirmed in code:

| # | Defect | Consequence on a real site |
|---|---|---|
| 1 | `isVisible()` discards anything outside the viewport | Everything below the fold is invisible to the model |
| 2 | No `scroll` action | …and it cannot bring it into view either. Dead end. |
| 3 | `document.querySelectorAll('*')` never enters shadow roots | Web-component UIs (design systems) are unreachable |
| 4 | No `wait` / `hover` / `pressKey` / `goBack` / `extract` / `find` | SPAs, hover menus, modals, async content unusable |
| 5 | Element cap 250 / render 120, unprioritised | Large pages truncate arbitrarily |
| 6 | `<select>` options never shown | Model guesses option values |
| 7 | No popup / new-tab tracking | A `target=_blank` click strands the agent on the old page |
| 8 | No JS dialog handling | `confirm()` blocks Playwright until timeout |
| 9 | Navigation restricted to exactly `baseUrl`'s origin | Breaks on `www.`/`accounts.`/CDN/OAuth subdomains |
| 10 | `{{test_password}}` resolved **into the prompt** | The site password is sent to the LLM |
| 11 | No auth reuse | Every run must log in again; MFA/complex logins impossible |

The demo shop never exposed any of this because each of its pages fits in one 1280×800 viewport.

---

## Part A — Perception rewrite (M1)

- Collect **all CSS-visible** interactive elements, in-viewport or not; annotate each with
  `inViewport` and `above`/`below`. Playwright auto-scrolls on click, so off-screen elements
  become directly actionable.
- **Pierce open shadow roots** (recursive walk of `children` + `shadowRoot`) and keep iframe
  traversal. `data-tp-id` stamping still works because Playwright CSS selectors pierce shadow DOM.
- **Dedupe** wrapper/child pairs by `role|label|rect`.
- Richer facts per element: `options[]` for `<select>`, `checked` for checkbox/radio, `editable`,
  `disabled`, `href`.
- **Prioritised rendering**: in-viewport first, then nearest off-screen; header states how many
  exist and how many are shown, so the model knows to scroll or `find`.
- Caps raised to 600 collected / 180 rendered, with a `find` action for anything beyond.

## Part B — Action vocabulary (M2)

The slide scope lists 7 actions. That set cannot drive a real site, so it is extended. The
**assertion** vocabulary stays aligned with the slides (visibility, text, navigation) plus value.

| Group | Actions |
|---|---|
| Navigate | `navigate` `goBack` `switchTab` |
| Interact | `click` `type` `select` `hover` `pressKey` `scroll` |
| Observe | `wait` `find` `extract` |
| Assert | `assertVisible` `assertText` `assertUrl` `assertValue` |
| End | `finish` |

`find(text)` searches the full current observation (including elements not rendered in the
prompt) and returns their indices — the answer to very large pages.

## Part C — Runner robustness (M3)

- **Popups/new tabs**: track `context.on('page')`; the newest page becomes active; `switchTab`.
- **JS dialogs**: `page.on('dialog')` auto-accepts (per-project `accept`/`dismiss`) and records it.
- **Smarter settle**: `domcontentloaded` + a short network-quiet window, capped — no `networkidle` stalls.
- **Per-project viewport**, step cap and allowed domains.
- **Saved login sessions**: "Record login" opens a headed browser, the user signs in by hand
  (SSO/MFA included), and Playwright `storageState` is saved and reused by every later run.
- **Secrets never reach the model**: `{{test_password}}` stays literal in the prompt and is
  substituted by the executor at type-time. Non-secret placeholders stay resolved so the model can
  assert on them.
- Each step stores the **observation the model saw**, for the UI's debugging view.

## Part D — Validator (M2)

New per-action rules (hover/select/scroll targets, key names, wait bounds) and **domain policy**:
same registrable domain as `baseUrl`, plus the project's `allowedDomains` list.

## Part E — Complex evaluation target

`packages/demo-shop` grows into a realistically complex app, plus verification against public
test sites (saucedemo, the-internet, automationexercise).

Complexity to exercise every defect above: 120-product catalogue (scroll + pagination +
filters + sort), "Load more" lazy loading, modal dialogs, native `confirm()`, a 3-step checkout
wizard, a shadow-DOM rating/newsletter component, an iframe widget, hover mega-menu, debounced
async email-availability validation, toast notifications, `target=_blank` link, and a
login-gated admin area with a sortable/paginated data grid. Seeded bugs expanded and documented
as ground truth.

## Part F — Full product UI

Overview dashboard (KPIs, pass-rate trend, coverage donut, recent activity) · filters/search/sort
on every list · inline test editing · bulk select & run · evidence gallery with step navigation ·
"what the model saw" observation viewer · element-inventory browser · coverage history · bug
workflow · live run console · dark mode · responsive · proper empty/loading/error states.

## Schema additions

```
Project  allowedDomains(json) viewportWidth viewportHeight maxSteps storageState dialogAction
Step     observation(text)
```

---

## Outcome (2026-11-11)

**Perception**, measured on the same synthetic 1,206-element page used to find the defect:

| | v1 | v2 |
|---|---|---|
| Elements reported | **4** | **1,206** (all of them; cap is 1,500) |
| Below the fold | invisible | captured and flagged `↓ below view` |
| Shadow DOM | never traversed | traversed, resolvable by stamped id |
| Unlisted elements | unreachable | reachable via `find("label")` |

Regression tests cover all of it (`perception.complex.test.ts`), plus a second suite against the
real ShopMax app (`shopmax.perception.test.ts`) that asserts the cookie overlay is both visible to
the model *and* genuinely blocking, that the hover mega-menu only appears after `hover`, and that
the shadow-DOM widget and iframe reviews are reachable.

**End to end with live Gemini against ShopMax** — three tests, each needing a v1-missing capability:

| Test | Result | Capability exercised |
|---|---|---|
| Search is case-insensitive | FAILED → caught seeded bug #2 | dismissed the cookie overlay, `extract` |
| Checkout requires login | PASSED | overlay → cart → checkout → `assertVisible` |
| Category filter survives pagination | FAILED → caught seeded bug #3 | `select` on a real dropdown, new `assertValue` |

Suite: **53 tests passing**, both packages typecheck clean.

Still open: an evaluation harness that quantifies one-pass versus gap-filled bug yield across both
apps (the thesis experiment — the data is all in the database, a script is the next step), and
verification against the public demo sites (saucedemo, the-internet, automationexercise).

---

## V3 — three defects found by running a real user's test

A user wrote the instruction *"Test the length and type of passwords accepted"* and reported it
"not working… very buggy and slow". The run had in fact **passed**, which was worse than failing.
Reading its evidence exposed three separate defects.

### 1. Silently clicking through a blocking overlay (correctness)

The executor's click fallback was `force: true`, which skips actionability checks but still clicks
at the element's **coordinates** — landing on whatever covers it. With ShopMax's cookie overlay up,
"click Register" hit the overlay, the form never submitted, the action reported **success**, and
the agent then saw it was still on `/register` and concluded that password validation had worked.
A silent no-op that manufactures a false conclusion is the worst possible failure mode.

Now: interception is detected, `force` is never used, and the blocker is named back to the model
(`<div id="cookie"> is covering it — dismiss that overlay first`). The agent dismisses the banner
and continues. Same treatment for `type`, `select` and `hover`. Covered by `overlay.test.ts`,
which also asserts the opposite case: with the banner dismissed, a 3-character password **is**
accepted, i.e. seeded bug #5 is real.

### 2. A gameable "must assert something" gate (correctness)

`finish(pass)` required one passed assertion. The model satisfied it by asserting that a
pre-existing nav link was visible. The gate now additionally requires a **substantive** assertion:
a content check (`assertText` / `assertUrl` / `assertValue` / `assertVisible` with text), or an
`assertVisible` on an element that was **not** on the page when the run started.

The prompt was also wrong in spirit — it never said that *the application behaving smoothly is not
a pass*. It now instructs the model to judge against the application's own stated rules ("At least
8 characters", "SAVE10 = 10% off") and to treat accepting invalid input as a failure.

### 3. Vague instructions produced meaningless runs (product)

Nothing told the user their instruction had no expected outcome. There is now an instruction
linter: deterministic checks in `@testpilot/shared` run as you type (flagging "describes an area,
not a specific test", "no expected outcome", "no exact text"), the test list badges unclear
instructions, and **Improve with AI** rewrites it using the project's real UI inventory and
requirements, offering alternative scenarios to split out.

### 4. Slowness, measured rather than guessed

`perf.bench.test.ts` showed the engine was never the problem: observation **14–18 ms**, screenshot
**78 ms**, prompt **~600 tokens**. The time was elsewhere.

| Cause | Fix | Effect |
|---|---|---|
| A fixed 4 s delay before every LLM call | Adaptive pacing: no delay, back off only on a real 429, decay after success | −~50 s/run |
| Gemini 3.x reasons before answering by default (measured 3221 ms vs 1304 ms with `reasoning_effort: minimal`) | `minimal` for per-step calls only; reasoning calls keep full thinking | −~2 s/call |
| `max_tokens: 900` exhausted by thinking tokens → empty reply → extra round trip | raised to 1500 | removes a wasted call |
| 600 ms settle after every interaction | 400 ms (assertions already poll for 5 s) | −~2 s/run |

**Result on the same test: 98 s → 42 s, 13 → 9 LLM calls, and the verdict went from a false PASS
to a correct FAIL** naming the bug:

> EXPECTED: password rejected for being too short. ACTUAL: the application accepted a 3-character
> password and registered the user.

Remaining latency is free-tier Gemini variance (0.8–6 s per call), not TestPilot.

---

## V4 — removing the need to write tests at all

User feedback: *"this project was supposed to make testing easy… it is tedious to type a long test
case just to make one small test. Might as well just perform the test yourself."*

Correct, and fatal to the premise. The tool demanded a well-crafted instruction, which costs about
as much effort as doing the test by hand. The fix is an **explorer**: walk the application, build a
map of it, and write the tests from that map.

The pattern follows what the commercial tools do (Octomind, QA.tech): *agent explores → builds a
map of pages and flows → proposes test cases → human approves*, with the AI authoring and
Playwright executing deterministically.

### What the explorer captures

A flat list of element labels cannot support a judgeable test. The map records, per page:

- its **kind** (auth, listing, detail, cart, checkout, admin, form),
- every **form**, field by field, with type, required flag and options,
- the **rules the page states about itself** — both visible text ("At least 8 characters") and
  constraints declared in HTML (`minlength`, `min`, `max`, `pattern`, `type=email`),
- whether it is **behind a login**.

Those rules are the point: they are the only honest basis for an expected outcome, and they are why
a generated test can say *verify the error "Password must be at least 8 characters" is shown*
rather than *verify it works*.

### Three levels of input

| Effort | What you do |
|---|---|
| **None** | Press *Explore my app and write tests* |
| **A few words** | Type `password rules`; suggestions are derived from the mapped app, not hardcoded |
| **Full control** | Write the instruction yourself, with live review and AI rewrite |

### Generality — the part that needed the most correcting

Everything here was found by pointing the explorer at real sites rather than the demo app.

| Overfitting found | Fix |
|---|---|
| Hint text scraped by **CSS class name** (`.muted`, `.field-note` — the demo app's own classes) | `aria-describedby` first, then HTML constraints, then **short leaf text** near the field. No class names at all |
| Consent handling matched six English labels | Known consent platforms (OneTrust, Cookiebot, Quantcast, Google FC) by selector, then any control whose label is a consent phrase, searched **inside iframes** too |
| Login assumed email+password on one page | Two-step flows (Google/Microsoft/Okta style) handled: submit the identifier, wait for the password field |
| After signing in, the crawl restarted from the base URL | Continues from **where the login landed** — on SauceDemo the base URL *is* the login page, so the old behaviour never reached the app |
| `normalizeUrl` **stripped query strings** | Query kept: on many sites `?id=4` *is* the page. Added a per-URL-shape cap so a catalogue cannot eat the whole crawl budget |
| Link-following only | **SPA click probing**: anchors with no real `href` are clicked to discover where they route |
| Example tests and topic chips were e-commerce wording | Topics derived from the mapped application; static examples removed |

### Verified against real websites

| Site | Result |
|---|---|
| saucedemo.com (React SPA) | Signed in, then found `/inventory.html`, `/cart.html` and a product page **only** via click-probing — every link is `href="#"` |
| the-internet.herokuapp.com | 8 pages of a plain multi-page site, including a form inside a shadow-DOM page |
| automationexercise.com | Cleared a Google consent banner; found the login (3 forms), and a contact form with 7 fields including a file upload; extracted rules from HTML constraints |

### One-click result on ShopMax

From an empty project with nothing typed: **21 pages mapped in ~70 s**, including signing itself in
to reach `/admin` and `/orders`; rules captured such as `"At least 8 characters."` and
`"Quantity: minimum 1"` (the latter read from `min`/`max` attributes); then a set of test cases
including the under-8-character registration case — which is exactly the test the user originally
tried to write by hand.

Suite: **73 tests passing**, both packages typecheck clean.

---

## V5 — making it a product: author with AI, execute deterministically

Prompted by a request to research how comparable systems work and fix whatever stops this being a
real product. The literature settled the question.

### The finding that forced an architecture change

| Source | Finding |
|---|---|
| [An Illusion of Progress](https://www.alphaxiv.org/overview/2504.01382) | Frontier agents reach ~61% on Online-Mind2Web versus ~90% claims on WebVoyager; **real sites are far harder than benchmark clones**. A naive baseline scores 51% on WebVoyager but 22% on real sites, so the easy benchmarks reward shortcuts |
| WebArena-Verified (2026 surveys) | Top systems sit at ~60–70% |
| [Fara-1.5](https://arxiv.org/pdf/2606.20785) | Error taxonomy: selection errors, action/output contradictions, fabrication, environment blockers, grounding failures |
| Octomind (prior research) | *"The AI writes and fixes tests, but execution is deterministic Playwright"* |

A ~30% agent failure rate is tolerable for an assistant and **disqualifying for a test runner**: a
suite whose red builds are mostly agent error carries no signal. Until now TestPilot re-invoked the
model on every run, which made it a demo rather than a product.

### What was built

1. **Locator capture with verification** (`engine/locator.ts`). At the moment of each action the
   element is described (test id, ARIA role, accessible name, label, placeholder, text) and
   candidates are generated in Playwright's own preference order. Each candidate is then **tried
   against the live page** and accepted only if it resolves to that very element — so we never
   needed to reimplement the accessible-name algorithm correctly; a wrong guess simply fails.
2. **Compilation** (`engine/script.ts`). A passing run becomes a `TestScript`. It refuses to
   compile when any targeted element lacks a verified locator, when a step failed, or when the run
   contains no assertion — a script that silently acts on the wrong element is worse than no script.
3. **Replay** (`engine/replay.ts`). Executes the script with no model. Verified by a test that
   installs a provider which **throws if the model is called**.
4. **Bounded healing.** If a locator no longer resolves, one reasoning call picks the element that
   now plays the same role, the script is updated, and the run reports `n locator(s) repaired`.
   Vendor literature warns that healing can replace brittleness with non-determinism, so a heal is
   never silent, and a failing *assertion* is never healed.
5. **CI export.** `GET /api/testcases/:id/spec` emits an ordinary `.spec.ts`.

### Measured, live, against ShopMax with Gemini

```
authoring : PASSED · mode=ai     · 20.9s · 4 LLM calls
replay 1  : PASSED · mode=replay ·  3.6s · 0 LLM calls
replay 2  : PASSED · mode=replay ·  3.6s · 0 LLM calls
```

~6× faster, free after the first run, and byte-identical between runs. On free-tier quota this is
the difference between a few dozen runs a day and effectively unlimited regression runs.

### Why this also strengthens the thesis

The project claims that gap-generated tests find bugs a hand-written suite misses. That claim needs
a *controlled* measurement, and a non-deterministic runner cannot provide one: a difference in bug
yield could just be agent variance. Deterministic replay makes the comparison sound.

Suite: **84 tests passing**.

### Still open

- The evaluation harness that quantifies one-pass versus gap-filled bug yield across both apps.
- Parallel execution (runs are deliberately sequential today).
- Visual assertions, and multi-tab flows inside a compiled script.

---

## V6 — trial on a real public website

### Method

Target: **saucedemo.com** (Swag Labs). Chosen because it is a genuine React single-page app with a
real login → catalogue → cart → checkout flow, it publishes its own practice credentials, it has
**no CAPTCHA**, and it exists for automation practice. It is also the hardest case for the crawler:
every link is JavaScript-routed.

The trial was **black-box**: driven entirely through TestPilot's own HTTP API, the same path the
dashboard uses. Nothing about the target is special-cased anywhere in the codebase. Steps:

1. Create a project with only a name, base URL and the published credentials.
2. Press the one-button flow: explore, then let it write the tests. No requirements, no
   instructions, nothing typed.
3. Run the generated tests (AI authoring).
4. **Verify every verdict against independent ground truth** — a hand-written plain-Playwright
   script with no AI in it, checking the same claims directly. A tool that reports confident but
   wrong verdicts is worse than no tool, so its output cannot be taken on trust.
5. Replay each passing test twice, checking determinism and LLM cost.
6. **Probe for true positives**: point a passing test at `locked_out_user`, an account the site
   blocks by design, and check the failure is detected, attributed and reported.

### What it found on the first attempt

| | |
|---|---|
| Pages mapped | 4 — login, inventory, cart, item detail (all reached by **clicking**, since no link has a usable `href`) |
| Tests written | 4, unprompted: valid login, invalid login, add-to-cart, logout |
| AI runs | **4/4 passed**, 14–56s each |
| Ground truth | **5/5 claims verified true** against the real site — no false positives |
| Replays | **0/8 — every replay failed**, and 7 fabricated CRITICAL bugs were filed against a working site |

### Two real defects, both producing confidently wrong output

1. **Replay tagged an element and then wiped the tag.** `tagElement` sets `data-tp-id`, but the
   following `observe()` call strips every `data-tp-id` before re-stamping. The tag was gone before
   the action ran, so every replay failed on step 1 with an undefined selector. Fixed by not
   re-observing during replay (a compiled script never needs it) and tagging immediately before use.
2. **A tooling failure was reported as an application bug.** Far more serious: TestPilot could not
   drive the browser and therefore blamed the site, inventing seven critical defects. Runs now
   carry a `failureKind`: `app` (a failed assertion or a `finish(fail)` verdict) or `tool`
   (TestPilot could not act). **Only `app` failures produce a bug report**, and a `tool` failure no
   longer triggers the flaky re-run loop either.

A third, subtler flaw surfaced while probing for true positives: **compiled scripts froze literal
test data**. The model types real values during a run, so `standard_user` and the generated email
were baked into the script — tying the test to one account, and guaranteeing that a registration
test would re-use the same "unique" email on every replay. Compilation now maps those literals back
to `{{test_user}}`, `{{unique_email}}`, `{{unique_id}}` and `{{base_url}}`.

### After the fixes

```
8/8 replays passed · 0 LLM calls · 0 bug reports        (correct: the site works)
  login           5.1s / 5.1s      invalid login   6.1s / 5.1s
  add to cart     6.1s / 6.1s      full checkout  11.2s / 11.2s   (11 steps, real SPA)
```

True-positive probe, same compiled test, account switched to the blocked one:

```
replay / standard_user   : PASSED · 6.1s · 0 calls
replay / locked_out_user : FAILED · cause=app · 0 calls
    Step 4: ASSERTION FAILED: URL "https://www.saucedemo.com/" does not contain ".../inventory.html"
    BUG FILED [critical] Login fails to redirect user to inventory page with valid credentials
      expected: redirected to /inventory.html     actual: remains on / after clicking login
replay / standard_user   : PASSED · 4.9s · 0 calls
```

Correct verdicts in both directions, correct attribution, no fabricated bugs, and the compiled
script is portable across accounts.

Suite: **90 tests passing**, including regression tests for all three defects.

---

# V7 — the final product

What changed to turn a working prototype into something a person could rely on, and what was
measured. The plan and the task-level specs are in
[V7-FINAL-PRODUCT-PLAN.md](V7-FINAL-PRODUCT-PLAN.md),
[V7-IMPLEMENTATION-SPEC.md](V7-IMPLEMENTATION-SPEC.md) and
[V7-TESTING-LOGIC-SPEC.md](V7-TESTING-LOGIC-SPEC.md).

## Speed

| Change | Why it was slow | After |
|---|---|---|
| One shared Chromium, a context per run | A browser launch (~1.5 s) on every run, and a ShopMax replay is only a few seconds long | Launch paid once per server |
| Runs execute four at a time (two for AI authoring) | One run at a time, so a suite took the sum of its tests. Most of a run is a browser waiting for the network | 12 replays in **3.7 s** |
| Event-driven settling | A fixed 400 ms sleep after every click and 200 ms after everything else | A MutationObserver, armed *before* the action so a change starting 300 ms later is still seen |
| JPEG evidence, traces on failure | A PNG per step (~180 KB) and a full trace per run | ~25 KB per step; a passing replay keeps no trace, an authoring run always does |
| Up to five actions per model reply | One model call per click, so a seven-field form cost seven calls | One call for the form. The sequence stops the moment the page changes |

Measured on ShopMax with a scripted model (`npm run bench`): a single replay **0.5–1.1 s**, twelve
queued replays **3.7 s total**. Results in [benchmarks/](benchmarks).

## Correctness found by building it

Six defects the work itself exposed, each now covered by a test:

1. **`compileScript` stripped `switchTab`'s index.** Every action's `index` was dropped as an
   element reference, but for `switchTab` it names a *tab*. A recorded tab switch always replayed
   as "switch to tab 0", so a test that opened a second tab could be authored and never replayed.
2. **`TabSet` could hold the same page twice.** `context.newPage()` returns before the context
   delivers its `page` event, so the first page was added by both paths. Every later tab index was
   off by one.
3. **A whitespace regex inside a template literal deleted the letter "s".** `\s` in a template
   literal is just `s`, so `replace(/\s+/g, ' ')` in the page-text collector removed every "s" from
   the text shown to the model. A repository-wide audit for lone backslashes in page scripts is in
   the scratchpad notes; the fix is `\s`.
4. **`"unchecked".includes("checked")` is true.** Asserting a checkbox's state by substring passed
   whatever the real state was. Ticked state is now compared exactly.
5. **A suite closed on the first attempt of a retried test.** The tally ran before the retry policy,
   so a failure closed the suite and the retry's pass arrived too late to count. Only *final*
   results are tallied now, and the later attempt wins over the later timestamp.
6. **Two pages of one URL shape produced the same design key.** The key uses the URL *shape* on
   purpose, so `/products/3` and `/products/9` are one design — but de-duplication was per form, and
   the database rejected the second. Found by running the evaluation, not by a unit test.

## The testing logic

The engine was sound; what it *tested* was not systematic. The changes, in order of how much they
matter:

- **A test that finds a bug is now a test.** Only passing runs used to compile, so the most
  valuable test in a suite stayed AI-driven forever. A run that fails an assertion compiles as a
  *known failure*: replaying it answers "is the defect still there?" in seconds with no model call,
  and when it passes TestPilot says the bug looks fixed.
- **Test design is computed, not improvised.** The explorer already read `required`, `minlength`,
  `min`/`max`, `type="email"` and select options. Ordinary code turns those into boundary,
  required-field, format and equivalence tests. The same application always yields the same tests,
  each quotes its rule, and no API key is needed. The seven-character password built for an
  eight-character minimum keeps its upper-case letter, digit and symbol, so only the length
  varies — which is what finds ShopMax's bug 5, where a short password is accepted if it contains a
  digit.
- **The model can see what it did.** Each observation now carries the text that appeared or
  disappeared since the last action. Previously the model had to guess the wording of the message
  it was asked to verify, and a wrong guess became a failed assertion filed as an application bug.
- **A verdict has to be grounded.** `finish(fail)` must state expected, actual and the rule it was
  judged against, and any quoted evidence must actually be on the page. `finish(blocked)` is new:
  "I could not run this test" never files a bug.
- **Scripts are checked before they are trusted.** Every compiled script is replayed once
  immediately. If it does not reproduce, it is discarded. On the first real site tried, eight tests
  compiled and none replayed — and nobody found out until a person pressed run.
- **Coverage is arithmetic.** The link between a test and a requirement is stored once; status is
  computed from results. A requirement whose test is failing is `violated` and shown first. A second
  view — pages, forms, fields and stated rules touched — needs no requirements list at all.
- **The same defect twice is one report.** Reports are fingerprinted on the test, the failing action
  and the normalised message, so a nightly suite raises a count instead of filling the list.

## Honesty about the measurement

The seeded defects in ShopMax are now **individually switchable** (`SHOP_BUGS=1,3,5`, or `none`).
This matters more than any detection figure: "found 5 of 5" is not a result, because a tool that
reported everything as broken would score the same. `npm run evaluate` runs each arm against a shop
with all five defects *and* a shop with none, and reports both. On the correct shop the target is
zero reports.

Suite: **228 tests passing**, including regression tests for all six defects above.
