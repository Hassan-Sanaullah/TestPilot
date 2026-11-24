# V7 — Plan to finish TestPilot as a product

Status: **implemented, 23 November 2026.** Every task in this plan and in the two companion
specs has been built, and the suite is green (228 tests). What was found while building it — six
real defects the plan did not anticipate, and the places where a specified approach turned out to
be wrong — is recorded in the "V7" section of [V2-HARDENING.md](V2-HARDENING.md). Measured figures
replace the targets below where one was measured; see [benchmarks/](benchmarks) and
[evaluation/](evaluation).

Written 16 November 2026 after reading the current engine, run service, AI layer and routes.

This file is the overview. Two companion files hold the task-by-task instructions, with code,
tests and acceptance checks:

- [V7-IMPLEMENTATION-SPEC.md](V7-IMPLEMENTATION-SPEC.md) — speed, missing capabilities, product
  features, the interface, validation, evaluation (tasks `T…`).
- [V7-TESTING-LOGIC-SPEC.md](V7-TESTING-LOGIC-SPEC.md) — the testing itself: test design, how a
  verdict is reached, coverage, gap finding, trust (tasks `L…`). It lists 20 further weaknesses
  beyond the 16 below, and its section 13 gives the single merged order of work for both files.

Implement from those two, following the merged order.

The goal, in the words of the brief: a product that makes testing websites easy, works on
whatever site it is pointed at, behaves the way a user expects, and is fast.

---

## 1. Where the product stands today

What already works and will not be rewritten:

- Explore an app and write its tests from one button or a few words.
- AI authors a test once; a passing run compiles to a script; replays use no AI.
- Failures are classified `app` or `tool`; only `app` failures become bug reports.
- Coverage profiling, missing-test generation, bug reports, `.spec.ts` export.
- Verified on ShopMax, saucedemo.com, the-internet.herokuapp.com, automationexercise.com.

What is missing or wrong. Each item below was found in the code, not guessed.

| # | Problem | Where | Effect on the user |
|---|---|---|---|
| 1 | Runs execute strictly one at a time | `services/runService.ts` (single `active` slot) | A 24-test suite takes 24 × one test |
| 2 | A new Chromium process is launched for every run | `engine/runner.ts`, `engine/replay.ts` | About a second of dead time per run |
| 3 | A fixed 400 ms pause follows every click, type and navigation (200 ms after everything else) | `Executor.settle()` | A 7-step replay spends about 2.8 s waiting for nothing |
| 4 | One LLM call per action, and each call resends the conversation | `engine/runner.ts`, `ai/generator.ts` | Filling a 5-field form costs 6 round trips |
| 5 | Full PNG screenshot plus full Playwright trace on every step of every run | `engine/evidence.ts`, both runners | Slower steps, large evidence folders |
| 6 | Replay does not wait for an element to appear; a slow render goes straight to the AI "heal" path | `locator.resolveRef()` | Extra latency and false tool failures on SPAs |
| 7 | A compiled script containing `switchTab` cannot replay | `replay.ts` calls the executor, which rejects `switchTab` | Multi-tab tests work once and never again |
| 8 | Replay opens the base URL, then the script usually navigates to it again | `replay.ts` | One wasted page load per replay |
| 9 | Bug reports are de-duplicated per run only | `ai/bugs.ts` | Replaying one failing test five times files five bugs |
| 10 | No way to upload a file | action schema has no upload | Any form with a file input is untestable |
| 11 | "Run all" has no identity: no suite run, no summary, no progress | `routes/testcases.ts` | The user cannot answer "did last night's suite pass?" |
| 12 | A reset hook and parallel runs would corrupt each other | design gap | Must be solved before item 1 |
| 13 | The explorer visits pages one after another | `engine/explorer.ts` | 30–60 s to map a site |
| 14 | The approved visual design exists only as a mock-up | `packages/web` still has the old look | The product does not look like the design that was signed off |
| 15 | The project's central claim has never been measured | no evaluation harness | The thesis has no number for "gap tests find more bugs" |
| 16 | No per-run cost figure; README and defaults are stale | UI, `README.md`, `config.ts` | Small, but visible to an examiner |

---

## 2. Principles for this round

1. **Measure first, then change.** A benchmark script is written before any optimisation, and every
   latency claim in the final write-up comes from it. The numbers in section 4 are targets, not results.
2. **Never trade correctness for speed.** Every shortcut must fall back to the slow, safe path.
   A fast test that asserts the wrong thing is worse than a slow one.
3. **A tool failure is never an application bug.** New code paths keep the `failureKind` rule.
4. **Nothing specific to ShopMax.** Every change is validated on external sites it was not tuned on.
5. **Honest limits.** Where a site cannot be driven, the product says so plainly instead of guessing.

---

## 3. Workstream A — latency

### A0. Benchmark harness (do this first)

`packages/server/scripts/bench.ts`, run with `npm run bench`.

