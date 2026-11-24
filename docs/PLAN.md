# TestPilot — Conversion Plan

**From:** Agentic Web Navigator (Electron + Python + patchright, GPT-4o mini "do a task on any website")
**To:** TestPilot — an AI-assisted web testing platform with automatic missing-test discovery and bug reporting (per the FYP slides)

Backup of the original repo: `C:\Users\DELL\Desktop\Agentic web navigator - backup`

---

## 1. What carries over, what changes

| Navigator (existing) | TestPilot (new) | Decision |
|---|---|---|
| `perception.py` — injected JS that indexes visible interactive elements (`[7] button "Sign in"`) and stamps `data-agent-id` | `engine/perception.ts` — same script, verbatim port | **Reuse** (this *is* M1 "Observe") |
| `prompts.py` tool schema (navigate, click, type, select, …, done) | `shared/actions.ts` — zod schema of the 7 **supported actions** from Slide 8 + `finish` | **Reuse shape, restrict set** |
| `loop.py` ReAct loop (observe → think → act), repeat-guard, fail-streak | `engine/runner.ts` — same loop, plus a **validation gate** with max-3 regenerate (Slide 9/13) | **Reuse + extend** |
| `actions.py` executor (resolve by `data-agent-id`, click fallback, fill) | `engine/executor.ts` | **Port** |
| `llm.py` OpenAI client w/ unsupported-param retry | `ai/provider.ts` — provider interface, OpenAI impl, OpenAI-compatible fallback, mock | **Port + abstract** |
| `conversation.py` message trimming | `ai/context.ts` | **Port** (trim old observations) |
| Electron shell, tabs, start page, Google profile probe | — | **Drop** (Playwright launches headed Chromium itself) |
| CAPTCHA solving, stealth, credential vault/TOTP, human takeover | — | **Drop** (test env only, one test account; out of scope) |
| Python service, WebSocket protocol | Express REST + Server-Sent Events | **Replace** |

Why Node/TS instead of Python: the slides specify Node/Express + React + Playwright; Playwright's Node API is the first-class one; one language across server, shared schema, and dashboard.

Why SQLite via Prisma instead of MongoDB: user asked to avoid Docker and for a database that sets up locally with no fuss. Prisma gives a typed schema + migrations; `DATABASE_URL` + `provider = "postgresql"` switches to Postgres with no application code changes. The slides' entities (cases · runs · scenarios · reports) map to tables.

---

## 2. Target architecture

```
Browser (React dashboard, :5173)
   │  REST + SSE (live run events)
   ▼
Express API (:4000) ──► Prisma ──► SQLite (data/testpilot.db)
   │
   ├─ engine/   Playwright runner: observe → generate → validate → execute, evidence (screenshots, trace.zip)
   ├─ ai/       LLM provider, generator, coverage profiler, gap generator + filter, bug writer
   └─ evidence/ per-run screenshots + trace.zip on disk (paths stored in DB)

External: LLM API (OpenAI by default) · Target web app (test env) · built-in demo shop (:4100) for demos/evaluation
```

Monorepo (npm workspaces):

```
packages/shared   zod action schema, event types, requirement/coverage types
packages/server   Express + Prisma + Playwright + AI modules
packages/web      React + Vite + Tailwind dashboard
packages/demo-shop tiny e-commerce app (register/login/cart/checkout) with /__reset — the evaluation target
docs/             PLAN.md (this), ARCHITECTURE.md
```

---

## 3. Module mapping (Slide 7)

### M1 Instruction — page reading + action schema
- `shared/actions.ts`: discriminated union, **exactly** the supported set:
  `navigate{url}` · `click{index}` · `type{index,text}` · `select{index,value}` · `assertVisible{index|text}` · `assertText{index?,text}` · `assertUrl{contains}` · `finish{verdict: pass|fail, reason}`
- `engine/perception.ts`: port of `_COLLECT_JS`; returns `Observation {url,title,elements[]}` + `renderText()`.
- Test data placeholders in instructions: `{{unique_email}}`, `{{unique_id}}`, `{{test_user}}`, `{{test_password}}` (from project settings) — so each run uses fresh data.

### M2 Generation & Validation
- `ai/generator.ts`: given instruction + observation + history, the LLM returns **one** structured action (JSON mode / tool call). Uses step-wise ReAct, as in the slides' diagram ("AI returns a structured action").
- `engine/validator.ts` (deterministic, no LLM): zod parse → action type is allowed → `index` exists in **current** observation → `type` targets an input/textarea/contenteditable → `select` targets a `<select>` → assertions carry non-empty text → `navigate` URL is same-origin as project baseUrl (safety) → not a 3× exact repeat.
  Reject ⇒ the rejection reason is fed back, regenerate (max **3**), then the step is **flagged** and the run fails with reason `invalid_step`.

