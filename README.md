# TestPilot

**Describe a test in plain English. TestPilot runs it in a real browser, works out whether your
website behaved correctly, and writes the bug report when it did not.**

It also finds the tests you did not think to write, by reading your application's own forms and the
rules they state.

```
Explore your app → design the tests → run them in Chromium → judge the result → report the bug
                            ↓
                   compile the run into a script
                            ↓
          every later run replays it with no AI at all: seconds, free, identical every time
```

---

## Contents

1. [What this actually does](#1-what-this-actually-does)
2. [Features](#2-features)
3. [Tech stack](#3-tech-stack)
4. [Before you start](#4-before-you-start)
5. [Getting it running](#5-getting-it-running)
6. [Which port is what](#6-which-port-is-what)
7. [Your first test, step by step](#7-your-first-test-step-by-step)
8. [Reading a run](#8-reading-a-run)
9. [Replaying, and why it matters](#9-replaying-and-why-it-matters)
10. [Testing your own website](#10-testing-your-own-website)
11. [Every screen explained](#11-every-screen-explained)
12. [Writing a test by hand](#12-writing-a-test-by-hand)
13. [Test data and placeholders](#13-test-data-and-placeholders)
14. [Running it in a build](#14-running-it-in-a-build)
15. [When something goes wrong](#15-when-something-goes-wrong)
16. [Commands](#16-commands)
17. [Project layout](#17-project-layout)
18. [Limits and scope](#18-limits-and-scope)

---

## 1. What this actually does

You give TestPilot a website and a sentence like:

> Register with the email {{unique_email}} and the password "123", and verify it is refused.

An AI reads the page, decides what to click, and a real Chromium browser does it. Every action is
checked against a fixed list of allowed actions before it runs, so the AI cannot do anything
unexpected. Screenshots are saved at every step. If the application misbehaves, you get a bug
report with steps to reproduce.

Three things make it different from asking a chatbot to test your site:

**It judges against your application's own rules.** If your form says *"At least 8 characters"* and
then accepts `123`, that is a failure — even though nothing crashed and no error appeared. That is
the kind of bug that ships.

**It works out the tests for you.** TestPilot walks your application and reads every form field by
field: which are required, minimum lengths, `type="email"`, the options in each dropdown, and the
rules the page states in words. Then ordinary code — no AI — turns those into the tests a
professional would write: the value one below the minimum, the required field left empty, the
malformed email, the mismatched password confirmation. The same application always produces the
same tests, and **this part needs no API key at all**.

**The AI writes each test once, then gets out of the way.** The first run is AI-driven. That run is
compiled into a script of verified locators, and every run after it replays that script with no AI
in the loop: under two seconds, zero API calls, and the same result every time. This matters because
published research puts AI browser agents at roughly 60–70% success on real websites — a test suite
re-driven by an AI every time would inject its own failure rate into all your results.

---

## 2. Features

### Writing the tests

| Feature | What it means |
|---|---|
| **Plain-English tests** | Describe what to do and what must be true afterwards. No code, no selectors |
| **Automatic app exploration** | Walks your site, follows links, clicks JavaScript navigation, dismisses cookie walls, and signs in to reach pages that do not exist as links when signed out |
| **App map** | Every page, every form field by field (type, required, min/max length, dropdown options), and the rules each page states in words |
| **Designed tests — no AI needed** | Boundary values, required-field omission, format invalidation and equivalence classes, computed from your app's own constraints. The same app always yields the same tests |
| **AI-written flow tests** | For what no constraint can express: completing a checkout, a multi-step wizard |
| **Missing-test discovery** | Finds what is untested from three directions — rules with no test, forms never submitted, requirements with no passing test |
| **Instruction linting** | Flags a test that states no expected outcome, because it cannot pass or fail honestly. **Improve with AI** rewrites it against your real page |
| **Test data and placeholders** | `{{unique_email}}`, `{{phone}}`, `{{today}}`, `{{test_card}}` and your own named values. Fresh per run, so a registration test never collides with itself |
| **File uploads** | Say "upload a picture" and a valid PNG, PDF, text or CSV is generated in memory. Nothing is read from your disk |

### Running them

| Feature | What it means |
|---|---|
| **Real browser** | Playwright and Chromium. Handles iframes, shadow DOM, popups and new tabs, hover menus, modals, native `confirm()` dialogs |
| **Deterministic replay** | The first run is AI-driven and is compiled into a script. Every later run replays it with **zero** AI calls, in under two seconds |
| **Verified scripts** | Each new script is replayed once immediately. If it does not reproduce, it is discarded rather than trusted |
| **Self-repairing locators** | Each element is recorded with up to three spare locators verified against it, so a renamed `data-testid` is fixed with no AI call |
| **Parallel runs** | Four at a time, sharing one browser. Twelve replays finish in under four seconds. Projects with shared data run one at a time automatically |
| **Suite runs** | One press, one verdict — the unit a build reports on |
| **Action safety** | The AI may only use a fixed list of actions, and every one is validated against the live page before it runs. Off-domain navigation, typing into non-inputs and invalid dropdown values are all refused |
| **Blocked-page detection** | Says "this page shows a CAPTCHA" in plain words instead of wandering until it runs out of steps |
| **Login sessions** | Captured automatically while exploring, or recorded by hand for SSO. Re-signs in once if a session expires |
| **Flakiness control** | A failure is re-run alone before it is believed. A test that keeps wavering is quarantined — it still runs, it just stops deciding whether the suite passed |

### Judging the result

| Feature | What it means |
|---|---|
| **Judged against your app's own rules** | If the form says "At least 8 characters" and accepts `123`, that is a failure — even though nothing crashed |
| **Grounded verdicts** | A failure must state expected, actual, and the rule it was judged against. Quoted evidence has to actually be on the page |
| **App failure vs tool failure** | "Your app is broken" is kept separate from "I could not drive the browser". The second never becomes a bug report |
| **Seven assertion types** | Visible text, page text, URL, field value, **field validity** (the browser's own validation, which is not in the page), **element counts** and **ordering** |
| **Known failures** | A test that finds a bug becomes a replayable test. It turns green the day you fix the bug, and TestPilot offers to close the report |
| **Background checks** | Watches for first-party HTTP 5xx and page exceptions during every run — bugs no assertion was looking for |

### Reporting

| Feature | What it means |
|---|---|
| **Bug reports** | Steps to reproduce, expected vs actual, failing screenshot, and the rule relied on. The same defect seen twice raises a counter instead of filing a duplicate |
| **Computed coverage** | Requirement status calculated from stored links and real results, not re-judged by an AI. A requirement whose test is failing is **violated** and shown first |
| **Structural coverage** | Pages opened, forms submitted, fields used, rules checked — needs no requirements list at all |
| **Evidence** | A screenshot per step, the full Playwright trace on failure, and the exact page description the AI saw at every decision |
| **Live run view** | Steps stream in over Server-Sent Events. Click any step and the screenshot, error, AI's view and locator all follow it |
| **JUnit XML + HTML report** | For your CI system and for a human. Exit code 1 for an app failure, 2 for a tool failure |
| **Playwright export** | Any test, or the whole project, as ordinary `.spec.ts`. Adopting this does not mean being unable to leave |
| **Cost tracking** | API calls and tokens per run, with an indicative price. Replays show zero |
| **Dark mode** | Throughout, with a system-preference default |

---

## 3. Tech stack

Everything is TypeScript, in one npm workspaces monorepo. No paid services are required.

| Layer | Technology | Why |
|---|---|---|
| **Language** | TypeScript 5 | One language across browser, server and shared schema, so a type change breaks the build rather than production |
| **Dashboard** | React 18 · Vite 6 · Tailwind CSS 3 | Vite for instant reloads; Tailwind because the design tokens live in CSS variables and one class switches the whole theme |
| **Charts** | Hand-written SVG | No charting library. Three shapes were needed and a library would have added hundreds of kilobytes, its own theming and its own accessibility gaps |
| **API** | Node.js 20 · Express 4 | Small, boring, well understood |
| **Live updates** | Server-Sent Events | A run streams one way, server to browser. WebSockets would be a bidirectional solution to a unidirectional problem |
| **Browser automation** | Playwright (Chromium) | Auto-waiting, frame and shadow-DOM piercing, and traces you can replay afterwards |
| **Database** | SQLite via Prisma 6 | Zero setup — no server to install. Change one line in `schema.prisma` for PostgreSQL |
| **Validation** | Zod 3 | The AI's action schema is a Zod union, so an invalid action cannot reach the browser |
| **AI** | Any OpenAI-compatible API | Gemini free tier by default, Groq and OpenAI supported. Falls back between providers, and serves a cached reply if all of them are down |
| **Tests** | Vitest 3 | 245 tests: unit, plus end-to-end in real Chromium against the bundled demo shop with a scripted AI, so the suite needs no API key |
| **Demo target** | Express + server-rendered HTML | ShopMax, with five switchable seeded defects |

**No vendor SDKs for the AI.** Every supported provider exposes an OpenAI-compatible
`/chat/completions` endpoint, so one HTTP client covers all of them — which is also what makes
swapping providers a one-line change in `.env`.

---

## 4. Before you start

You need two things installed. Both are free.

### Node.js 20 or newer

Download the **LTS** version from [nodejs.org](https://nodejs.org). Accept all the defaults.

Check it worked — open a new terminal and run:

```bash
node --version
```

You should see `v20.something` or higher. If the command is not found, close the terminal, open a
new one, and try again (the installer needs a fresh terminal).

### An AI API key (free)

TestPilot uses Google's Gemini by default because it has a genuinely useful free tier — no credit
card, no trial period.

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with a Google account
3. Click **Create API key**
4. Copy it somewhere — you will paste it in a moment

The free tier allows roughly 500 requests a day. Exploring your app costs 1. Authoring a test costs
2 to 6. **Replaying a test costs nothing**, so day-to-day use barely touches the quota.

> You can skip the key entirely and still use the designed tests, which need no AI. You just will
> not get the AI-written flow tests.

### A terminal

- **Windows** — press Start, type `powershell`, open **Windows PowerShell**
- **macOS** — press Cmd+Space, type `terminal`
- **Linux** — you already know

Everything below is typed into that terminal.

---

## 5. Getting it running

### Step 1 — get the code

```bash
git clone https://github.com/Hassan-Sanaullah/TestPilot.git
cd TestPilot
```

If you do not have Git, download the ZIP from the GitHub page, unzip it, and `cd` into the folder
instead.

### Step 2 — install everything

```bash
npm run setup
```

This installs the dependencies, creates the database, and downloads a copy of Chromium for the
browser automation. **It takes 2–5 minutes** and prints a lot of text. That is normal.

### Step 3 — add your API key

Make a copy of the example settings file:

```bash
# Windows PowerShell
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Open the new `.env` file in any text editor (Notepad is fine) and find this line:

```ini
GEMINI_API_KEY=
```

Paste your key after the `=`, with no spaces or quotes:

```ini
GEMINI_API_KEY=AIzaSyC...your-key-here
```

Save and close.

> `.env` is where your key lives and it is **never** committed to Git — the `.gitignore` excludes
> it. Keep it that way.

### Step 4 — start it

```bash
npm run dev
```

Wait a few seconds. You will see something like:

```
[shop]   ShopMax → http://localhost:4100
[server] TestPilot API  → http://localhost:4000/api
[server] LLM profile    → free: steps via gemini (gemini-3.5-flash-lite)
[web]    ➜  Local:   http://localhost:5173/
```

### Step 5 — open it

Go to **[http://localhost:5173](http://localhost:5173)** in your browser.

That is it. To stop everything, press **Ctrl+C** in the terminal.

---

## 6. Which port is what

`npm run dev` starts three programs at once:

| Port | What it is | Do you open it? |
|---|---|---|
| **5173** | **The TestPilot dashboard** | **Yes — this is the app** |
| 4000 | The API the dashboard talks to | No |
| 4100 | **ShopMax**, a demo shop to practise on | Only if you want to look at it |

So: **http://localhost:5173**. The other two run in the background.

If a port is already taken, change `PORT` (the API) or `SHOP_PORT` in `.env`. For the dashboard,
Vite picks the next free port automatically and prints it.

---

## 7. Your first test, step by step

Use the demo shop first. It is a deliberately awkward website — cookie banner, hover menus,
modals, an iframe, a three-step checkout — and it contains **five deliberate bugs** for you to find.

### Create the project

On the Projects page, click **Add the ShopMax demo**. That fills in the URL and the test account for
you.

### Let it explore

Open the **Test cases** tab and press **Explore my app and write tests**.

TestPilot now opens a browser and walks the shop: following links, clicking through JavaScript
navigation, dismissing the cookie wall, and signing in with the test account to reach pages that do
not even exist as links when you are signed out. It takes **30–60 seconds**, once.

Then it hands you a list of draft tests. Look at the badges:

- **designed** — computed from the shop's own rules. The badge line under each one tells you
  exactly what rule it checks, quoted: *"The page states: At least 8 characters"*.
- **written by AI** — a flow, like completing a checkout.

### Add and run them

Tick a few (five or six is plenty for a first go) and press **Add and run**.

A browser window opens and you can watch it work. Each test takes a handful of seconds.

### Look at what happened

Go to the **Runs** tab. Some passed, and at least one should have failed — ShopMax's coupon
`SAVE10` is advertised as 10% off but takes 20%. Click a failed run to see why.

---

## 8. Reading a run

The run page is built around one idea: **click a step, and everything follows it.**

The list on the left is every action the test took. Select one and the panel on the right shows:

| Tab | What you see |
|---|---|
| **Screenshot** | The page at that exact moment |
| **What the AI saw** | The page as it was described to the AI — every element it could choose from. This is usually where a confusing decision becomes obvious |
| **Locator** | How the element was found, and the spare locators recorded alongside it |
| **Log** | The live log, while a run is in progress |

Use the **arrow keys** to step through. The filmstrip across the top jumps to any step; the failing
one is outlined in red.

### The three outcomes, and why the difference matters

| Badge | Meaning | What to do |
|---|---|---|
| **Passed** | The test did what it set out to do and verified the result | Nothing |
| **Failed** | **Your application misbehaved.** This becomes a bug report | Read the failing step |
| **Could not run** | TestPilot could not drive the browser — a page would not load, an element does not exist. **This says nothing about your application** | Look at the step; usually the test names something that is not there |
| **Known failure** | The test records a bug on purpose, and the bug is still there | Nothing — it turns green when you fix it |

Keeping *"your app is broken"* separate from *"my tool had a problem"* is deliberate. A tool that
blames your code for its own failures is worse than no tool, because you stop believing it.

---

## 9. Replaying, and why it matters

After a test passes once, look at it in the **Test cases** tab: it now says **deterministic**.

That means TestPilot recorded the exact steps and the exact way it found each element, so it can
repeat them without the AI. Press **Replay**:

| | First run (AI) | Replay |
|---|---|---|
| Time | a few seconds | **under 2 seconds** |
| API calls | 2–6 | **0** |
| Result | — | identical, every time |

**Replay the suite** on the Overview runs all of them, four at a time. Twelve ShopMax replays
finish in under four seconds.

Three details worth knowing:

- **A script is checked before it is trusted.** The moment one is recorded, it is replayed once. If
  the steps do not reproduce, the script is thrown away and the test stays AI-driven. A script
  nobody has ever replayed is a promise, not a test.
- **A test that found a bug becomes a test too.** It is marked a *known failure*. Replaying it
  answers one question — is the bug still there? — in seconds, and the day it passes TestPilot tells
  you the bug looks fixed and offers to close it.
- **A moved element is usually repaired for free.** Every locator is recorded with up to three
  spares verified against the same element, so renaming a `data-testid` costs nothing. The AI is
  only consulted when all of them fail, and the run says so when that happens.

---

## 10. Testing your own website

> **Only ever point TestPilot at a test, staging or local environment — never at a live site with
> real users or real data.** The tests fill in forms, submit them, and create accounts.

On the Projects page click **New project** and fill in:

| Field | What to put |
|---|---|
| **Name** | Anything you will recognise |
| **Base URL** | Where your app runs, e.g. `http://localhost:3000` |
| **Test account** | An email and password that work on it, if it has a login. TestPilot signs in to map the pages behind it |
| **Reset URL** (optional) | An endpoint that wipes test data. If you have one, TestPilot calls it before every run and runs tests one at a time so they cannot interfere |

Then press **Explore my app and write tests**, exactly as with the demo.

**About the password:** it is stored for your project and typed directly into the browser. The AI
never sees it — it types the placeholder `{{test_password}}` and the substitution happens inside the
browser. It is also stripped from every log.

If your app is behind a login TestPilot cannot work out on its own (a corporate SSO, a
two-factor prompt), use **Settings → Record a login session**: a browser opens, you sign in by hand,
and TestPilot reuses that session for every run.

---

## 11. Every screen explained

**Overview** — the state of things. How many tests replay deterministically, how long a full replay
takes, how many API calls you have spent, coverage per area of your app, and a 14-day trend. The
big button replays the whole suite.

**Test cases** — your tests. Each row shows whether it is deterministic, what rule it checks, and
its last result. Search, select several, run them together, edit instructions inline, export any
test as ordinary Playwright code.

**Runs** — the history. Filter by status, search, sort.

**Coverage** — two different answers to "how much is tested?", because most people have not written
a requirements list:

- *Requirements* — if you have a list, each requirement gets a status computed from your test
  results: **violated** (a test for it is failing — shown first, because it is the most important
  row on the page), covered, partly tested, or not tested.
- *What the suite touches* — pages opened, forms submitted, fields used, stated rules checked. This
  needs no list at all and is the number you get on day one. A form counts only if a test filled it
  in **and** submitted it.

**Missing tests** — what is not covered yet, from three directions: rules with no test, forms no
test has ever submitted, and requirements with no passing test. Each says why it is being suggested.
Accept one and it becomes a test.

**Bug reports** — steps to reproduce, expected versus actual, the failing screenshot, and the rule
it was judged against. Seeing the same bug twice raises a counter instead of filing a duplicate.
When the test starts passing again, the page offers to close it.

**Requirements** — write them, paste a list, or have TestPilot draft them from your pages.

**App map** — every page it found, every form field by field, and the rules each page states. This
is the raw material everything else is built on; worth a look to see how much it understood.

**Settings** — the test account, viewport, parallel runs, and **test data** (see below).

There is a dark theme — the toggle is at the top right.

---

## 12. Writing a test by hand

Still possible, and sometimes the right tool. Press **Write one myself**.

The only rule: **say what must be true afterwards.** A test with no expected outcome cannot pass or
fail honestly.

| | |
|---|---|
| ✗ | `Test the login` |
| ✗ | `Check that passwords work properly` |
| ✓ | `Open the login page, sign in as {{test_user}} with {{test_password}}, and verify the page then shows "Welcome back".` |
| ✓ | `Open the registration page and register with the name "Ada", the email {{unique_email}} and the password "123" in both password fields. Verify that the error "Password must be at least 8 characters." is shown and that no account is created.` |

Instructions are checked as you type, vague ones are flagged in the list, and **Improve with AI**
rewrites one against your real page.

---

## 13. Test data and placeholders

Write a placeholder and TestPilot fills it in. These need no setup:

| Placeholder | What you get |
|---|---|
| `{{unique_email}}` | An address no earlier run has used, so a registration test never collides |
| `{{unique_name}}`, `{{unique_id}}` | A fresh name, a short unique string |
| `{{phone}}` | A number in the range reserved for fiction |
| `{{today}}`, `{{tomorrow}}`, `{{future_date}}`, `{{past_date}}` | Dates, as `YYYY-MM-DD` |
| `{{adult_birth_date}}` | A birth date 30 years ago, for age checks |
| `{{test_card}}` | `4242 4242 4242 4242` — accepted by payment sandboxes, by no real processor |
| `{{test_user}}`, `{{test_password}}` | Your project's test account |

Some values cannot be invented — a coupon code, a product name, a postcode your app accepts. Put
them in **Settings → Test data** and use them by name:

```
Apply the coupon {{data.coupon}} to a $100 subtotal and verify the total is $90.00.
```

**Never put a secret in test data.** The one secret is the test account password, which is stored
separately and never shown to the AI.

To attach a file, just say so: *"upload a picture for the avatar"*. TestPilot generates a small
valid PNG, PDF, text or CSV file in memory — nothing is read from your disk, and a recorded test
still runs on a machine that has never seen this repository.

---

## 14. Running it in a build

```bash
npm run suite -- "ShopMax" --junit results.xml --report report.html
npm run suite -- <projectId> --base-url https://staging.example.test
```

The exit code separates the two things a build must tell apart:

| Code | Meaning |
|---|---|
| `0` | everything that ran passed |
| `1` | a test failed — the application misbehaved |
| `2` | a test could not run — TestPilot could not drive the browser |
| `3` | the suite could not start |

That difference is the point: a page that would not load in CI is not a regression in the code
somebody just pushed, and a build that goes red for it teaches people to ignore red builds.

- `--junit` writes XML every CI system understands.
- `--report` writes one self-contained HTML file — results, failing steps with screenshots, both
  coverage views. Print it to PDF from your browser.

You can also export the tests themselves as ordinary Playwright code and walk away:
`GET /api/projects/:id/spec`, or the **.spec.ts** button on any test.

---

## 15. When something goes wrong

| What you see | What it means |
|---|---|
| `npm: command not found` | Node.js is not installed, or the terminal needs reopening after installing it |
| `npm run setup` fails downloading Chromium | A firewall or proxy. Try `npx playwright install chromium` on its own |
| Port 5173 or 4000 already in use | Something else is using it. Change `PORT` in `.env`; Vite moves the dashboard itself and prints the new address |
| The dashboard loads but every run errors instantly | Your app is not reachable at the Base URL, or there is no API key — check **AI settings** |
| `no LLM provider configured` | `.env` is missing or the key line is empty. You can still use designed tests |
| Explore only finds one page | A single-page app behind a login. Add a test account, or record a login session |
| A test passes when it should not | The instruction states no expected outcome. Run it through the editor review |
| `budget_exceeded` | Raise the API call budget in project Settings, or simplify the test |
| "This page shows a CAPTCHA" | There is no way around one. Use an environment with it disabled, or record a login session |
| A test is **quarantined** | It failed and then passed twice in its last five runs, so it no longer decides whether the suite passed. It still runs, and is released after five stable runs |
| `429` / rate limited | The free tier's daily quota. Replays cost nothing — use those, and wait for the quota to reset |

Still stuck? The terminal running `npm run dev` prints what the engine is doing, step by step.

---

## 16. Commands

```bash
npm run setup          # first time only: install, create the database, download Chromium
npm run dev            # start everything (dashboard 5173, API 4000, demo shop 4100)

npm run dev:server     # just the API          npm run dev:web   # just the dashboard
npm test               # 245 tests: unit, plus end-to-end in real Chromium with a scripted AI
npm run typecheck      # TypeScript across the whole project
npm run build          # production build of the dashboard
npm run db:studio      # browse the database in your browser

npm run explore -- <url>                  # map any website from the command line
npm run suite -- "<project>" --junit r.xml # run a suite for a build
npm run bench -- mylabel                  # measure where a run spends its time
npm run evaluate -- --arms C,D --reps 3   # the research measurement (see below)
```

---

## 17. Project layout

```
packages/shared      the fixed action schema (zod) and shared types
packages/server      the API, the browser engine, the AI layer
  src/engine/        perception · validator · executor · runner · replay · explorer · locator
  src/ai/            design (no AI) · suite · coverage · gaps · requirements · bug reports
  src/services/      run queue · suites · verification · flakiness · reports
packages/web         the React dashboard
packages/demo-shop   ShopMax — the practice target, with five switchable seeded bugs
docs/                the plan, the specs, benchmarks and evaluation results
```

**Further reading** in `docs/`: [USAGE.md](docs/USAGE.md) is a longer walkthrough,
[V2-HARDENING.md](docs/V2-HARDENING.md) records what broke on real websites and how it was fixed,
and the three `V7-*.md` files are the design of the current version.

### Measuring it honestly

ShopMax carries five documented bugs, and they can be **switched off individually**
(`SHOP_BUGS=1,3,5`, or `none`). That matters more than any detection score: *"found 5 of 5 seeded
bugs"* is not a result on its own, because a tool that called everything broken would score the
same. So `npm run evaluate` runs against a shop with the bugs **and** a shop without them, and
reports both numbers. On the correct shop the target is **zero** reports.

Results land in `docs/evaluation/` with the limits of the measurement stated in the output itself.

---

## 18. Limits and scope

**What it does not do:** mobile or native apps, visual regression (it does not compare pixels),
accessibility auditing, performance budgets, API-level testing without a browser, anything behind a
CAPTCHA, or fixing your tests for you.

**Where it runs:** Chromium only. Test environments only — never production.

**How it sees your app:** the DOM only. No source code, no instrumentation, no production traffic.
Nothing is sent anywhere except the page structure that goes to your chosen AI provider, and your
test account's password is never part of that.

**Language:** rules declared in HTML work in any language. Rules written only in prose are parsed
with English patterns.

---

*Built as a final-year project. Converted from an earlier "Agentic Web Navigator" prototype — the
DOM-first perception and the observe-then-act loop were carried over; everything test-specific is
new.*
