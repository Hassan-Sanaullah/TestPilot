# V7 — Implementation spec

Companion to [V7-FINAL-PRODUCT-PLAN.md](V7-FINAL-PRODUCT-PLAN.md). The plan says *what and why*;
this file says *exactly how*, task by task, so it can be implemented without re-reading the whole
codebase.

> **Implemented.** This specification was executed on 23 November 2026. Where the approach
> described here turned out to be wrong in practice, the code follows what works and the departure
> is noted in the "V7" section of [V2-HARDENING.md](V2-HARDENING.md) — the clearest example being
> the settle design, which cannot see a change that has not started yet and therefore has to be
> armed *before* the action rather than after it.

How to use it: work top to bottom. Each task lists the files to touch, the code to write, the tests
to add and the check that proves it is done. Do not start a task before the one above it is green.

---

## 0. Ground rules for whoever implements this

### 0.1 Repository facts

- Root: `Agentic web navigator/Agentic web navigator/`. npm workspaces: `packages/shared`,
  `packages/server`, `packages/web`, `packages/demo-shop`. No git repository; do not `git init`
  unless asked.
- Server runs with `tsx` (ESM, `"type": "module"`). Imports have no file extension.
- Pinned majors, do not upgrade: Prisma 6, Express 4, Zod 3, TypeScript 5, Tailwind 3, Vite 6,
  React 18, Playwright 1.50+.
- Commands: `npm run dev` (API :4000, dashboard :5173, ShopMax :4100), `npm test`,
  `npm run typecheck`, `npm run db:setup`. Tests are vitest, 95 `it(...)` cases today, some launch
  real Chromium against ShopMax with a mock LLM.
- Prisma is invoked through `packages/server/scripts/prisma.mjs` (it loads the root `.env` and
  supplies an absolute SQLite path). A schema change needs
  `npm run db:migrate -w @testpilot/server -- --name <name>` and then `npm run db:setup`.

### 0.2 Rules that were learned the hard way — do not break them

1. **Never use Playwright `force: true`.** It clicks coordinates and hits the overlay. Report the
   blocker to the model instead (`interceptingElement()` in `engine/executor.ts`).
2. **Never call `observe()` between resolving an element and acting on it.** `observe()` strips
   every `data-tp-id` first. Replay tags the element *last*, immediately before the action.
3. **`{{test_password}}` is never expanded into a prompt.** Only `applySecretPlaceholders` in the
   executor substitutes it. Logs go through `redact()`.
4. **A tool failure is never a bug report.** Anything that is not a failed assertion or a
   `finish(fail)` gets `failureKind: 'tool'`.
5. **Page functions passed to `evaluate` must be real functions**, built with
   `new Function('return (' + SRC + ')')()`. A bare string is not called with arguments in Node.
6. **Do not put a relative `DATABASE_URL` in `.env`.** `config.ts` computes the absolute default.
7. **The OpenAI key in `.env` is commented out on purpose.** Do not enable it.
8. **No ShopMax-specific logic in the engine.** No class names, no English-only labels as the only
   path, no assumptions about URL structure.
9. Shell: Bash heredocs break on apostrophes in this harness. Write files with the file tools.
10. Tests target test environments only. Never point a run at a production site.

### 0.3 Definition of done for every task

`npm run typecheck` clean, `npm test` green, new behaviour covered by a test, and no existing test
weakened to make it pass.

---

## Phase 0 — baseline

### T0.1 Confirm green

Run `npm run typecheck` and `npm test`. Record the count. If anything fails, fix that first and
note it at the top of this file.

### T0.2 Benchmark script

New file `packages/server/scripts/bench.mts`, script `"bench": "tsx scripts/bench.mts"` in
`packages/server/package.json`, and `"bench": "npm run bench -w @testpilot/server --"` at the root.

Behaviour:

1. Start ShopMax in-process. `src/test/globalSetup.ts` does **not** do this (it only migrates the
   test database); the integration tests start the shop themselves. Copy the start-up lines from
   `engine/replay.integration.test.ts` (the shop is imported from `@testpilot/demo-shop`, typed in
   `src/types/demo-shop.d.ts`).
2. Create a throwaway project pointing at it, with a throwaway SQLite file. `DATABASE_URL` must be
   set **before** anything imports `src/config.ts` or `src/db.ts`, so set it at the very top of the
   script and load the engine with dynamic `await import(...)`. Migrate the same way
   `globalSetup.ts` does: `spawnSync(process.execPath, ['scripts/prisma.mjs', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL } })`.
   Set `EVIDENCE_DIR` to a temp folder too, as `vitest.config.ts` does.
3. Author three tests with the **mock** provider (scripted replies, same style as
   `engine/replay.integration.test.ts`): a 2-step read-only test, a 7-step form test
   (registration), a 6-step cart test.
4. Replay each 5 times; record wall-clock per run and the per-step `durationMs` from the `Step` rows.
5. Queue all three × 4 = 12 replays at once; record total wall-clock (this is the suite number).
6. Print a table and write `docs/benchmarks/<yyyy-mm-dd>-<label>.json`
   (`label` from `process.argv[2]`, default `baseline`).

Force `HEADLESS=1` inside the script. Timings to capture per run, by wrapping calls with
`performance.now()` behind an exported `timings` hook rather than editing engine logic:
`launchMs`, `gotoMs`, per step `{resolveMs, actMs, settleMs, screenshotMs}`, `traceStopMs`, `totalMs`.
Add an optional `onTiming?: (name: string, ms: number) => void` field to `RunControl` and call it at
those points in `runner.ts` and `replay.ts`.

**Done when** `npm run bench baseline` writes the JSON. Commit that file; every later claim is
measured against it.

---

## Phase 1 — replay and suite latency

### T1.1 Shared browser pool

New file `packages/server/src/engine/browserPool.ts`:

```ts
import { type Browser, chromium } from 'playwright'
import { config } from '../config'

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

/** One Chromium for the whole server; every run gets its own isolated context. */
export async function sharedBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  if (!launching) {
    launching = chromium.launch({ headless: config.headless }).then((b) => {
      browser = b
      launching = null
      b.on('disconnected', () => { if (browser === b) browser = null })
      return b
    }, (e) => { launching = null; throw e })
  }
  return launching
}

export async function closeSharedBrowser(): Promise<void> {
  const b = browser
  browser = null
  await b?.close().catch(() => undefined)
}
```

Changes:

- `engine/runner.ts` and `engine/replay.ts`: replace `chromium.launch(...)` with
  `await sharedBrowser()`. Replace `await browser?.close()` in `finally` with
  `await context?.close().catch(() => undefined)` (after `tracing.stop`).