### M3 Execution Engine
- `engine/runner.ts`: Playwright Chromium (headed by default, `HEADLESS=1` to hide), fresh context per run, `context.tracing.start`, screenshot after **every** step, `trace.zip` at the end, `Step` rows written live, events streamed via SSE.
- Assertions execute as real checks (`assertVisible` → locator visible; `assertText` → innerText contains; `assertUrl` → `page.url()` contains).
- Data cleanup: project `resetUrl` (HTTP POST called before each run) + fresh browser context + unique placeholders. The demo shop implements `/__reset`.
- Budget: `llmCallBudget` per run (default 40); exceeding ⇒ run ends `error: budget_exceeded`.
- Flakiness: a failed run is **re-run once** automatically before a bug is filed (`Run.attempt`, `Run.retryOfId`).

### M4 Coverage Checker (new)
- Project has a **Requirements checklist** (R1…Rn, plain English). Entered manually, or **proposed from the DOM**: the engine visits baseUrl + discovered same-origin links (depth 1), and the LLM drafts requirements from element inventories only (no source code — Slide 11 claim).
- `ai/coverage.ts`: input = requirements + run **evidence** (executed steps, assertion outcomes, URLs visited). LLM maps each requirement to `covered | partial | uncovered` **with cited step ids**. Deterministic guard: `covered` is downgraded to `partial` unless at least one cited step is a **passed assertion**. Stored as `CoverageProfile` + `CoverageItem`.
- Project view shows a coverage matrix (requirements × runs).

### M5 Gap Generator & Filter (new)
- `ai/gaps.ts`: for every `uncovered`/`partial` requirement, generate candidate test instructions (title + plain-English instruction + target requirement).
- Filter pipeline (`ai/gapFilter.ts`):
  1. **Exact/near-duplicate** — normalised token Jaccard ≥ 0.8 against existing test cases and other candidates (deterministic);
  2. **Semantic duplicate** — LLM yes/no against the nearest 5 existing cases;
  3. **Feasibility** — the candidate's needed UI (login form, cart button, search box…) must appear in the project's **element inventory** collected during runs/crawl; otherwise `infeasible` with a reason.
- Stored as `GapScenario {status: suggested|accepted|rejected|converted}`; "Accept" converts it into a `TestCase` (origin = `gap`) and can run immediately.

### M6 Reporting Dashboard
- Pages: Projects → Project (Requirements · Test cases · Runs · Coverage · Gaps · Bugs) → Run detail (live step timeline with screenshots, trace download, verdict) → Bug report (Markdown export).
- `ai/bugs.ts`: on a failed (confirmed, post-retry) run, generate a **BugReport**: title, severity, steps-to-reproduce (from executed steps), expected vs actual, screenshot of failing step, environment. Stored, editable, exportable as `.md`.
- Live updates over SSE (`/api/runs/:id/events`).

---

## 4. Data model (Prisma, SQLite)

```
Project        id name baseUrl description resetUrl testUser testPassword llmCallBudget createdAt
Requirement    id projectId key text source(manual|dom) createdAt
TestCase       id projectId title instruction origin(user|gap) gapScenarioId? createdAt
Run            id testCaseId status(queued|running|passed|failed|error|cancelled) attempt retryOfId?
               startedAt finishedAt verdict reason llmCalls promptTokens completionTokens tracePath
Step           id runId index action(json) status(ok|failed|rejected|flagged) validationAttempts
               error? screenshotPath? url durationMs observationSummary createdAt
CoverageProfile id projectId runId createdAt
CoverageItem   id profileId requirementId status(covered|partial|uncovered) rationale evidenceStepIds(json)
GapScenario    id projectId profileId? requirementId? title instruction status rationale
               feasibility(feasible|infeasible|unknown) duplicateOfId? createdAt
BugReport      id runId projectId title severity stepsToReproduce(json) expected actual
               screenshotPath? status(open|closed) markdown createdAt
ElementInventory id projectId url role label seenAt    (DOM-only knowledge used by feasibility)
LlmCache       id hash response model createdAt         (fallback to cached results)
```

---

## 5. API surface

```
GET/POST        /api/projects                  GET/PUT/DELETE /api/projects/:id
GET/POST/DELETE /api/projects/:id/requirements   POST /api/projects/:id/requirements/propose   (DOM crawl → draft)
GET/POST/DELETE /api/projects/:id/testcases
POST            /api/testcases/:id/run           → Run    GET /api/runs/:id    GET /api/runs/:id/events (SSE)
POST            /api/runs/:id/cancel             GET /api/runs/:id/trace (download)   GET /api/evidence/* (static)
POST            /api/projects/:id/coverage       (profile latest runs)   GET /api/projects/:id/coverage
POST            /api/projects/:id/gaps/generate  GET /api/projects/:id/gaps   POST /api/gaps/:id/accept|reject
GET             /api/projects/:id/bugs           GET /api/bugs/:id   GET /api/bugs/:id.md
GET             /api/health
```

---

## 6. LLM layer — free APIs only

Requirement: free tier, no credit card, enough daily volume for an FYP, enough intelligence for structured test generation.

Each provider carries **two** models: `*_MODEL` for the high-volume per-step calls and
`*_REASON_MODEL` for the handful of reasoning calls. The reasoning model falls back to the cheap
one automatically when its (smaller) quota is exhausted.

