# Using TestPilot

A practical walkthrough: start it, test the demo app, then point it at your own.

---

## 1. Start it

```bash
npm run dev
```

Three things come up:

| | URL | What it is |
|---|---|---|
| **Dashboard** | http://localhost:5173 | TestPilot itself — this is what you use |
| API | http://localhost:4000 | The engine. You never open this directly |
| **ShopMax** | http://localhost:4100 | The demo shop being tested. Browse it to see what the agent is up against |

First time only: `npm run setup`, then copy `.env.example` to `.env` and add a Gemini key from
https://aistudio.google.com/apikey (free, no card). Check **AI settings** in the dashboard — it
should say *reachable*.

---

## 2. The idea in one paragraph

A **project** is one web application under test. TestPilot **explores** it — walking its pages,
reading its forms and the rules they state — and from that **writes the test cases for you**. Each
run drives a real Chromium browser and records every step with a screenshot. The **coverage**
profiler then tells you which requirements your tests actually verified, **missing tests** fills
the gaps, and confirmed failures become **bug reports**.

You do not need to know anything about testing to use it.

---

## 3. Your first run — one button

1. Open http://localhost:5173 and click the **ShopMax** project.
2. **Test cases** tab → press **🔍 Explore my app and write tests**.
3. Wait 30–60 seconds. TestPilot walks the application, signs in with the test account where it
   can, and comes back with ready-made test cases — each with a title, the reason it matters, and
   the full instruction (click *Show the test* to read it).
4. Tick the ones you want and press **▶ Add and run**.
5. A browser window opens and you watch each test run. On the run page, click
   **"Show what the AI saw"** on any step to see the exact page description behind that decision.

Some of those tests **fail on purpose** — ShopMax has five deliberate bugs (see
[packages/demo-shop/README.md](../packages/demo-shop/README.md)). A failure is re-run once
automatically; if it reproduces, a **bug report** is filed with steps to reproduce and a screenshot.

### After the first pass, tests stop using the AI

When a test passes, TestPilot compiles it into a script of verified locators and the badge changes
to **⚡ deterministic**. From then on the button says **⚡ Replay**: the same steps run the same way
every time, in a few seconds, with **no AI calls at all**. That is what makes it a regression suite
rather than a demo — and it keeps you well inside the free tier.

- **⚡ Replay** — the normal way to re-run a test.
- **↻ Re-author** — let the AI drive again and record a fresh script. Use after the application has
  genuinely changed.
- **⬇ .spec.ts** — download it as an ordinary Playwright test to run in CI.

If a locator no longer matches, one AI call repairs it and the run reports *n locator(s) repaired*
so you can check it still tests what you meant. A failing **assertion** is never repaired away —
that is the bug the test exists to find.

### Testing just one thing

Below the explore button there is a box: **"or test one thing"**. Type a few words —
`password rules`, `the login`, `the checkout` — and press **✨ Write the tests**. TestPilot
proposes the cases a professional would write for that area: the main path, the negative cases,
and the boundaries people forget.

The chips underneath are not a canned list — they are generated from **your** application.

---

## 4. Writing an instruction yourself (optional)

**Write one myself** opens the full editor. Useful when you want something very specific.

**A test needs two halves: what to DO and what must be TRUE afterwards.** Without the second half
there is nothing to pass or fail against, so any behaviour counts as success.

| | |
|---|---|
| ✗ | `Test the length and type of passwords accepted` |
| ✓ | `Open the registration page and register with the name "Ada", the email {{unique_email}} and the password "123" in both password fields. Verify that the error "Password must be at least 8 characters." is shown and that no account is created.` |

Rules of thumb:

- **One scenario per test.** "Test the password rules" is three tests: too short, mismatched, valid.
- **Quote exact wording** you expect: `"An account with this email already exists."`
- **Say what should NOT happen** too, where it matters ("…and no account is created").

The editor checks your instruction **as you type** and flags problems. **✨ Improve with AI**
rewrites it using the real pages of your project. Tests with unclear instructions get a ⚠ badge.