- `RunControl`: replace `browser?: Browser` with `context?: BrowserContext`. Set it right after
  `newContext`. `runService.cancelRun` calls `c.context?.close()`.
- `src/index.ts`: on `SIGINT`/`SIGTERM` call `closeSharedBrowser()` then exit.
- `services/authCapture.ts` keeps launching its own headed browser. Do not route it through the pool.
- Tests that call `executeRun` / `replayRun` directly keep working; add
  `afterAll(closeSharedBrowser)` to the integration test files so vitest exits.

Headless per run: a context cannot choose headless; the browser decides. Keep one pool keyed by
`config.headless` for now. T1.2 adds a second, always-headless pool for suite runs:
`sharedBrowser(headless = config.headless)` with a `Map<boolean, Browser>`.

Test (`engine/browserPool.test.ts`): two calls return the same instance; after `close()` a new call
launches a fresh one; two contexts from it do not share cookies.

### T1.2 Parallel run service

Rewrite the scheduling part of `services/runService.ts`. Keep `startRun`, `cancelRun`, `isActive`,
`afterRun` signatures.

```ts
interface Queued { runId: string; projectId: string; mode: 'ai' | 'replay'; serial: boolean }

const queue: Queued[] = []
const running = new Map<string, Queued>()          // runId -> entry

const limits = { total: config.runConcurrency, ai: config.aiConcurrency }

function canStart(q: Queued): boolean {
  if (running.size >= limits.total) return false
  const ai = [...running.values()].filter((r) => r.mode === 'ai').length
  if (q.mode === 'ai' && ai >= limits.ai) return false
  const sameProject = [...running.values()].filter((r) => r.projectId === q.projectId)
  // A reset hook wipes shared data, so such a project runs one test at a time.
  if (sameProject.length && (q.serial || sameProject.some((r) => r.serial))) return false
  return true
}

function pump(): void {
  for (let i = 0; i < queue.length; ) {
    const q = queue[i]
    if (canStart(q)) { queue.splice(i, 1); void launch(q) } else i++
  }
}
```

- `launch(q)` puts the entry in `running`, awaits `replayRun`/`executeRun`, then `afterRun`, and in
  `finally` deletes it and calls `pump()`.
- `serial = Boolean(project.resetUrl)`. Also treat a project as serial when its new setting
  `parallel` is false (T1.2b).
- `config.ts`: `runConcurrency: int('RUN_CONCURRENCY', 4)`, `aiConcurrency: int('AI_CONCURRENCY', 2)`.
  Clamp both to 1–8. Document in `.env.example`.
- Scan order is FIFO with skipping, so a blocked serial project does not stall other projects.
- The reset hook currently fires inside each run. Leave it there; serial projects make that safe.

T1.2b schema: `Project.parallel Boolean @default(true)`. Expose in `ProjectBody`, `toDto`, and the
Settings tab ("Run tests in parallel — turn off if tests share data"). Migration name
`project_parallel`.

Headed windows: when more than one run is active, four visible windows are noise. Rule: a run
started as part of a suite (T3.1 `batchId` present) uses the headless pool; a single run uses
`config.headless`. Until T3.1 exists, pass `headless` through `startRun` options from `run-all`.

Tests (`services/runService.test.ts`, mock the two run functions with `vi.mock`):

- 6 replays for a parallel project: at most 4 run at once, all finish.
- 3 AI runs: at most 2 at once.
- A project with `resetUrl`: never more than 1 at once, while another project runs alongside.
- `cancelRun` on a queued run removes it and marks it cancelled.

### T1.3 Event-driven settle

Replace `Executor.settle()` and the fixed sleeps in `hover` (400 ms) and `scroll` (500 ms).

New file `packages/server/src/engine/settle.ts`:

```ts
import type { Page } from 'playwright'

const QUIET_JS = `
(opts) => new Promise((resolve) => {
  const start = performance.now();
  let last = start;
  const obs = new MutationObserver(() => { last = performance.now(); });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const tick = () => {
    const now = performance.now();
    if (now - last >= opts.quiet || now - start >= opts.max) { obs.disconnect(); resolve(Math.round(now - start)); }
    else setTimeout(tick, 25);
  };
  setTimeout(tick, opts.quiet);
})`
const quietFn = new Function('return (' + QUIET_JS + ')')() as (o: { quiet: number; max: number }) => Promise<number>

/** Wait until the DOM has been still for `quiet` ms, or `max` ms have passed. */
export async function settlePage(page: Page, opts: { quiet?: number; max?: number } = {}): Promise<void> {
  const quiet = opts.quiet ?? 120
  const max = opts.max ?? 1500
  try {
    if (page.isClosed()) return
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => undefined)
    await page.evaluate(quietFn, { quiet, max })
  } catch {
    // Navigation destroyed the context mid-wait: wait for the new document, then one more quiet window.
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 })
      await page.evaluate(quietFn, { quiet, max: 800 })
    } catch { /* closed or still navigating — the next step's own waits take over */ }
  }
}
```

Executor: `settle(action)` becomes

- `finish`, `find`, `extract`, `assert*`: no settle at all (assertions poll for 5 s themselves).
- `click`, `type` with `submit`, `navigate`, `goBack`, `select`, `pressKey`, `upload`:
  `settlePage(page, { quiet: 120, max: 1500 })`.
- `type` without submit, `hover`, `scroll`: `settlePage(page, { quiet: 80, max: 600 })`.

Known trap: a page with a CSS animation driven by attribute changes or a ticking clock never goes
quiet; the `max` cap bounds that. Do not raise `max` above 1500.

Tests (`engine/settle.test.ts`, real Chromium, `page.setContent`):

- Static page resolves in under 300 ms.
- A page that appends a node 300 ms after a click: after `settlePage` the node exists.
- A page mutating every 20 ms forever: resolves near `max`, does not hang.
- A click that navigates: resolves, and `page.url()` is the new URL.

Then run the whole existing suite; the integration tests are the real proof nothing regressed.

### T1.4 Cheaper evidence

`engine/evidence.ts`:

- `screenshot()` writes `step-NNN.jpg` with `type: 'jpeg', quality: 70`. Keep the method name.
  `scale: 'css'` to avoid device-pixel upscaling.
- The web app builds URLs from the stored relative path, so no client change is needed.

Trace mode: `config.traceMode = 'always' | 'on-failure' | 'off'` from `TRACE` (default
`on-failure`). In both runners:

- `off`: never call `tracing.start`.
- `on-failure`: start as today; in `finally`, if the outcome is `passed`, call
  `tracing.stop()` with no path (discards), else save.
- `always`: today's behaviour.
- AI authoring runs always behave as `always` unless `off`.

Benchmark before deciding whether `on-failure` should also drop `snapshots: true` on replays. If
the bench shows tracing costs more than 15% of replay time, record replays with
`{ screenshots: false, snapshots: true }`.

### T1.5 Replay correctness and speed

File `engine/replay.ts` and `engine/locator.ts`.

1. **Wait for the element.** New `resolveRefWaiting(page, ref, timeoutMs = 5000)` in `locator.ts`:
   loop `resolveRef` every 150 ms until it returns a locator or time runs out. Use it in replay.
   Only when it returns null does healing start.
2. **Cheap heal before the model.** Before `heal()`, try the other candidate kinds derived from
   `ref.description` is not reliable; instead store *all* verified candidates at capture time.
   Change `ElementRef` in `packages/shared/src/script.ts` to add
   `alternates?: { candidate: LocatorCandidate; nth?: number }[]`. In `captureRef`, keep collecting
   after the first match (cap 3 alternates). In replay, try `candidate`, then each alternate, and
   only then the model. A script without `alternates` (older) still works. Count a step resolved by
   an alternate as healed, and rewrite the script's primary on a pass, as today.
3. **Tabs.** Extract `TabSet` from `runner.ts` into `engine/tabs.ts` and use it in replay exactly as
   the runner does: attach the dialog handler to new pages, `prune()` each step,
   `executor.setPage(tabs.current)`. Handle `switchTab` in replay the way the runner does
   (set `tabs.active`, do not send it to the executor). Resolve refs on `tabs.current`.
4. **Skip the duplicate first navigation.** If step 1 is `navigate` and
   `new URL(url, base).href` equals the current `page.url()` (compare with trailing slash and hash
   stripped), record the step as ok with duration 0 and do not load the page again.
5. **Dialogs.** Replay currently does not log dialogs; reuse the runner's handler so the step
   timeline shows them.
6. **`.spec.ts` export** (`engine/script.ts`): emit tab handling for `switchTab`
   (`const pages = page.context().pages(); page = pages[n]` needs `let page`; wrap by declaring
   `let p = page` at the top of the test and using `p` throughout).

Tests: extend `replay.integration.test.ts`:

- New tab: ShopMax already has one. The footer link "Help centre (opens in a new tab)"
  (`packages/demo-shop/src/views.js` line 176, `target="_blank"`, route `/help`). Author with the
  mock: click it, `switchTab 1`, assert text on the help page; then replay.
- Late element: ShopMax has nothing slower than the 350 ms debounced `/api/check-email`. Add a
  route `GET /slow` to `packages/demo-shop/src/app.js` whose page inserts a button
  "Late button" with a script after 1500 ms, and document it in the demo-shop README as a test
  fixture, not a feature. Replaying a click on it must succeed with **zero** LLM calls. Use the
  provider-that-throws pattern already in `replay.regression.test.ts`.
- Renaming a `data-testid` so the primary fails and an alternate matches: passes, `healedSteps` 1,
  zero LLM calls.

### T1.6 Re-benchmark

`npm run bench phase1`. Targets: single ShopMax replay under 2 s, 12 queued replays at least 3×
faster than baseline. If a target is missed, find out why from the per-phase timings before moving on.

---

## Phase 2 — authoring speed and missing capabilities

### T2.1 Action batching

The idea is the one browser-use ships as `multi_act`: the model may return several actions, and the
sequence is interrupted as soon as the page changes.

**Schema** (`packages/shared/src/actions.ts`):

```ts
export const MAX_BATCH = 5
export const ProposalSchema = z.object({
  thought: z.string().default(''),
  action: ActionSchema.optional(),
  actions: z.array(ActionSchema).min(1).max(MAX_BATCH).optional(),
}).refine((p) => p.action || p.actions, { message: 'provide "action" or "actions"' })
export const proposalActions = (p: Proposal): Action[] => p.actions ?? (p.action ? [p.action] : [])
```

**Validator** (`engine/validator.ts`): add
`validateBatch(raw, obs, ctx): { ok: true; actions: Action[]; thought } | { ok: false; reason }`.

- Parse with the new schema, then run the existing per-action checks on each action in order.
  Refactor the body of `validateProposal` into `validateAction(action, obs, ctx)` and call it in a
  loop; keep `validateProposal` as a thin wrapper so its 20-odd tests still pass unchanged.
- Batch-only rules:
  - `finish` may only be the last action, and a batch containing `finish(pass)` is checked against
    the assertion counters *as they will be* after the batch's own assertions. Simplest correct
    rule: **reject `finish` inside a batch of more than one action.** Say so in the reason.
  - `navigate`, `goBack`, `switchTab`, `find`, `extract`, `wait` end a batch: anything after them is
    truncated silently (not rejected), because the model must see the result first.
  - If any action fails validation, truncate the batch to the valid prefix when the prefix is
    non-empty; reject only when the first action is invalid.

**Fingerprint** (`engine/perception.ts`): a cheap page-side function that does not touch
`data-tp-id`:

```ts
const FINGERPRINT_JS = `() => {
  const q = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open]';
  let n = 0, tagged = 0;
  for (const el of document.querySelectorAll(q)) { n++; if (el.hasAttribute('data-tp-id')) tagged++; }
  return location.href + '|' + n + '|' + tagged + '|' + document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]').length;
}`
export async function pageFingerprint(page: Page): Promise<string>
```

**Runner** (`engine/runner.ts`), inside the step loop after validation:

```
const batch = validated.actions
const tabsAtObserve = tabs.pages.length
// The state the model saw. Taken once, before anything in the batch runs.
const seen = await pageFingerprint(activePage).catch(() => '')

for (let b = 0; b < batch.length; b++) {
  if (b > 0) {
    // The model has not seen the page as it is now. Continue only if nothing moved.
    const now = await pageFingerprint(tabs.current).catch(() => 'changed')
    if (now !== seen || tabs.pages.length !== tabsAtObserve) {
      note = `stopped after ${b} of ${batch.length} actions: the page changed`
      break
    }
  }
  ... existing execute / save step / counters, with `index` taken from a run-level stepIndex++ ...
  if (!result.ok) break            // never continue a batch after a failure
}
```

Details that matter:

- The comparison is always against `seen`, the fingerprint of the observed page. Typing into a
  field leaves it unchanged, so the next field is filled without a model call. A click that submits,
  navigates or opens a dialog changes it, so everything after that click is dropped and the model
  is shown the new page. An assertion inside a batch therefore only ever runs on the page the model
  actually saw.