| Role | Default | Free limit (verify in console) | Why |
|---|---|---|---|
| **Step generation** (~4–8 calls per test run) | `gemini-3.5-flash-lite` | ~500 req/day | Largest free daily quota after the Oct-2026 cuts; ~1 s latency. Enough intelligence given the strict schema + validator — verified choosing correct actions. |
| **Reasoning** (coverage, gaps, bug reports — a few calls per project) | `gemini-3.5-flash` | smaller daily cap | Stronger model where judgement matters; call volume is low enough for the cap. |
| **Optional upgrade / fallback** | Groq `openai/gpt-oss-120b` | ~1000 req/day, ~200K tok/day | Set `GROQ_API_KEY` + `LLM_REASON_PROVIDER=groq`. Token cap rules it out for per-step use. |
| **Paid alternative** | `LLM_PROFILE=openai` | — | `OPENAI_MODEL` for everything. |

Verified 2026-11-11 against the live API: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-3.5-flash` and `gemini-flash-lite-latest` all work and honour `response_format:
json_object`. Full-Flash `gemini-flash-latest` was unreliable; `gemini-2.x-flash-lite` are retired.
Rejected providers: OpenRouter free (50 req/day), Cerebras (free tier removed Jul 2026), Mistral
(limits unpublished).

- Both expose **OpenAI-compatible** chat endpoints → one `OpenAICompatProvider` class (base URL + key + model).
- **Paid OpenAI is a first-class option**, chosen in `.env`:
  - `LLM_PROFILE=free` (default) → Gemini Flash-Lite for steps, Groq for reasoning.
  - `LLM_PROFILE=openai` → `OPENAI_MODEL` (default `gpt-4o-mini`) for everything.
  - Per-role override: `LLM_STEP_PROVIDER` / `LLM_REASON_PROVIDER` ∈ `gemini | groq | openai | mock`.
  - Whatever is configured, every *other* provider with a key present acts as fallback.
- `ai/router.ts`: `llm.step()` → step model; `llm.reason()` → reasoning model. Fallback chain per call: role model → the provider's other model → every other configured provider → `LlmCache` (prompt-hash) — "retry with backoff; fall back to cached results or a second provider" (Slide 9).
- Per-provider **rate limiter** (min gap between calls) + exponential backoff on 429/5xx.
- Per-run **call budget** (`llmCallBudget`) — "fixed call limit per test run" (Slide 9).
- Startup **model check**: `GET /models` on each provider; the dashboard Settings page shows reachable models, so a renamed model is a one-line `.env` fix.
- `MockProvider` (`LLM_PROVIDER=mock`): scripted responses for tests and offline demos.

---

## 7. Implementation order

1. Scaffold monorepo, remove Electron/Python, Prisma schema + migrate, Express skeleton, Vite React app. ✅ runs end-to-end with health check.
2. **M1**: shared action schema, perception port, placeholders.
3. **M2 + M3**: provider, generator, validator, runner with evidence + SSE; `run` endpoint; demo shop.
4. **M6 (core)**: dashboard — projects, test cases, run detail with live steps + screenshots.
5. **M4**: requirements CRUD + DOM-proposal, coverage profiler + matrix UI.
6. **M5**: gap generation + filter + accept flow.
7. **Bugs**: retry-once policy, bug writer, Markdown export.
8. Tests (vitest: validator, gap filter, coverage guard, perception render; Playwright smoke run against demo shop with mock LLM), README, `.env.example`, scripts.

---

## 8. Status (2026-11-11) — implemented

All of §3 is implemented and wired end to end:

| Module | Code | Verified by |
|---|---|---|
| M1 Observe + schema | `engine/perception.ts`, `shared/actions.ts`, `engine/placeholders.ts` | unit tests + e2e |
| M2 Generate + Validate | `ai/generator.ts`, `engine/validator.ts` (max-3 regenerate, flag) | 10 validator tests + e2e "rejects 3× then flags" |
| M3 Execute | `engine/runner.ts`, `executor.ts`, `evidence.ts` (screenshots, trace.zip, reset hook, budget, sequential queue) | e2e against demo shop with headless Chromium |
| M4 Coverage | `ai/coverage.ts` (+ passed-assertion guard) | unit + e2e |
| M5 Gaps + filter | `ai/gaps.ts`, `ai/gapFilter.ts` (Jaccard dedupe → semantic dedupe → feasibility vs DOM inventory) | unit tests |
| M6 Dashboard | `packages/web` (projects, requirements, tests, live runs via SSE, coverage matrix, gap review, bug reports, LLM settings) | typecheck + manual |
| Bugs | `ai/bugs.ts`, `services/runService.ts` (re-run once, then file) | e2e |
| Requirements from DOM | `ai/requirements.ts` + `engine/crawler.ts` | manual (needs LLM key) |

Not done / future: evaluation harness that compares one-pass vs gap-filled bug yield across the two apps (thesis experiment — export endpoints exist, a script is the next step); auth/multi-user; PostgreSQL deployment docs beyond the provider switch.

## 9. Out of scope (kept consistent with Slide 8)
Mobile/native, non-Chromium browsers, visual diffing, auto-fixing tests, reading source code, CAPTCHA/credential vault/human takeover (test env + one account assumed), model training.