**Placeholders** (replaced with fresh values each run, so tests never collide):

| Placeholder | Becomes |
|---|---|
| `{{unique_email}}` | `tp.m3x8f2@example.com` — a new address every run |
| `{{unique_id}}` | a unique short string |
| `{{test_user}}` | the test account of the project |
| `{{test_password}}` | its password — **never sent to the AI**; the browser fills it in |

---

## 5. The full loop — what makes this different

1. **Requirements** → write your checklist, or **✨ Propose from the pages** to have TestPilot
   draft one from the HTML (no source code needed).
2. **Test cases** → explore and run, as above.
3. **Coverage** → **⟳ Profile latest runs**. Each requirement becomes *covered*, *partial* or
   *uncovered*, with the evidence cited. A requirement is only *covered* when a **passed
   assertion** proves it — walking a flow without checking the outcome is *partial*.
4. **Missing tests** → **✨ Find missing tests**: tests for everything uncovered, de-duplicated
   against what you have, with anything needing non-existent UI marked *infeasible*.
   Press **✓ Accept & run**.
5. **Bug reports** → open one, **⬇ Markdown** to export it.

Step 4 finding a real bug that none of your hand-written tests covered is the central claim of the
project. On ShopMax it reliably does.

---

## 6. The App map tab

What TestPilot learned by walking your application: every page, its kind (auth, cart, checkout,
listing, admin…), each form field by field with its type and rule, and the sentences the page
states about itself ("At least 8 characters", "Quantity: minimum 1"). Pages behind a login are
marked with a padlock.

This is exactly what the test generator reads, so when a generated test looks odd, this tab
explains why. **🔍 Explore again** re-scans after you change the app.

---

## 7. Pointing it at your own application

**Projects → + New project.**

| Field | What to put |
|---|---|
| **Base URL** | Your app on a **test environment**. Never production — tests create and delete data |
| **Reset URL** | Optional. An endpoint TestPilot POSTs before each run to restore clean data |
| **Test account** | A login the tests may use. The password is stored locally and never reaches the AI |

Giving it a test account matters more than it sounds: the explorer **signs in** and maps the
logged-in half of the app, which is usually where the interesting behaviour lives and which is
often not even linked to when signed out.

Then in the **Settings** tab of that project:

- **Record a login session** — for SSO, two-factor, or anything the explorer cannot script. A
  browser opens, you sign in by hand, click save, and every later run reuses that session.
- **Additional allowed domains** — tests may always visit the domain of your base URL and its
  subdomains. Add anything else they genuinely need, such as an SSO or payment sandbox.
- **Viewport**, **max actions per run**, **LLM call budget**, and how to answer `confirm()` dialogs.

### Checking a site from the command line

```
npm run explore -- https://example.com
npm run explore -- https://example.com user@example.com yourpassword
```

Prints the map without creating a project — handy for seeing how TestPilot views a site first.

---

## 8. Running the whole suite

Press **Replay the suite** on the Overview. Tests run four at a time and share one browser, so
twelve replays of the ShopMax tests finish in under four seconds. A project with a reset hook runs
one test at a time regardless, because the hook wipes the data the other tests are using; if your
tests share data for some other reason, turn off *Run tests at the same time* in Settings.

The result is a **suite run**: one row with one verdict, which is what a build needs.

### From a terminal, for a build

```bash
npm run suite -- "ShopMax" --junit results.xml --report report.html
npm run suite -- <projectId> --base-url https://staging.example.test
```

The exit code separates the two things a build has to tell apart:

| Code | Meaning |
|---|---|
| 0 | every test that ran passed |
| 1 | a test failed — the application misbehaved |
| 2 | a test could not run — TestPilot could not drive the browser |
| 3 | the suite could not start (bad arguments, nothing authored yet) |

That difference matters: a page that would not load in CI is not a regression in the code somebody
just pushed, and a build that goes red for it teaches people to ignore red builds.

`--report` writes one self-contained HTML file: the result per test, the failing step with its
screenshot, and both coverage views. It prints to PDF from a browser, which is what to attach to a
report.