- The fingerprint check runs after the previous action has settled (T1.3), not immediately.
- The step counter becomes a run-level variable; the `for` loop over `maxSteps` counts *executed
  actions*, not model turns. `llmCallBudget` still counts calls.
- `gen.addResult` receives one combined message:
  `RESULTS:\n1. typed ... ok\n2. typed ... ok\n3. clicked ... ok\n(batch stopped: page changed)`.
- Only the first step of a batch stores the `observation` text and the `thought`; later ones store
  `observation: ''` and `thought: '(same plan)'` to keep the database small.
- Each action still gets its own `executor.lastRef`, so compilation is untouched.
- Emit a `run.log` line: `plan of N actions, executed M`.

**Prompt** (`ai/prompts.ts`, `GENERATOR_SYSTEM`): change the LOOP paragraph and add a rule.

```
LOOP: each turn you receive an observation ... You reply with exactly ONE JSON object:
{"thought": "...", "actions": [ {...}, {...} ]}
Give 1 to 5 actions. Use several ONLY when each one acts on an element in the CURRENT observation
and does not depend on the result of the one before — typically filling the fields of one form and
pressing its button. The system stops the sequence the moment the page changes and shows you the new
page, so anything that should happen on the next page belongs in your next reply. Never put an
assertion or finish after an action that changes the page. {"action": {...}} is also accepted.
```

Keep every numbered rule. Add to rule 10: "Fill all the fields of a form in one reply."

**Generator** (`ai/generator.ts`): `trim(keep = 2)`.

Tests:

- `validator.test.ts`: batch of 3 valid; batch with invalid second action truncates to 1; `finish`
  inside a batch of 2 is rejected; `navigate` truncates what follows.
- `runner.integration.test.ts` with the mock provider on ShopMax registration: one reply with
  `[type, type, type, type, click]` produces 5 steps, 1 LLM call, and the run compiles and replays.
- A batch `[click (opens a modal), click (element behind it)]`: second action is not executed and
  the model is asked again.
- Old single-`action` replies still work (existing tests, untouched).

### T2.2 Skip the model for nothing

In `runner.ts`, the run already opens `project.baseUrl`. No change needed there. But add a guard:
if the model's first action is `navigate` to the URL that is already open, record it as ok without
reloading (same comparison helper as T1.5.4; put the helper in `engine/urls.ts`).

### T2.3 `upload` action

Five places, all in one change:

1. `shared/actions.ts`: add `'upload'` to `SUPPORTED_ACTIONS` (interact group),
   `UploadAction = z.object({ type: z.literal('upload'), index, file: z.enum(['image', 'pdf', 'text', 'csv']).default('image'), name: z.string().max(80).optional() })`,
   add to the union, to `ACTION_DOCS`
   (`{"type":"upload","index":<n>,"file":"image"|"pdf"|"text"|"csv"}  // attach a small sample file to a file input`),
   `ACTION_SUMMARY`, `describeAction`.
2. `validator.ts`: element must exist and have role `file`. Reason otherwise:
   "element [n] is not a file input". Also reject `click` on a role `file` element with
   "use upload for file inputs".
3. `executor.ts`: `loc.setInputFiles({ name, mimeType, buffer })`. Sample files are generated in
   memory in a new `engine/sampleFiles.ts`: a valid 1×1 PNG (hard-coded base64), a minimal valid
   PDF, `sample.txt`, a 3-row CSV. No files on disk.
4. `script.ts`: compile passes it through; `.spec.ts` export emits
   `await el.setInputFiles({ name, mimeType, buffer: Buffer.from('<base64>', 'base64') })`.
5. `replay.ts`: nothing special; it goes through the executor.

Perception already lists `<input type="file">` with role `file`; confirm it is not filtered out
when visually hidden behind a styled button (common). If hidden, perception skips it. Fix: in
`COLLECT_JS`, do not apply `isHidden`/size filters to `input[type=file]`; label it from its
associated `<label>` text.

Tests: the-internet-style page via `page.setContent` in a unit test, plus an `/upload` route in
demo-shop echoing the file name; author with mock, replay.

### T2.4 Checked-state assertion

`assertValue` on a checkbox or radio compares against `checked`/`unchecked`. In the executor's
`assertValue`, when `loc.isChecked()` succeeds use `'checked' | 'unchecked'` as the actual value.
Mention it in `ACTION_DOCS`. Export as `toBeChecked()` / `not.toBeChecked()`.

### T2.5 Failing honestly on undrivable pages

New `engine/blockers.ts`: `detectBlocker(page): Promise<null | { kind: 'captcha' | 'bot-wall' | 'empty'; detail: string }>`

- `captcha`: an iframe whose `src` matches
  `/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i`, or an
  element matching `.g-recaptcha, .h-captcha, [data-sitekey]`.
- `bot-wall`: document title or the first 500 characters of body text matching
  `/just a moment|attention required|access denied|verify you are human|are you a robot|unusual traffic/i`
  **and** fewer than 5 interactive elements.
- `empty`: zero interactive elements after one extra `settlePage` and a 2 s wait.

Call it in the runner when an observation has fewer than 3 elements, and in the explorer on every
page. Result: `RunError('blocked', ...)` → `status: 'error'`, `failureKind: 'tool'`, reason in plain
words, for example "This page shows a CAPTCHA. Automated browsers cannot pass it. Use a test
environment with CAPTCHA disabled, or record a login session in Settings." The explorer records the
page with `kind: 'blocked'` and continues.

Tests: three `setContent` pages, one per kind; a normal sparse page is not flagged.

### T2.6 Explorer in parallel

`engine/explorer.ts`, function `exploreApp` (lines 311–505). How it works today, verified:

- It launches its own headless Chromium, one context, **one page**.
- `walk(limit)` is a closure over `page`, `queue`, `seen`, `shapes`, `found`, `jsProbes`,
  `consentHandled`. Each iteration: `queue.shift()`, `seen.add`, `page.goto`, `dismissOverlays`,
  a fixed 250 ms wait, `page.evaluate(extractFn)`, push to `found`, `observe` for the inventory,
  enqueue links (per-shape cap `MAX_PER_SHAPE = 3`, queue cap 80), then JS click-probing of up to
  5 `jsNav` anchors (700 ms wait after each click, `MAX_JS_PROBES = 20` overall).
- Pass 1 `walk(maxPages)` signed out; then `tryLogin(page, ...)`; then `seen`, `shapes`, `queue` are
  cleared and pass 2 runs `walk(found.length + max(6, maxPages / 2))`; then `isGated` checks run in
  parallel already.