- Uses ShopMax and a mock LLM, so it is repeatable and costs no quota.
- Reports, per run: launch, navigation, per-step resolve / act / settle / screenshot, trace save, total.
- Reports, for a suite of 12 compiled tests: wall-clock time and tests per minute.
- Writes `docs/benchmarks/<date>.json` so before and after can be compared.

### A1. Shared browser pool

One Chromium process for the server; each run gets its own `BrowserContext`.

- New `engine/browserPool.ts`: lazy launch, relaunch if the process dies, close on shutdown.
- Contexts are fully isolated (cookies, storage), so runs cannot see each other.
- Cancel closes the context, not the browser.
- Login recording keeps its own headed browser.

### A2. Parallel runs

- `runService` becomes a worker pool. `RUN_CONCURRENCY` (default 4) bounds replays;
  `AI_CONCURRENCY` (default 2) bounds AI runs, because free-tier rate limits are per minute.
- **Reset-hook rule:** a project with a reset URL runs one test at a time, because a reset wipes
  the data other tests are using. Projects without one run in parallel. The settings page explains this.
- Suite runs default to headless; a single run still opens a visible window when `HEADLESS=0`.

### A3. Event-driven settling instead of fixed pauses

Replace `settle()` with a wait that ends when the page stops changing:

- A `MutationObserver` in the page; resolve after 100 ms without DOM changes, cap at 1.5 s.
- Navigation in flight is detected and awaited (`domcontentloaded`).
- Hover and scroll lose their fixed 400 / 500 ms sleeps the same way.
- Faster on quiet pages and *more* patient on slow ones than a fixed 400 ms.

### A4. Fewer LLM round trips while authoring

The largest authoring win. The model may return up to five actions in one reply:

```json
{"thought": "fill the form", "actions": [ {"type":"type",...}, {"type":"type",...}, {"type":"click",...} ]}
```

Safety rules, enforced by the runner and not left to the model:

- Every action in the batch is validated against the observation the model saw.
- After each action a cheap page fingerprint is taken (URL, interactive-element count, open dialogs).
  If it changed, the rest of the batch is dropped and the model re-plans from a fresh observation.
- An assertion or `finish` is never executed from a batch after the page has changed.
- Each action is still saved as its own step with its own verified locator, so compilation is unchanged.

Also: keep two observations in the prompt instead of three, and skip the model entirely for a first
step that is only "open the base URL".

### A5. Cheaper evidence

- Screenshots as JPEG quality 70 (several times smaller, faster to write).
- Trace mode becomes a setting: `always`, `on-failure` (default for replays), `off`.
  AI authoring runs keep the full trace, because that is where it is useful.

### A6. Replay fixes that are also speedups

- `resolveRef` polls for up to 5 s before giving up (items 6).
- Skip the script's first `navigate` when it targets the page already open (item 8).
- Try a healed locator from the stored description before calling the model.

### A7. Explorer in parallel

Three tabs crawl at once after sign-in; the URL-shape cap and click-probing rules stay as they are.

### Targets (to be confirmed by A0)

| Scenario | Measured today | Target |
|---|---|---|
| Replay, one ShopMax test | 3.6 s | under 2 s |
| Replay, one saucedemo test | 5–11 s | under 4 s |
| Authoring a form test | 20.9 s, 4 calls | under 12 s, 2 calls |
| Suite of 24 compiled tests | about 2 minutes | under 30 s |
| Explore a 10-page site | 30–60 s | under 25 s |

---

## 4. Workstream B — works on the site in front of it

### B1. Missing capabilities

| Capability | Change |
|---|---|
| File upload | New `upload` action; generates a small sample file (image, PDF or text) and sets it on the input |
| Multi-tab scripts | Replay gets the same tab tracking the AI runner has; `switchTab` replays |
| Custom dropdowns, date pickers, rich-text editors | Prompt guidance plus tests against real widgets; no new action unless a test proves one is needed |
| Checkboxes and radios | `assertChecked`-style check through `assertValue`, so state can be verified, not only clicked |
| Slow or infinite-loading pages | The new settle logic plus a clear `tool` failure when a page never becomes usable |

Each new action is added in five places together: schema, validator, executor, script compiler,
`.spec.ts` export.

### B2. Failing honestly

Some sites cannot be driven by any tool of this kind. The product must detect these and say so:

- CAPTCHA or bot wall on the page → stop with "this site is blocking automated browsers", `tool` failure.
- Login needs MFA or SSO and no session is recorded → point the user at **Record a login session**.
- Canvas-only or closed-shadow-DOM interfaces → "no interactive elements could be read".

None of these may ever produce a bug report.

### B3. Real-site validation matrix

Run after the engine work, using the method that worked before: drive through the product's own API,
check every verdict against a hand-written plain-Playwright script, and probe for true positives.