---

## 9. Attaching a file in a test

Say so in the instruction: *"upload a picture for the avatar"*. TestPilot generates a small, valid
file in memory — a PNG, a PDF, a text file or a CSV — so a compiled test still runs on a machine
that has never seen this repository. File inputs are usually hidden behind a styled button; that
does not matter, and nothing is read from your disk.

---

## 10. When a test cannot run

Three outcomes look similar and mean different things:

| What you see | What it means | What to do |
|---|---|---|
| **Failed** | The application did not do what it should. This is a bug report. | Read the failing step |
| **Could not run** | TestPilot could not drive the browser: a page would not load, an element does not exist, a session expired. **Not** a defect in your application. | Look at the step; often the instruction names something that is not there |
| **Known failure** | The test records a defect on purpose and the defect is still there. | Nothing — it will turn green when the bug is fixed |

If a page shows a CAPTCHA or a bot wall, TestPilot says so in words rather than wandering until it
runs out of steps. There is no way around those: use a test environment with the challenge
disabled, or record a login session.

---

## 11. Test data

Some values cannot be invented. A coupon code, a product name, a postcode your application accepts
— TestPilot cannot guess those, and a test that types a made-up one tests the error path by
accident.

Put them in **Settings → Test data** and use them by name in an instruction:

```
Apply the coupon {{data.coupon}} to a $100 subtotal and verify the total is $90.00.
```

Generated values need no setup: `{{unique_email}}`, `{{unique_name}}`, `{{phone}}`, `{{today}}`,
`{{tomorrow}}`, `{{future_date}}`, `{{past_date}}`, `{{adult_birth_date}}`, `{{test_card}}`. Each is
fresh per run, so a registration test never collides with an earlier one.

Never put a secret in test data. The one secret is the test account's password: it is typed as
`{{test_password}}` and substituted inside the browser, so the AI never sees it.

---

## 12. Things worth knowing

- **Free-tier limits.** Exploring costs 1 AI call; authoring a test costs roughly 2–6 now that the
  model can plan several actions at once. Replaying costs **zero**. The free Gemini Flash-Lite tier
  allows about 500 calls a day, and each run shows what it used.
- **Designed tests need no API key at all.** They are computed from the rules your application
  states about itself, so if you have no key you still get a suite.
- **Speed.** Exploring takes 30–60s, once. Authoring a test takes a few seconds; replaying it takes
  well under two.
- **A failing test is not a broken tool.** Read the step where it failed — the screenshot and the
  "what the AI saw" panel usually make the cause obvious in seconds.
- **Signing in happens once.** The explorer keeps the session, and a test that needs to be signed
  in starts from it instead of spending its first five steps logging in.
- `HEADLESS=1` in `.env` hides the browser window. Suite runs are always headless.

---

## 13. If something goes wrong

| Symptom | Likely cause |
|---|---|
| Every run errors immediately | App not reachable at the Base URL, or no API key — check **AI settings** |
| Explore finds only one page | A single-page app behind a login wall. Add a test account, or record a login session |
| Test passes but should not | The instruction states no expected outcome. Run it through the editor review |
| "blocked: … is covering it" | A cookie banner or modal. The agent normally dismisses it on the next step |
| Run ends with `budget_exceeded` | Raise the LLM call budget in project Settings, or simplify the test |
| Run ends at the step limit | The instruction is too broad — split it |
| "This page shows a CAPTCHA" | There is no way around it. Use an environment with the challenge disabled, or record a login session |
| "the saved session has expired and signing in again failed" | The test account's password changed, or the sign-in form moved. Check Settings |
| A test is marked **quarantined** | It failed and then passed twice in its last five runs. It still runs; it just no longer decides whether the suite passed. It is released after five stable runs |
| Coverage says a requirement is **violated** | A test for it is failing because the application does not satisfy it. That is the most important row on the page |
| "The recorded steps did not replay" | The compiled script did not reproduce, so it was discarded and the test stays AI-driven. Usually the page is not deterministic — a live clock, a random banner |