Change:

- `walk(limit)` becomes `walk(limit, pages: Page[])` and runs one worker per page with
  `Promise.all`. Create 3 pages in the **same context**, so the session from `tryLogin` (done on
  `pages[0]`) is shared by all of them through cookies.
- Turn the loop body into `visit(page, item, allowProbe)`. Only worker 0 gets `allowProbe = true`:
  click-probing navigates the page away and back and must not race another worker.
- A worker must not exit just because the queue is momentarily empty while another worker is still
  loading a page that will add links. Keep an `inFlight` counter: increment after `shift()`,
  decrement in `finally`. Loop condition: `found.length < limit && (queue.length || inFlight > 0)`;
  when the queue is empty but `inFlight > 0`, `await sleep(50)` and re-check.
- `seen.has / seen.add` and the shape counter are updated synchronously, before the first `await`
  of an iteration, so no lock is needed.
- The budget check `found.length < limit` can overshoot by up to 2 pages with 3 workers. Accept it,
  or trim `found` to `limit` after the walk, keeping insertion order.
- Replace the fixed 250 ms and 700 ms waits with `settlePage` from T1.3.
- Take the browser from the pool with `sharedBrowser(true)` and close the **context**, not the
  browser, in `finally`.

Test: existing `explorer.test.ts` must pass unchanged; add an assertion that the same set of URLs
is found as before on ShopMax.

### T2.7 Re-benchmark and one live check

`npm run bench phase2`. Then, with the real Gemini key, author the ShopMax registration test once
and record calls and seconds. Target: 2 calls or fewer for the form itself, under 12 s.

---

## Phase 3 — product completeness

### T3.1 Suite runs

Schema:

```prisma
model SuiteRun {
  id         String    @id @default(cuid())
  projectId  String
  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  status     String    @default("running")   // running | passed | failed | cancelled
  total      Int       @default(0)
  passed     Int       @default(0)
  failed     Int       @default(0)
  errored    Int       @default(0)
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  runs       Run[]
}
```

`Run.suiteRunId String?` with relation, `Project.suiteRuns SuiteRun[]`. Migration `suite_runs`.

Service `services/suiteService.ts`:

- `startSuite(projectId, { testCaseIds?, mode? })`: create the row, `startRun` each test with
  `{ suiteRunId, headless: true }`, set `total`.
- In `runService.afterRun`, when the run has a `suiteRunId` and is final (not about to be retried),
  increment the counter; when `passed + failed + errored === total`, set status and `finishedAt`,
  publish `{ type: 'suite.done', suiteRunId }` on the event bus (add to `RunEvent` union and to the
  global SSE filter in `routes/runs.ts`).
- A retried run (attempt 2) replaces attempt 1 in the tally: count only the last attempt per test.

Routes: `POST /projects/:id/suite-runs` (replaces the body of `run-all`; keep `run-all` as an alias),
`GET /projects/:id/suite-runs`, `GET /suite-runs/:id` (with its runs), `POST /suite-runs/:id/cancel`.

### T3.2 Bug de-duplication

Schema: `BugReport.testCaseId String?`, `fingerprint String?`, `occurrences Int @default(1)`,
`lastSeenAt DateTime @default(now())`, `lastRunId String?`. Migration `bug_dedupe`.

`ai/bugs.ts` `fileBugReport`:

1. Find the failing step (already computed as `failing`).
2. `fingerprint = sha1(testCaseId + '|' + normalise(failing.action) + '|' + normalise(failing.error))`
   where `normalise` lower-cases, strips digits that look like ids/timestamps
   (`/\d{4,}/g → '#'`) and the unique-data placeholders' resolved values.
3. If an **open** bug with the same `fingerprint` exists: update `occurrences += 1`,
   `lastSeenAt`, `lastRunId`, `screenshotPath`; return it. **No LLM call.**
4. Otherwise create as today, storing `testCaseId` and `fingerprint`.

Also in `runService.afterRun`: when a test passes and it has open bugs, do not close them
automatically; set a flag `BugReport.passingSince DateTime?` so the UI can offer "This test passes
now — close?".

Tests: two failing replays of the same test → one bug, `occurrences` 2, one reasoning call.
A different failing step → a second bug.

### T3.3 CI entry point

`packages/server/scripts/suite.mts`, script `suite`. Arguments: project name or id,
`--base-url <url>` (overrides the stored one for this invocation), `--json <file>`.
Runs every test that has a compiled script, headless, through `startSuite`, waits, prints a table,
exits 1 if any failed, 2 if any errored. Tests with no script are listed as "not authored" and do
not fail the build.

`GET /projects/:id/spec`: one `.spec.ts` with a `test.describe(projectName)` and one `test()` per
compiled case. Refactor `toPlaywrightSpec` into `specBody(script)` + wrappers.

### T3.4 Cost per run

`packages/shared/src/pricing.ts`: a table `{ match: RegExp; inPerM: number; outPerM: number }[]`
taken from `docs/LLM-PROVIDERS.md` section 4, and `estimateCost(model, promptTokens, completionTokens)`.
Free-tier profile returns 0 with `free: true`. `Run` gains `model String?` set from the last
`CompleteResult.model`. Show "≈ $0.004" on the run page and a total on the overview. State next to
it that prices are indicative.

### T3.5 Housekeeping

- `config.ts`: OpenAI default model `gpt-5-mini`; same in `.env.example`.
- Evidence retention: `EVIDENCE_KEEP_DAYS` (default 30); on server start delete run folders older
  than that whose run is not linked to an open bug.
- README: test count, the new actions, parallelism, suite runs, the bench results.

---

## Phase 4 — the approved interface

Reference files, copied into the repo so they survive: `docs/design/mockups/*.dc.html`
(Overview, Run detail, Test cases, tokens; dark and light). They are static HTML with inline
styles; read them for exact values. They are the source of truth for look, not for data.

### T4.1 Tokens

`packages/web/tailwind.config.js`:

```js
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] },
      colors: {
        accent: { DEFAULT: '#5C5FC8', soft: '#A9ACF0', ink: '#4B4EB5' },
        data: { blue: '#1C9ED9', pink: '#E35C9A', amber: '#D97706', green: '#0E9C63' },
        bad: { DEFAULT: '#D1476A', soft: '#F0A2B6', ink: '#A82850' },
        page: 'rgb(var(--page) / <alpha-value>)',
        side: 'rgb(var(--side) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        raise: 'rgb(var(--raise) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        ink2: 'rgb(var(--ink2) / <alpha-value>)',
      },
      borderRadius: { card: '24px', inner: '18px', ctl: '16px' },
    },
  },
}
```