| Site | Why it is in the matrix |
|---|---|
| saucedemo.com | React SPA, already a baseline; has a deliberately broken user for true positives |
| the-internet.herokuapp.com | Uploads, iframes, new tabs, dynamic loading, JS alerts |
| automationexercise.com | Large classic multi-page shop with ads and consent |
| practicesoftwaretesting.com | Angular SPA with a documented buggy variant |
| demoqa.com | Date pickers, custom selects, drag and drop, nested frames |
| todomvc.com | Minimal SPA, keyboard-driven |

No CAPTCHA sites. Expected quota use: roughly 150–250 free Gemini calls.

Pass bar: no fabricated bug on any working site; every seeded or documented defect that a test
targets is reported with cause `app`; every replay that passed once passes five times in a row.

---

## 5. Workstream C — product completeness

1. **Suite runs.** `Run` gains a `batchId`; a new `SuiteRun` row holds started, finished, counts and
   duration. "Run suite" shows live progress and ends in a one-screen summary.
2. **Bug de-duplication.** A failure is matched to an open bug for the same test and failing step.
   A repeat adds an occurrence count and "last seen" instead of a new report. A later pass offers to close it.
3. **CI entry point.** `npm run suite -- <project>` runs the compiled suite headless and exits non-zero
   on failure; "Export suite" downloads every test as one Playwright spec file.
4. **Cost per run.** A small price table by model turns tokens into a cost figure on the run and
   overview pages.
5. **Housekeeping.** Evidence retention setting, README and `.env.example` brought up to date,
   OpenAI default model corrected.

Deliberately left out unless asked for: scheduled nightly runs, an Anthropic provider, visual
regression, mobile viewports beyond a width and height setting.

---

## 6. Workstream D — the approved interface

Port the signed-off design from the canvas into `packages/web`, dark and light.

1. **Tokens.** The palette, radii, card gradient, glass and glow recipes become Tailwind theme values
   and a few component classes. Theme follows the system setting with a manual toggle.
2. **Shell.** Sidebar navigation with the filled active pill, project switcher, frosted search field.
3. **Components.** Card, button, pill, status badge, circular percentage badge, toggle, tabs, table row.
4. **Screens**, in this order: Overview (line chart with tooltip, donut, coverage by area, mode cards),
   Test cases (one-prompt hero, draft cards, suite list), Run detail (timeline, step spine, captured
   page, error panel with expected and actual), then Runs, Coverage, Missing tests, Bugs, App map, Settings.
5. **Run detail behaviour.** Selecting a step drives every panel, as in the Playwright trace viewer.
6. Charts keep the validated colour set; every status carries a shape and a word as well as a colour.

The interface work changes no API. It can proceed while engine work is being validated.

---

## 7. Workstream E — the evaluation the thesis needs

`npm run evaluate` against ShopMax, whose five seeded bugs are the ground truth.

1. Arm A: generate one suite from the app map and run it. Record which seeded bugs it reports.
2. Arm B: profile coverage, generate the missing tests, run them. Record the additional bugs.
3. Output a table and a JSON file: bugs found per arm, false reports, tests written, LLM calls,
   tokens, wall-clock time. Repeat three times and report the spread.

This is only meaningful because replays are deterministic, which is why it comes after the engine work.

---

## 8. Order of work

| Phase | Contents | Done when |
|---|---|---|
| 0 | Confirm the current suite is green; A0 benchmark; record the baseline | Baseline file committed |
| 1 | A1, A2, A3, A5, A6 | Benchmark meets the replay and suite targets; all tests pass |
| 2 | A4, B1, B2, A7 | Authoring target met with a mock and with Gemini; new actions have tests |
| 3 | C1–C5 | Suite run, de-duplicated bugs and the CLI work end to end |
| 4 | D1–D6 | Every screen matches the canvas in both themes; type-check clean |
| 5 | B3 validation matrix | Pass bar in section 4 met; results written up |
| 6 | E evaluation | Table produced from three repetitions |
| 7 | README, usage guide, this document updated with measured results | Docs match the product |

Phases 1–3 are engine and API; phase 4 is interface only. Each phase ends with the full test suite
and a type-check, and the benchmark is re-run after phases 1 and 2.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Action batching lets the model act on a page it has not seen | The fingerprint check drops the rest of the batch on any change; worst case is the old one-action behaviour |
| Parallel tests interfere through shared server data | Isolated browser contexts; unique-data placeholders; reset-hook projects stay serial |
| Event-driven settle returns too early on an app that renders late | 1.5 s cap, assertions still poll for 5 s on their own, replay waits for elements |
| Free-tier rate limits under parallel authoring | Separate, lower AI concurrency; existing adaptive back-off |
| The interface port breaks working screens | Port screen by screen behind the same API; type-check and click-through after each |
| "Any website" is read as a guarantee | The validation matrix and the honest-failure rules define what is and is not supported |

---

## 10. Decisions needed before starting

1. **Port the new interface in this round?** The plan assumes yes.
2. **Parallel runs headless by default?** The plan assumes yes for suites, visible for single runs.
3. **Anything from the "left out" list in section 5 that should be in?**
4. **Is spending roughly 150–250 free Gemini calls on the validation matrix acceptable?**