`packages/web/src/index.css` (replace the current component layer):

```css
:root {            /* light */
  --page: 238 240 246; --side: 255 255 255; --card: 255 255 255; --raise: 243 245 250;
  --line: 226 230 239; --ink: 23 26 33; --ink2: 91 99 119;
  --card-grad: linear-gradient(145deg, #FFFFFF 0%, #FCFDFF 46%, #F2F5FB 100%);
  --raise-grad: linear-gradient(145deg, #FAFBFE 0%, #F3F5FA 52%, #EBEEF6 100%);
  --card-shadow: inset 1.5px 1.5px 0 rgba(255,255,255,.95), 0 14px 34px rgba(23,26,33,.09);
  --glass: rgba(255,255,255,.6); --glass-line: rgba(255,255,255,.95);
}
html.dark {
  --page: 34 38 51; --side: 28 32 41; --card: 42 47 62; --raise: 51 56 72;
  --line: 69 75 94; --ink: 242 244 248; --ink2: 167 174 192;
  --card-grad: linear-gradient(145deg, #363D51 0%, #2A2F3E 48%, #232734 100%);
  --raise-grad: linear-gradient(145deg, #3F4658 0%, #333848 55%, #2D3140 100%);
  --card-shadow: inset 1.5px 1.5px 0 rgba(255,255,255,.09), 0 18px 42px rgba(8,10,16,.40);
  --glass: rgba(58,65,86,.5); --glass-line: rgba(255,255,255,.09);
}
```

Component classes (same names as today so pages keep compiling, new look):
`.card` (`background: var(--card-grad); box-shadow: var(--card-shadow); border-radius: 24px; padding: 22px 24px`),
`.card-raise`, `.glass` (`background: var(--glass); backdrop-filter: blur(18px); border: 1px solid var(--glass-line)`),
`.btn` (min-height 44px, radius 16px, weight 600), `.btn-primary` (accent, white text),
`.btn-contrast` (white on dark, ink on light), `.btn-secondary` (raise gradient), `.btn-ghost`,
`.btn-danger` (bad soft outline), `.pill` (radius 999px, 8px 16px), `.input` (raise background, radius 16px,
min-height 48px, no border, focus ring accent), `.label`, `.badge`, `.table`, `.orb`
(`position:absolute; border-radius:50%; filter: blur(36px); pointer-events:none`).

Load Inter (400–800) and JetBrains Mono (400, 500) from Google Fonts in `packages/web/index.html`.

Contrast rules that were verified during design and must be kept:

- White text on `#5C5FC8` is 5.68:1. Do not lighten the accent.
- `--ink2` on `--card` passes 4.5:1 in both themes. Do not use a dimmer grey for small labels.
- Data colours are for marks (dots, bars, rings). Text beside them stays `ink` / `ink2`.
- Every status shows a shape or icon and a word, never colour alone.
- No emoji as icons. Inline stroke SVG, `aria-hidden="true"`, with `aria-label` on icon-only buttons.

### T4.2 Shell

`App.tsx`: replace the top bar with a two-column shell.

- Left, 252 px, `bg-side`, gradient as in the mock-up: logo (blue square, pink circle, amber
  triangle, "TestPilot"), project switcher, navigation, and at the bottom the "Explore my app" card.
- Inside a project, navigation items are the tabs that today live in `ProjectPage.tsx` as a
  horizontal strip. The tab is already in the URL as a query parameter, `/projects/:id?tab=<key>`,
  with keys `overview`, `requirements`, `tests`, `runs`, `coverage`, `gaps`, `bugs`, `inventory`
  (labelled "App map"), `settings`. **Keep that scheme**: `RunPage.tsx` and others already link to
  `?tab=runs`. The sidebar reads `useSearchParams` and writes the same parameter; delete the
  horizontal strip from `ProjectPage.tsx`. Because the sidebar lives in `App.tsx` and the project
  lives in `ProjectPage.tsx`, lift the "current project" into a small React context
  (`ProjectNavContext`: `{ project, tab, go }`) that `ProjectPage` provides and the shell consumes.
- Tab components keep their props exactly: `OverviewTab({ project, tick, onGo })`,
  `TestCasesTab({ project, onChange })`, `RunsTab({ project, tick })`, `CoverageTab({ project })`,
  `GapsTab({ project, onChange })`, `BugsTab({ project, tick })`, `AppMapTab({ project })`,
  `RequirementsTab({ project, onChange })`, `SettingsTab({ project, onChange })`.
- Outside a project: Projects, AI settings.
- Active item: filled accent pill, white text, radius 16px.
- Theme toggle and the frosted search field sit in the page header. `useDarkMode` already exists in
  `components/ui.tsx`; default to the system preference when nothing is stored.
- Below 900 px the sidebar collapses to a top bar with a menu button.

### T4.3 Components (`components/ui.tsx`, `components/charts.tsx`)

Keep every existing export and its props so pages compile; restyle the internals. Add:

- `Card`, `Pill`, `IconButton`, `Toggle`, `Tabs` (pill tabs), `CircleBadge({ value, color })`.
- `StatusBadge` replaces the colour logic in `Badge`: passed → green dot + "Passed"; failed → bad;
  error → amber + "Tool failure" when `failureKind === 'tool'`; running → accent with a pulse;
  queued → grey.
- Charts, hand-written SVG, no chart library:
  - `LineChart({ points, highlightIndex })`: smooth path (Catmull-Rom to Bézier), 2.4 px stroke,
    `vector-effect: non-scaling-stroke`, white on dark and accent on light, amber marker, a glass
    tooltip that follows the pointer (crosshair + nearest point), date pills underneath.
  - `Donut({ segments, centre })`: 20 px ring, rounded caps, 2 px gaps, big number in the centre,
    legend rows with a dot, label and right-aligned value. Hover a segment to highlight its row.
  - Keep `TrendBars` and `MiniBar` for the pages that use them, restyled with the data colours.

### T4.4 Screens

Order and the mock-up to follow:

1. **Overview** (`pages/tabs/OverviewTab.tsx`) ← `Main.dc.html`. Three columns: main, right rail.
   Greeting with the project name; hero card "Replay the whole suite" wired to T3.1 with the
   compiled count; "Coverage by area" from the app map kinds joined with coverage items; two mode
   cards (deterministic count and median replay time, AI count and median authoring time — add
   medians to `services/stats.ts`); runs line chart from `stats.trend`; requirements donut from
   `stats.coverage`. Every number comes from the API. If a figure has no data, show an empty state,
   never a placeholder number.
2. **Test cases** (`TestCasesTab.tsx`, `components/QuickTest.tsx`) ← `TestCases.dc.html`.
   The one-prompt hero, example chips from `map.topics`, draft cards with kind icon and "Add and
   run", the suite list with a circular result badge, state pill, time and Replay / Author button.
   Keep search, multi-select, bulk run, inline edit, lint hints.
3. **Run detail** (`pages/RunPage.tsx`) ← `RunDetail.dc.html`. Header with status pill and chips
   (mode, LLM calls, duration, viewport, cause); timeline filmstrip built from step screenshots with
   a marker on the failing step; steps spine on the left; viewer on the right. **Selecting a step
   drives every panel**: screenshot, error, log, "What the AI saw" (the stored observation),
   locator (the stored `ElementRef`). Arrow keys move the selection. Live runs append steps over the
   existing SSE stream and follow the newest step unless the user has selected one.
4. Runs, Coverage, Missing tests, Bug reports (+ occurrences and "passes now — close?" from T3.2),
   App map, Requirements, project Settings (+ parallel toggle, trace mode), AI settings, Projects
   list, Bug page.

After each screen: `npm run typecheck -w @testpilot/web`, open it in both themes at 1440 px and
390 px, click every control on it.

### T4.5 Data wiring — where every number on the mock-ups comes from

The mock-ups contain sample figures. None of them may be hard-coded. Existing sources:

| Mock-up element | Source today | Gap to close |
|---|---|---|
| "Hello, ShopMax" | `project.name` | — |
| "24 tests · last run 6 minutes ago" | `stats.counts.testCases`, `stats.lastRunAt` with `fmtAgo` | — |
| Hero "18 of 24 compiled" | `GET /projects/:id/testcases` → count of `hasScript` | Add `counts.compiled` to `ProjectStats` so the overview needs one call |
| Hero "about 65 seconds" | — | Add `timing.replayMedianMs`; estimate = compiled × median ÷ concurrency |
| Hero toggle / button | — | Calls `POST /projects/:id/suite-runs` (T3.1) |
| Coverage by area, circular % | — | Add `stats.areas: { name, tests, failing, coveredPct }[]`. Area = `AppPage.kind` of the page a test's first non-base URL step landed on; fall back to "Other". Percent = covered requirements ÷ requirements whose evidence steps touch that area. If there is no coverage profile, show test counts and hide the percentage rather than inventing one |
| Mode card "3.6s", "20.9s" | — | Add `timing.replayMedianMs`, `timing.aiMedianMs`, computed in `services/stats.ts` from `finishedAt − startedAt` over the last 50 finished runs of each `mode` |
| Mode card "0 AI calls" | `stats.cost` is a total | Add `cost.replayCalls` and `cost.aiCalls` split by `mode` |
| Runs line chart | `stats.trend` (`{ date, passed, failed }` × 14) | Plot `passed + failed`; tooltip shows both |
| Donut "85%" and legend | `stats.coverage` (`covered`, `partial`, `uncovered`, `total`) | Centre = covered ÷ total. Segments = covered / partial / uncovered when there are no areas; by area when `stats.areas` has coverage |
| Draft cards | `SuiteResult.drafts` (`title`, `instruction`, `kind`, `why`, `warnings`, `duplicateOf`) | `kind` is `happy-path` / `negative` / `edge`; map to the three icons. Show `warnings` and `duplicateOf`, which the mock-up omits |
| "Try" chips | `AppMap.topics` | — |
| Suite list row | `TestCase` + `runs[0]` | Result badge from `runs[0].status`; time from `runs[0]` |
| Run header chips | `Run.mode`, `llmCalls`, `startedAt`/`finishedAt`, project viewport | `failureKind` is on the row the server returns but **missing from the web `Run` type** in `api.ts`. Add `failureKind?: 'app' \| 'tool' \| null`, `suiteRunId`, `model` |
| Expected / Actual panels | `BugReport.expected`, `.actual` when a bug exists; otherwise the failing step's `error` | Parse nothing out of free text. If there is no bug report, show the step error in one panel |
| "What the AI saw" | `StepDTO.observation` | Empty on replay steps and on batched steps after the first; say "not recorded for this step" |
| Locator tab | `StepDTO.locator` (JSON `ElementRef`) | Render with `describeCandidate` from `@testpilot/shared` |

`ProjectStats` (server `services/stats.ts` and web `api.ts`) therefore gains:

```ts
counts: { ...; compiled: number }
timing: { replayMedianMs: number | null; aiMedianMs: number | null }
cost: { llmCalls; promptTokens; completionTokens; aiCalls: number; replayCalls: number; estimatedUsd: number | null }
areas: { name: string; tests: number; failing: number; coveredPct: number | null }[]
```

`projectStats` currently selects only `status, flaky, createdAt, llmCalls, promptTokens,
completionTokens` from `Run`; extend the `select` with `mode, startedAt, finishedAt`.

What the existing overview shows and the new one must not lose: the empty state with its two
buttons ("Define requirements", "Write and run a test"), open bugs, suggested missing tests with a
link to that tab, and the recent-runs list (first 6 of `GET /projects/:id/runs`).

---

## Phase 5 — validation on real sites

Scripts live in `packages/server/scripts/validate/`, one per site, all following
`truepositive2.mjs` from the earlier session (drive the product through its HTTP API; check each
verdict with a separate plain-Playwright script that uses no AI).

For each site:

1. Create the project through `POST /api/projects`.
2. `POST /projects/:id/testcases/generate` with `explore: true`; save the map and the drafts.
3. Add four to six drafts and run them (AI).
4. Replay each passing test five times. Record pass count, time, LLM calls (must be 0), healed steps.
5. Ground truth: for each test, a hand-written Playwright check of the same claim. Any disagreement
   is a finding to investigate, not to explain away.
6. True-positive probe where the site offers one.

| Site | Specific things to exercise | True-positive probe |
|---|---|---|
| saucedemo.com | login, cart, checkout, sort | `locked_out_user`, `problem_user` |
| the-internet.herokuapp.com | `/upload`, `/iframe`, `/windows`, `/dynamic_loading/2`, `/javascript_alerts`, `/dropdown`, `/checkboxes` | `/broken_images`, `/status_codes` |
| automationexercise.com | signup, product search, cart, consent banner | none |
| practicesoftwaretesting.com | Angular SPA: filter, cart, login with the documented demo account | the site's documented "with bugs" build |
| demoqa.com | `/automation-practice-form` (date picker, upload, custom selects), `/frames`, `/browser-windows` | none |
| todomvc.com/examples/react/dist | add, complete, filter, delete via keyboard | none |

Pass bar: zero bug reports against behaviour the ground truth says is correct; every probe yields a
failure with `failureKind: 'app'`; replays 5 of 5 with 0 LLM calls; any site that blocks automation
is reported as blocked, in words.

Write results to `docs/V7-VALIDATION.md`: one table per site, plus every defect found in TestPilot
itself and how it was fixed. Expect to find some; the last trial found three.

Quota: Gemini Flash-Lite free tier is about 500 requests a day. Budget 40 per site. Stop and
resume the next day rather than switching to a paid key.

---

## Phase 6 — evaluation harness

`packages/server/scripts/evaluate.mts`, script `evaluate`. Target: ShopMax on a fresh database.

Ground truth lives in `packages/demo-shop/README.md` (five seeded bugs). Encode them in
`scripts/evaluate.bugs.ts` as `{ id, name, match: (bug: BugReport, run: Run) => boolean }` using
keywords on the failing step and URL, for example SAVE10 → `/save10|discount|coupon/i` on the cart.

Per repetition (three in total):

1. Reset ShopMax, create project, explore.
2. **Arm A — one pass:** generate a suite with no prompt, add all drafts, run. Wait for the queue to
   drain including retries.
3. Record: tests, passes, failures, bug reports, which seeded bugs matched, reports matching none
   (false reports), LLM calls, tokens, seconds.
4. **Arm B — gap-filled:** propose requirements (or load the 20 from the demo-shop README), profile
   coverage, generate gaps, accept every feasible non-duplicate one, run them.
5. Record the same figures, cumulative.

Output `docs/evaluation/<date>.json` and a Markdown table:

| Rep | Arm | Tests | Seeded bugs found (of 5) | False reports | LLM calls | Tokens in / out | Time |

Then mean and range per arm. State the limits in the output itself: one application, five seeded
bugs, three repetitions, a free-tier model.

---

## Phase 7 — documentation

- `README.md`: features, actions, parallelism, suite runs, benchmark table (baseline vs final),
  test count.
- `docs/USAGE.md`: the suite button, the CLI, uploads, what "blocked" means and what to do.
- `docs/V2-HARDENING.md`: append a V7 section with what changed and the measured results.
- This file: tick each task, and replace every "target" with the measured figure.

---

## Appendix A — files touched, by phase

| Phase | New | Changed |
|---|---|---|
| 0 | `scripts/bench.mts` | `runner.ts`, `replay.ts` (timing hook only) |
| 1 | `engine/browserPool.ts`, `engine/settle.ts`, `engine/tabs.ts`, tests | `runService.ts`, `runner.ts`, `replay.ts`, `locator.ts`, `executor.ts`, `evidence.ts`, `script.ts`, `config.ts`, `index.ts`, `shared/script.ts`, `schema.prisma` |
| 2 | `engine/sampleFiles.ts`, `engine/blockers.ts`, `engine/urls.ts`, tests | `shared/actions.ts`, `validator.ts`, `runner.ts`, `executor.ts`, `perception.ts`, `prompts.ts`, `generator.ts`, `explorer.ts`, `script.ts`, demo-shop routes |
| 3 | `services/suiteService.ts`, `scripts/suite.mts`, `shared/pricing.ts` | `schema.prisma`, `bugs.ts`, `runService.ts`, `routes/*.ts`, `stats.ts`, `shared/types.ts` |
| 4 | — | everything under `packages/web/src`, `tailwind.config.js`, `index.html` |
| 5 | `scripts/validate/*.mjs`, `docs/V7-VALIDATION.md` | whatever the validation finds |
| 6 | `scripts/evaluate.mts`, `scripts/evaluate.bugs.ts` | — |

## Appendix B — things not verified while writing this spec

Read line by line while writing this spec: `config.ts`, `runService.ts`, `runner.ts`, `replay.ts`,
`executor.ts`, `locator.ts`, `script.ts`, `validator.ts`, `perception.ts`, `generator.ts`,
`prompts.ts`, `provider.ts`, `router.ts`, `bugs.ts`, `stats.ts`, `evidence.ts`, every file in
`routes/`, `schema.prisma`, `shared/actions.ts`, `shared/types.ts`, the `exploreApp` loop,
`globalSetup.ts`, `vitest.config.ts`, `App.tsx`, `ProjectPage.tsx`, the first 70 lines of
`RunPage.tsx`, `tailwind.config.js`, `index.css`.

**Not** read, so check before relying on anything said about them:

- The tab components under `packages/web/src/pages/tabs/` (only their prop lists, taken from
  `ProjectPage.tsx`), `QuickTest.tsx`, `BugPage.tsx`, `SettingsPage.tsx`, `ProjectsPage.tsx`, and
  the bodies of `components/ui.tsx` and `components/charts.tsx` (only their export lists).
- `ai/suite.ts`, `ai/coverage.ts`, `ai/gaps.ts`, `ai/gapFilter.ts`, `ai/lint.ts`,
  `ai/requirements.ts`, `services/authCapture.ts`, `engine/inventory.ts`, `engine/crawler.ts`.
- The explorer's `EXTRACT_JS`, `tryLogin`, `dismissOverlays` and `isGated`.
- How the integration tests start ShopMax (the spec points at the file to copy from).
- Whether `<input type="file">` survives perception's visibility filter when a site hides it behind
  a styled button. T2.3 assumes it may not and says how to fix it; confirm with a test first.

Facts confirmed about demo-shop: it has a `target="_blank"` link (`/help`), **no** file input and
nothing slower than a 350 ms debounce. `packages/web/index.html` loads no web fonts yet. The run page
and several badges use the "⚡" emoji as an icon; the new design replaces those with inline SVG.

The baseline test run was interrupted before it finished, so "currently green" comes from the
previous session (90 passing then, 95 `it(...)` cases counted now) and is not re-confirmed.

## Appendix C — source for the batching design

browser-use's agent accepts several actions per step (`max_actions_per_step`) and interrupts the
sequence when the page changes or new elements appear, returning the new state to the model. Its
upstream `multi_act` source was not read directly; the behaviour is documented in the system prompts
of several forks ([one example](https://glama.ai/mcp/servers/@dsouza-anush/browser-use-heroku/blob/430d35aa1e00a656b3bcf1f2292d05e41a40f657/browser_use/agent/system_prompt.md)).
The fingerprint rule in T2.1 is this project's own, stricter version of that check.
