# V7 — Testing logic spec

The third V7 document. [The plan](V7-FINAL-PRODUCT-PLAN.md) is the overview and
[the implementation spec](V7-IMPLEMENTATION-SPEC.md) covers speed, capabilities, product features
and the interface. **This file covers the testing itself**: how tests are designed, how a verdict is
reached, what counts as evidence, how coverage and gaps are computed, and how the result is made
trustworthy.

> **Implemented.** This specification was executed on 23 November 2026. Where the approach
> described here turned out to be wrong in practice, the code follows what works and the departure
> is noted in the "V7" section of [V2-HARDENING.md](V2-HARDENING.md) — the clearest example being
> the settle design, which cannot see a change that has not started yet and therefore has to be
> armed *before* the action rather than after it.

Read section 0.2 of the implementation spec first; its ground rules apply here too.
Task ids in this file start with `L` so they do not collide with the `T` tasks.

---

## 1. What is wrong with the testing logic today

Found by reading `ai/suite.ts`, `ai/coverage.ts`, `ai/gaps.ts`, `ai/gapFilter.ts`, `ai/lint.ts`,
`ai/requirements.ts`, `engine/inventory.ts`, `engine/placeholders.ts`, the explorer's extraction
script, the runner, the validator and the script compiler.

| # | Weakness | Evidence in the code | Why it matters |
|---|---|---|---|
| 1 | **A test that finds a bug never becomes a script.** | `runner.ts` compiles only when `outcome.status === 'passed'`; `compileScript` returns null if any step is not `ok` | The most valuable tests in the suite stay AI-driven forever: slow, costly, and able to flip verdict between runs. Nobody can replay "the coupon test" after a fix and watch it turn green |
| 2 | **Test design is one free-form model call.** | `generateTests` sends the app map to `llm.reason` with `SUITE_SYSTEM` and takes what comes back | No systematic technique. Whether the 7-character boundary gets tested depends on the model's mood. Not repeatable, not explainable, hard to defend in a thesis |
| 3 | **The explorer captures exact constraints and nobody computes with them.** | `EXTRACT_JS` reads `minLength`, `maxLength`, `min`, `max`, `pattern`, `required`, `type=email`, select options; they are only pasted into a prompt as text | Boundary values can be derived exactly and for free |
| 4 | **The model cannot see what changed on the page.** | `renderObservation` lists interactive elements only. Error messages, totals, confirmations and headings are plain text and appear nowhere unless the model spends a step on `extract` | The model guesses the wording of the message it is supposed to verify. A wrong guess is a failed assertion, which is reported as an application bug |
| 5 | **`finish(fail)` is trusted without evidence.** | `runner.ts`: `finish` with verdict `fail` sets `failureKind: 'app'` unconditionally | "I could not find the button" and "the total is wrong" are both filed as bugs |
| 6 | **Browser-native validation is invisible.** | No assertion reads `validity` or `validationMessage` | On most real forms, an empty required field or a bad email is blocked by the browser with a bubble that is not in the DOM. A negative test has nothing to assert on and either fails falsely or passes falsely |
| 7 | **Text assertions are whole-page, case-insensitive substring.** | `executor.ts` `assertText` reads `document.body.innerText` of every frame | `assertText "10"` passes on almost any page. Non-interactive text has no index, so it cannot be scoped |
| 8 | **Nothing can be counted.** | No count assertion | Search, filter and pagination tests — three of ShopMax's five seeded bugs live there — cannot express "every result is in this category" or "at least one result" |
| 9 | **Coverage is re-judged by a model every time.** | `profileCoverage` makes one `llm.reason` call over all evidence; only a guard is deterministic | The same suite can score differently on two profiles. There is no stored link between a test and a requirement |
| 10 | **A violated requirement has no status.** | Statuses are `covered / partial / uncovered` | A requirement whose test *fails because of a bug* is the most important row on the page and is indistinguishable from "partly tested" |
| 11 | **Coverage needs a requirements list to exist at all.** | `profileCoverage` throws when there are no requirements | A user with no testing experience gets no coverage figure |
| 12 | **Duplicate detection is word overlap.** | `jaccard` over tokens, threshold 0.8 | "Register with a valid email" and "Register with an invalid email" share nearly every word. Either the negative case is dropped or the threshold lets real duplicates through |
| 13 | **Feasibility is one shared token with any label.** | `checkFeasibility` | Nearly everything is "feasible" |
| 14 | **Test metadata is thrown away on save.** | `POST /testcases/bulk` stores `title` and `instruction` only; `kind` and `why` are dropped | No filtering by type, no structural coverage, no traceability |
| 15 | **Every test starts signed out at the base URL.** | Both runners `goto(project.baseUrl)` in a fresh context; a session exists only if recorded by hand | A checkout test spends its first five steps, and several model calls, signing in |
| 16 | **A compiled script is never checked.** | Compiled, stored, trusted | The saucedemo trial produced 0 of 8 working replays. That was fixed, but nothing would catch the next cause |
| 17 | **Requirements are proposed from a different crawler.** | `proposeRequirements` uses `engine/crawler.ts` (depth 1, signed out), not the app map | The proposed checklist misses everything behind the login and every stated rule |
| 18 | **Test data is two placeholders.** | `unique_email`, `unique_id` | No way to give a phone number, a date, a card number, or a product name that actually exists |
| 19 | **No free checks.** | Nothing listens for server errors or script exceptions | A test can pass while the page throws an HTTP 500 in the background |
| 20 | **ShopMax's bugs cannot be switched off.** | Hard-coded in `demo-shop/src/app.js` (lines 83, 98, 120, 469, 579) | The evaluation can measure detection but not false alarms on a correct application |

---

## 2. The model this spec builds toward

### 2.1 Three kinds of oracle, used in a fixed order

An oracle is whatever decides that an observed behaviour is wrong. The standard taxonomy
([Barr et al., *The Oracle Problem in Software Testing*, IEEE TSE 2015](https://discovery-pp.ucl.ac.uk/id/eprint/1471263))
distinguishes specified, derived and implicit oracles. TestPilot will use all three, strongest first:

1. **Specified** — the user's instruction or a requirement states the expected result.
2. **Derived from the application's own statements** — a rule the page itself declares
   (`minlength="8"`, "At least 8 characters", "10% off"). The application is judged against itself.
3. **Implicit** — things that are wrong on any site: a server error, an uncaught exception.

Every verdict records which oracle it used (`oracle: 'specified' | 'stated-rule' | 'implicit'`) and
quotes it. A bug report without a quoted oracle is not filed.

### 2.2 Two layers of test design

1. **Deterministic design** — classic black-box techniques applied to the app map by ordinary code:
   equivalence partitioning, boundary value analysis, required-field omission, format invalidation.
   The same map always yields the same designs.
2. **Model-written design** — for what cannot be computed: business flows, what a "successful
   checkout" means, wording. The model also turns each deterministic design into a readable
   instruction.

The approach of inferring a form's constraints and generating tests that invalidate them one at a
time is the one evaluated in
[FormNexus (Alian et al., 2024)](https://arxiv.org/abs/2402.00950v2). The difference here is that
constraints declared in HTML are computed exactly instead of inferred.

### 2.3 What "deterministic" has to cover

A test is only a regression test when its steps, its data and its verdict are all repeatable.
Passing tests already are. This spec extends that to failing tests, to coverage and to gap finding.

---

## 3. Data model

One migration, `testing_logic`. Schema changes:

```prisma
model TestCase {
  // existing fields stay
  kind          String   @default("happy-path")  // happy-path | negative | edge | flow
  technique     String?  // boundary | equivalence | required | format | uniqueness | flow | exploratory | user
  area          String?  // AppPage.kind of the page under test
  targetUrl     String?  // page the test is about (canonical, from the app map)
  targetForm    String?  // FormDescriptor.name or submitLabel
  targetField   String?
  designKey     String?  // stable signature, see L2.4; unique per project when set
  oracle        String?  // specified | stated-rule | implicit
  oracleText    String?  // the rule or expectation, quoted
  auth          String   @default("auto")        // auto | anonymous | signed-in
  priority      Int      @default(2)             // 1 high, 2 normal, 3 low
  expectation   String   @default("pass")        // pass | known-failing   (see L5.4)
  quarantined   Boolean  @default(false)         // see L7.2
  scriptVerifiedAt DateTime?                     // set when the verification replay agrees, see L7.1
  links         TestRequirement[]
  @@unique([projectId, designKey])
}

model TestRequirement {
  id            String      @id @default(cuid())
  testCaseId    String
  testCase      TestCase    @relation(fields: [testCaseId], references: [id], onDelete: Cascade)
  requirementId String
  requirement   Requirement @relation(fields: [requirementId], references: [id], onDelete: Cascade)
  source        String      // generated | proposed | manual
  confirmed     Boolean     @default(false)
  @@unique([testCaseId, requirementId])
}

model Requirement {
  // existing fields stay
  pageUrl   String?   // where the rule was found
  ruleText  String?   // the stated rule it came from
  links     TestRequirement[]
}

model AppPage {
  // existing fields stay
  samples   String @default("[]")   // JSON: sample item titles found on listings, see L6.5
}

model Run {
  // existing fields stay
  anomalies String @default("[]")   // JSON: implicit-oracle findings, see L5.6
  oracle    String?
  kind      String @default("normal")  // normal | verify   (verify = the check after compiling, L7.1)
  flakyCause String?                   // 'parallel' when attempt 1 failed in parallel and the solo retry passed, L7.2
}

model Step {
  // existing fields stay
  changes   String?   // JSON: text that appeared / disappeared before this step, see L5.1
}

model Project {
  // existing fields stay
  testData     String  @default("{}")  // JSON key/value fixtures, see L6.3
  autoSession  String?                 // path to an automatically captured storageState, see L6.1
  autoSessionAt DateTime?
}
```

`POST /projects/:id/testcases/bulk` and `POST /projects/:id/testcases` accept and store the new
optional fields. `DraftTest` in `ai/suite.ts` carries them through.

---

## 4. L1 — Carry test metadata end to end

Small, and everything after it depends on it.

- `DraftTest` gains `technique`, `area`, `targetUrl`, `targetForm`, `targetField`, `designKey`,
  `oracle`, `oracleText`, `auth`, `priority`, `requirementKeys: string[]`.
- The bulk route's zod `Body` gains the same optional fields; on save, create `TestRequirement` rows
  for each `requirementKeys` entry with `source: 'generated'`, `confirmed: true`.
- `GET /projects/:id/testcases` returns them.
- Gap acceptance (`POST /gaps/:id/accept`) links the new test to `gap.requirementId`.

Test: save a draft with every field, read it back, links exist.

---

## 5. L2 — Deterministic test design

New file `packages/server/src/ai/design.ts`. Pure functions, no model, no database inside the core.

### L2.1 Input

`DesignInput = { pages: DiscoveredPage[] (from AppPage rows), testUser?: string, testData: Record<string,string> }`.

The explorer must keep the machine-readable constraints instead of flattening them into `hint`
text. Extend `FormField` in `engine/explorer.ts`:

```ts
export interface FormField {
  label: string; type: string; required: boolean; hint: string; options?: string[]
  // new — copied straight from the element, undefined when absent
  minLength?: number; maxLength?: number; min?: string; max?: string; step?: string
  pattern?: string; inputMode?: string; autocomplete?: string; name?: string
}
```

Fill them in `EXTRACT_JS` beside `hintFor` (`el.minLength > 0 ? el.minLength : undefined`, and so
on). `maxLength` above 2048 or equal to -1 means "none". Existing rows without these fields keep
working; they simply produce fewer designs until the app is explored again.

Also parse numbers out of *visible* rule text when HTML declares nothing, because many sites
validate in JavaScript only:

```ts
// "At least 8 characters", "minimum of 8 characters", "8+ characters", "between 3 and 20 characters"
const MIN_LEN = /(?:at least|minimum(?: of)?|min\.?)\s*(\d{1,3})\s*(?:characters|chars|letters|digits)|(\d{1,3})\s*\+\s*(?:characters|chars)|(\d{1,3})\s*or more characters/i
const MAX_LEN = /(?:at most|maximum(?: of)?|max\.?|no more than|up to)\s*(\d{1,3})\s*(?:characters|chars|letters|digits)/i
const RANGE   = /between\s*(\d{1,3})\s*(?:and|-|to)\s*(\d{1,3})\s*(?:characters|chars)/i
```

Apply to `field.hint` first, then to page `rules` whose text contains the field's label. English
only; say so in the output (`confidence: 'declared' | 'parsed-text'`). A parsed-text constraint is
never used as the sole oracle for a bug report without the visible rule being quoted.

### L2.2 The design record

```ts
export interface TestDesign {
  designKey: string                 // L2.4
  title: string                     // deterministic, e.g. 'Password of 7 characters is rejected on "Create account"'
  kind: 'happy-path' | 'negative' | 'edge'
  technique: 'boundary' | 'equivalence' | 'required' | 'format' | 'uniqueness' | 'selection'
  pageUrl: string; area: string
  form: string                      // submitLabel or name
  field?: string
  input: Record<string, string>     // label -> value for every field of the form
  expectAccepted: boolean
  oracle: 'stated-rule'
  oracleText: string                // the constraint, quoted or rendered: 'minlength="8"' / '"At least 8 characters"'
  confidence: 'declared' | 'parsed-text'
  auth: 'anonymous' | 'signed-in'   // from AppPage.requiresAuth
  priority: 1 | 2 | 3
}
```

### L2.3 The techniques

For each page, for each form with at least one data field (skip forms where every field is a
search box or a single select: those are filters, handled by L2.6):

**Baseline valid input.** Build one valid value per field; every negative design changes exactly
one field from this baseline (single-fault assumption, the standard for boundary testing).

| Field type | Valid baseline value |
|---|---|
| `email` | `{{unique_email}}` |
| `password` | a string of length `max(minLength ?? 8, 12)` containing upper, lower, digit, symbol: `Tp!` + padding + digits. A second password field (label matches `/confirm|repeat|again|verify/i`) gets the same value |
| `tel` | `{{phone}}` |
| `number` | the midpoint of `min`..`max`, or `min`, or `1` |
| `date` | `{{future_date}}` unless label matches `/birth|dob/i` → `{{adult_birth_date}}` |
| `url` | `https://example.com` |
| `select` | first option that is not empty and does not match `/select|choose|--/i` |
| `checkbox` | checked when `required` |
| text, label matches `/first|given/i` | `Ada` ; `/last|sur|family/i` → `Lovelace`; `/name/i` → `Ada Lovelace` |
| text, label matches `/user ?name|login/i` | `tp{{unique_id}}` |
| text, label matches `/zip|post ?code/i` | `{{testData.postcode}}` or `90210` |
| text, label matches `/city/i`, `/address|street/i` | `Springfield`, `12 Test Street` |
| `pattern` present | no value is generated from a regex. If `testData` has a key equal to the field's name or label, use it; otherwise the form gets **no** designs and a note explains why |
| anything else | `Test {{unique_id}}` |

Values are clipped or padded to satisfy `minLength`/`maxLength`.

**Designs generated per field**, each as its own `TestDesign`:

| Technique | Condition | Value | Expect |
|---|---|---|---|
| required | `required` | empty | rejected |
| boundary | `minLength = n > 1` | length `n − 1` | rejected |
| boundary | `minLength = n` | length `n` | accepted |
| boundary | `maxLength = m` (JS-validated only; skip when the HTML attribute exists, because the browser will not let the value be typed) | length `m + 1` | rejected |
| boundary | number with `min` | `min − step`, then `min` | rejected, accepted |
| boundary | number with `max` | `max + step`, then `max` | rejected, accepted |
| format | `type=email` | `not-an-email`, then `a@b` (no TLD: accepted by browsers, often rejected by servers — mark `priority 3`, expectation stated as "consistent with the page's rule", not asserted as a bug) | rejected |
| format | `type=url`, `type=number` with letters | malformed value | rejected |
| equivalence | second password field | a different value from the first | rejected |
| uniqueness | a rule on the page matches `/already (exists|registered|taken|in use)/i` and the project has `testUser` | `{{test_user}}` in the email / username field | rejected |
| selection | `select` with 2–6 options | each option once, all else valid | accepted (`priority 3`) |

Plus one **happy path** per form: the baseline, accepted, `priority 1`.

The preserved length for boundary strings: keep the character classes of the baseline so that only
*length* varies. For a password, `n − 1` characters still contains an upper-case letter, a digit and
a symbol; otherwise the test conflates two rules. (ShopMax seeded bug 5 is exactly a length rule
skipped when a digit is present — a boundary value built this way finds it; a model-chosen "123"
does not.)

Caps so a large app does not explode: at most 12 designs per form, 60 per project, ordered by
priority then by `area` weight (`auth` 1, `checkout` 1, `form` 2, `cart` 2, `admin` 2, others 3).

### L2.4 The design key

```ts
designKey = sha1([canonicalPath(pageUrl), norm(form), norm(field ?? ''), technique, variant].join('|')).slice(0, 16)
// variant: 'min-1', 'min', 'max+1', 'empty', 'bad-format', 'mismatch', 'duplicate', 'valid', 'option:<value>'
```

`norm` lower-cases and collapses whitespace. `canonicalPath` is the URL shape from `shapeOf()` in
the explorer, so `/products/3` and `/products/9` share a key.

This replaces word-overlap duplicate detection for designed tests: two designs are duplicates
exactly when their keys are equal. The database enforces it (`@@unique([projectId, designKey])`).

### L2.5 From design to instruction

`renderInstruction(design): string` is a **template**, not a model call, so a designed test can be
created with no API key at all:

```
Open {pageUrl}. In the "{form}" form enter: {label} = "{value}"; … . Submit the form with "{submitLabel}".
Verify that the submission is {accepted | rejected}: {acceptance clause}.
The page states: {oracleText}.
```

Acceptance clauses:

- rejected → `the field "{field}" is reported as invalid, or an error message about it is shown, and the form is still displayed`.
- accepted → `the form is no longer displayed, or a confirmation is shown, and no error about "{field}" appears`.

These map onto the oracle actions in L5 (`assertValidation`, the page-changes list, `assertUrl`).
Passwords are written as the literal value; they are synthetic test values, not the account
password. The account password is only ever `{{test_password}}`.

Optional polish: one batched `llm.reason` call may rewrite the titles and instructions into friendlier
wording. It must return the same `designKey` for each and may not change values or the expectation;
reject and keep the template text if any quoted value is missing from the rewrite.

### L2.6 Listing designs (search, filter, sort, pagination)

For a page of kind `listing` with a search or filter form and `samples` (L6.5):

| Design | Steps | Oracle |
|---|---|---|
| search finds a known item | search for a sample title's first word | `assertCount` ≥ 1 and the sample title is visible |
| search ignores case | the same word lower-cased, then upper-cased | same result count as the original casing |
| search for nonsense | `zzqx{{unique_id}}` | `assertCount` 0 or an empty-state message |
| filter holds across pages | select a category with more than one page, go to page 2 | every item still shows the category, or the selected filter is still selected (`assertValue`) |
| sort is ordered | choose a sort option | `assertOrder` on the first N visible values (see L5.3) |

These are `oracle: 'implicit'` with a stated expectation ("a filter stays applied when changing
page"). They are `priority 2` and are written as flows; the model executes them.

### L2.7 Wiring

`generateTests` (`ai/suite.ts`) becomes:

1. Explore if needed (unchanged).
2. `designs = designTests(pages, …)`; drop those whose `designKey` already exists in the project.
3. If the user gave a topic, keep designs whose page, form, field or technique matches it
   (token match on the topic, `area` synonyms: "login/sign in" → `auth`, "checkout/payment" →
   `checkout`), and still call the model for that topic.
4. Call the model as today for flows, with the list of designed titles added under
   "ALREADY DESIGNED — do not repeat".
5. Return both, designed first, each marked `source: 'designed' | 'model'`.

If no provider is configured, steps 3–4 are skipped and the user still gets a suite.

### L2.8 Tests for L2

Unit tests on fixtures, no browser:

- A registration form with `minlength=8` password → designs for 7 (rejected), 8 (accepted), empty,
  mismatch, happy path; the 7-character value contains upper, lower, digit and symbol.
- The same form with the rule only in visible text ("At least 8 characters") → the same designs,
  `confidence: 'parsed-text'`.
- A number field `min=1 max=10` → 0, 1, 10, 11.
- A field with `pattern` and no `testData` → zero designs for that form and a note.
- Same input twice → identical output including keys (determinism).
- Caps respected.
- Integration: explore ShopMax, design, the set includes the registration boundary and required
  cases; saving twice creates no duplicates.

---

## 6. L5 — Oracles: making verdicts grounded

Numbered L5 to keep "design" and "oracle" tasks apart; implement after L1 and before L2's
integration test, because designed tests need these assertions.

### L5.1 Show the model what changed

New in `engine/perception.ts`: `collectText(page): Promise<string[]>`. In each frame, gather
visible leaf text (the `leafText` approach already used in the explorer: elements with no element
children, skipping script/style/inputs), plus elements with `role=alert|status`, `aria-live`,
`[aria-invalid=true]`, and the `validationMessage` of any `:invalid` field that has been touched.
Trim, collapse whitespace, drop strings shorter than 3 or longer than 200, de-duplicate, cap 400.

The runner keeps the previous set. After each observation:

```ts
const added = now.filter((t) => !prev.has(t)).slice(0, 12)
const removed = [...prev].filter((t) => !nowSet.has(t)).slice(0, 6)
```

Rendered into the observation, after the element list, only when non-empty:

```
SINCE YOUR LAST ACTION
  appeared: "Password must be at least 8 characters." · "1 error"
  disappeared: "Create your account"
ALERTS ON THE PAGE: "Password must be at least 8 characters."
```

On a URL change, `appeared` is limited to alerts, headings (`h1`–`h3`) and the first 8 strings,
since everything is new.

Stored on the step as `changes` JSON. Prompt rule added to `GENERATOR_SYSTEM`:
"When you verify a message, quote it exactly as it appears under SINCE YOUR LAST ACTION or
ALERTS. Never assert wording you have not seen."

Cost: one extra `evaluate` per observation, measured by the benchmark; expected a few milliseconds.

### L5.2 `assertValidation`

```ts
AssertValidationAction = z.object({
  type: z.literal('assertValidation'),
  index,
  valid: z.boolean().describe('false = the browser or the page reports this field as invalid'),
  message: z.string().optional().describe('substring of the validation message, when one is expected'),
})
```

Executor, evaluated in the page on the element:

```js
const native = typeof el.checkValidity === 'function' ? el.checkValidity() : true
const aria = el.getAttribute('aria-invalid') === 'true'
const describedBy = (el.getAttribute('aria-describedby') || '').split(/\s+/)
  .map((id) => document.getElementById(id)?.innerText || '').join(' ').trim()
return { invalid: !native || aria, message: el.validationMessage || describedBy }
```

Polls up to `ASSERT_WAIT_MS` like the other assertions. This is the assertion that makes negative
tests work on forms the browser blocks before submit. Counts as a content assertion
(`isContentAssertion`). Export: `expect(await el.evaluate(e => e.checkValidity())).toBe(valid)`.

Add to all five places listed for new actions in the implementation spec (T2.3).

### L5.3 `assertCount` and `assertOrder`

```ts
AssertCountAction = z.object({
  type: z.literal('assertCount'),
  text: z.string().min(1).optional(),         // count visible elements containing this text
  role: z.string().optional(),                // or: count elements with this role …
  nameContains: z.string().optional(),        // … whose accessible name contains this
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
  equals: z.number().int().nonnegative().optional(),
})
AssertOrderAction = z.object({
  type: z.literal('assertOrder'),
  text: z.array(z.string().min(1)).min(2).max(8),  // these texts must appear in this order on the page
})
```

- `assertCount` uses `page.getByText(text)` or `page.getByRole(role, { name })`, filtered to
  visible, summed over frames. At least one of `min`, `max`, `equals` is required (validator).
- `assertOrder` reads the page text once and checks that each string occurs after the previous
  one. It is deliberately simple: the model reads the values with `extract`, decides the order
  they *should* be in, and asserts it. Sorting logic stays out of the engine.

Both replay without a locator, and both export to Playwright (`toHaveCount`, a small inline
order check).

### L5.4 Failing runs compile, and bugs get a life cycle

**Prompt** — replace rule 6 of `GENERATOR_SYSTEM`:

```
6. When the application misbehaves, do NOT call finish(fail) straight away. Assert the outcome that
   SHOULD have happened (assertText / assertValidation / assertUrl / assertValue / assertCount).
   That assertion will fail, and the failed assertion is the bug report. Use finish(fail) only when
   the expected behaviour cannot be expressed as an assertion; then you must fill in "expected",
   "actual" and "evidence".
```

**Compiler** (`engine/script.ts`): `compileScript` gains a mode.

- Steps before the failing one must all be `ok`, as today.
- If the last executed step is a **failed assertion**, include it and return a script with
  `expectation: 'known-failing'`, `failingStep: n`. Any other failure still returns null.
- `TestScript` gains `expectation?: 'pass' | 'known-failing'` and `failingStep?: number`.

**Runner**: after a run that fails on an assertion, compile in that mode and store it; set
`TestCase.expectation = 'known-failing'`.

**Replay** of a known-failing script:

| Replay result | Meaning | Status shown | Action |
|---|---|---|---|
| Fails at the same step, same assertion | The bug is still there | `failed`, `failureKind: 'app'`, note "known failure, unchanged" | De-duplicated into the existing bug (T3.2), no model call |
| Every step passes | The bug is fixed | `passed` | `TestCase.expectation = 'pass'`; open bug gets `passingSince`; UI offers to close it |
| Fails earlier, on a non-assertion step | The app or the test changed | `error`, `failureKind: 'tool'` | No bug. Offer "Re-author" |
| Fails on a different assertion | A different defect | `failed`, `app` | New bug, by fingerprint |

The automatic re-run on failure (`afterRun`) is skipped for a known-failing replay that failed at
its recorded step: the result is deterministic and expected, so retrying proves nothing.

This closes weakness 1: the coupon test becomes a 4-second replay that turns green the day the
bug is fixed.

### L5.5 Grounded `finish(fail)`

Schema (`shared/actions.ts`):

```ts
FinishAction = z.object({
  type: z.literal('finish'),
  verdict: z.enum(['pass', 'fail', 'blocked']),
  reason: z.string().min(1),
  expected: z.string().optional(),
  actual: z.string().optional(),
  evidence: z.string().optional().describe('text visible on the page right now that shows the problem, quoted exactly'),
  rule: z.string().optional().describe('the instruction sentence or page rule this was judged against, quoted'),
})
```

- `blocked` is new: "I could not carry out the test" (element missing, page will not load, login
  refused). Outcome `status: 'error'`, `failureKind: 'tool'`. Never a bug. Prompt rule: "If you
  cannot perform the steps, finish(blocked) and say what stopped you. That is not a failure of the
  application."
- Validator, for `fail`: `expected`, `actual` and `rule` are required. `evidence`, when given, must
  be found (case-insensitive, whitespace-collapsed) in the text collected by L5.1 for the current
  page; if not, reject with "the evidence you quoted is not on the page; quote text that is
  actually visible, or use finish(blocked)". When the claim is that something is *absent*, the
  model sets `evidence` to an empty string and the validator instead requires that `expected` text
  is **not** on the page.
- A run that ends on `finish(fail)` records `oracle` from `rule`: if `rule` appears in the
  instruction text → `specified`; if it appears in the page text or the app map's rules →
  `stated-rule`; otherwise the run is still failed but flagged `oracle: 'unstated'`, and the bug
  is filed with severity capped at `low` and the note "the expectation was inferred by the model,
  not stated by the page or the test".

### L5.6 Implicit oracles

In both runners, on the context:

```ts
page.on('response', (r) => {
  if (r.status() >= 500 && isFirstParty(r.url()) && ['document', 'xhr', 'fetch'].includes(r.request().resourceType()))
    anomalies.push({ kind: 'http-5xx', url: r.url(), status: r.status(), step: currentStep })
})
page.on('pageerror', (e) => anomalies.push({ kind: 'js-error', message: e.message.slice(0, 300), step: currentStep }))
```

`isFirstParty` = same registrable domain as the base URL (reuse `registrableDomain`). Third-party
scripts are ignored; their errors are noise the user cannot fix.

Policy:

- Saved on the run as `anomalies` (cap 20). Shown on the run page.
- An `http-5xx` on a first-party document or XHR during a test that otherwise **passed** marks
  the run `passed` with a warning and files one bug, severity `medium`, titled
  "Server error (HTTP {status}) on {path} during {test}", `oracle: 'implicit'`, fingerprinted on
  method + path so it is filed once.
- `js-error` never files a bug on its own. It is listed as a warning. (A page-level exception is
  often real, but too often not actionable; the user can promote one to a bug from the run page.)
- The validation matrix must show zero implicit bugs on the sites known to be healthy, or this
  policy is tightened before release.

### L5.7 Scoped text

`assertText` keeps its current behaviour and gains `exact?: boolean` (whole visible text node
equals the string, case-sensitive). The prompt tells the model to prefer text from
"SINCE YOUR LAST ACTION", which makes page-wide substring matches far less accidental: the string
was absent before the action and present after it.

The runner upgrades substantiveness accordingly: an `assertText`/`assertVisible{text}` whose text
was already on the page **before the first state-changing action** is not substantive (same idea
as `baselineLabels` for elements, applied to text using the L5.1 baseline set).

### L5.8 Tests for L5

- `collectText` diff: a page that inserts an error on submit → the error is in `appeared`.
- `assertValidation` on an empty required input, a bad email, a valid field, an `aria-invalid`
  custom field.
- `assertCount` min/max/equals; `assertOrder` in order, out of order.
- Runner with mock: wrong coupon total → model asserts expected → assertion fails → run failed
  `app` → script compiled as known-failing → replay fails at the same step with 0 LLM calls →
  patch the shop to the correct value → replay passes and the test flips to `pass`.
- `finish(fail)` with evidence not on the page is rejected; `finish(blocked)` yields
  `failureKind: 'tool'` and no bug.
- A route returning 500 on an XHR during a passing test → one implicit bug; twice → still one.
- A third-party 500 → nothing.

---

## 7. L6 — Preconditions and test data

### L6.1 Automatic session capture

The explorer already signs in (`tryLogin`). When it succeeds:

```ts
const file = path.join(authStateDir(), `${projectId}-auto.json`)
await context.storageState({ path: file })
await prisma.project.update({ where: { id: projectId }, data: { autoSession: file, autoSessionAt: new Date() } })
```

Session choice per run, in `runner.ts` and `replay.ts`:

```
auth = testCase.auth
if auth === 'anonymous'                → no storageState
if auth === 'signed-in'                → project.storageState ?? project.autoSession ?? none
if auth === 'auto'                     → 'signed-in' when the test's targetUrl is a page with requiresAuth, else anonymous
```

A manually recorded session (`storageState`) always wins over the automatic one.

**Expiry.** If a signed-in run's first navigation lands on a URL matching the app map's `auth`
page, or the page has a visible password field, the session is stale: run `tryLogin` once in that
context, re-save the automatic session, and continue. If login fails, the run ends
`error` / `tool` with "the saved session has expired and signing in again failed".

**Tests about signing in itself** are `auth: 'anonymous'`. The design engine sets this for every
form on an `auth` page; the model-written generator is told to state it per test.

The compiled script records the `auth` mode it was authored under; replay uses the same.

### L6.2 Start where the test is

`TestCase.targetUrl`, when set, is the first page opened instead of `baseUrl`. The generator states
it; designed tests always have it. The prompt line becomes
"The browser is already on {targetUrl}." This removes one or two navigation steps and one model
call from most tests.

### L6.3 Project test data

`Project.testData` is a flat JSON object edited in Settings ("Test data — values your tests may
use"), for example `{"coupon": "SAVE10", "postcode": "90210", "product": "Laptop Pro 15"}`.

- Exposed to instructions as `{{data.coupon}}`. `makePlaceholderValues` gains a `data` map;
  `applyPublicPlaceholders` resolves `{{data.<key>}}`.
- Listed in the generator prompt so the model uses real values instead of inventing them.
- `abstractValues` in `script.ts` maps the literals back to `{{data.<key>}}` at compile time
  (longest first, same rule as the existing placeholders).
- Never put secrets here. The settings page says so; the only secret is the test password.

### L6.4 More generated placeholders

Add to `makePlaceholderValues`, all derived from the run seed so a replay is reproducible within a
run but unique across runs:

| Placeholder | Value |
|---|---|
| `{{unique_name}}` | `Test User <4 letters>` |
| `{{phone}}` | `+1 202 555 01` + two digits (the reserved fictional range) |
| `{{today}}`, `{{tomorrow}}`, `{{future_date}}` (+30 d), `{{past_date}}` (−30 d), `{{adult_birth_date}}` (−30 y) | ISO `YYYY-MM-DD`, which is what `<input type="date">` takes with `fill()` |
| `{{test_card}}` | `4242 4242 4242 4242` (the standard sandbox number) with a note that it only works against payment sandboxes |

Add each to `PLACEHOLDERS` in `shared/types.ts`, to the prompts that list them, to the lint hint
text, and to `abstractValues`.

### L6.5 Sample data from the explorer

In `EXTRACT_JS`, find repeated structures: for each element with at least 4 children sharing a tag
and class list, where each child contains a link or heading, take the heading/link text of the
first 5 children. Store on `AppPage.samples`. Rendered in the app map as
`SAMPLE ITEMS: "Laptop Pro 15" · "Aurora Desk Lamp" · …`. This is what lets a generated search test
search for something that exists.

Generic by construction: it keys on repetition, not on class names or the word "product".

### L6.6 Tests for L6

- Explore ShopMax with the test account → `autoSession` file exists; a designed test targeting
  `/orders` starts signed in and uses no login steps.
- Delete the session cookie from the file → the run re-signs-in once and passes.
- A login-form test runs anonymous even though a session exists.
- `{{data.coupon}}` resolves in the instruction, and the compiled script holds the token, not the value.
- Samples are found on ShopMax's catalogue and on saucedemo's inventory page (validation phase).

---

## 8. L7 — Trusting a compiled script

### L7.1 Verify on compile

After a script is compiled (passing or known-failing), queue one **verification replay**
immediately: `startRun(testCaseId, { mode: 'replay', verify: true })`, headless, not part of any
suite, hidden from the trend chart (`Run.kind = 'verify'`, new column, default `'normal'`).

- It reproduces the authored outcome → `TestCase.scriptVerifiedAt = now`. The badge reads
  "deterministic".
- It does not → the script is discarded (`script = null`), the reason is logged on the authoring
  run ("the recorded steps did not replay: {step, error}"), and the test stays AI-driven. Nothing
  is reported as a bug.
- A verification replay that needed healing is treated as a failure to verify: a locator that
  drifts within seconds is not stable.

Cost: one replay, no model. This is the guard that would have caught the saucedemo failures before
the user saw them.

### L7.2 Flakiness

- Retry rule stays (one re-run before a failure is believed), with one change: the retry always
  runs **alone** for its project, even when the project is parallel, so interference between
  parallel tests cannot produce a confirmed failure.
- If attempt 1 failed in parallel and attempt 2 passed alone, record `flakyCause: 'parallel'` and
  count it. Three such results in a project trigger a visible suggestion: "Tests in this project
  interfere with each other. Turn off parallel runs in Settings."
- Quarantine: a test with `flaky` on 2 of its last 5 deciding runs gets `quarantined = true`. It
  still runs; its result is shown but excluded from the suite's pass/fail and from coverage.
  Un-quarantine by hand or after 5 consecutive stable runs.

### L7.3 Tests

- A script whose locator is deliberately broken right after compile → discarded, test remains
  AI-driven, no bug.
- Flaky bookkeeping with mocked run results.

---

## 9. L8 — Coverage that does not depend on a model's opinion

### L8.1 Requirement coverage from stored links

Coverage is computed, not judged. For each requirement, over its **confirmed** linked tests that
are not quarantined, using each test's latest deciding run (`passed` or `failed` with
`failureKind: 'app'`):

| Status | Rule |
|---|---|
| `violated` | at least one linked test's latest run failed with cause `app` |
| `covered` | at least one linked test's latest run passed with a substantive assertion, and none is violated |
| `partial` | linked tests exist but none has a deciding run, or the only passes had no substantive assertion |
| `uncovered` | no confirmed link |

`violated` is new and is the first thing the coverage page shows.

New file `ai/traceability.ts`:

- `computeCoverage(projectId)` — pure database query plus the table above. No model. Runs on every
  page load and after every run; store a `CoverageProfile` only when the summary changes, so the
  history remains.
- `proposeLinks(projectId, llm)` — the model's remaining job. For tests with no links, one batched
  call: requirements and test titles+instructions in, `{ testId, requirementKeys[] }` out. Stored
  as `source: 'proposed', confirmed: false`. The UI shows them as suggestions to accept or reject.
  Cached by a hash of instruction + requirement texts, so an unchanged test is never re-sent.
- Auto-confirm a proposed link when a deterministic check agrees: the requirement has `ruleText`
  and the test's `oracleText` equals it, or the test was generated for that requirement.

`profileCoverage` (the existing model-judged version) is kept behind
`POST /projects/:id/coverage?mode=llm` for the evaluation's comparison arm, and is no longer the
default. `applyCoverageGuard` and its tests stay.

### L8.2 Structural coverage — no requirements needed

Computed from the app map and the steps of each test's latest run. New `ai/structural.ts`:

| Measure | Numerator | Denominator |
|---|---|---|
| Pages | map pages whose URL shape was visited by a step of a passing or failing test | pages in the map |
| Forms | forms where a step typed into one of its fields **and** a later step clicked its submit control or pressed Enter in it | forms in the map with at least one data field |
| Fields | fields typed into or selected | fields in those forms |
| Rules | stated rules for which a test exists with that `oracleText`, or a design with that rule, whose latest run is deciding | rules in the map (declared constraints + visible rule sentences) |

Matching a step to a form field: the step's stored locator description or the action's label
against the field label on the page with the same URL shape (normalised equality first, then
containment). Keep it deterministic and conservative; an unmatched step counts for nothing.

Shown as four bars on the coverage page and as the headline figure when a project has no
requirements. This is what gives a first-time user a coverage number.

### L8.3 Requirements from the map

`proposeRequirements` stops using `engine/crawler.ts` and reads the app map (exploring first if
there is none):

- **Deterministic**: one requirement per stated rule
  (`"{field} must be at least {n} characters on {form}"`), with `pageUrl` and `ruleText` set.
  These auto-link to the designs that test them.
- **Model**: one call with the map for behavioural requirements ("a signed-in user can place an
  order"), as today.
- De-duplicate against existing requirements by `ruleText` equality first, then the existing
  token-overlap check.

`engine/crawler.ts` then has no callers; delete it and its test.

### L8.4 Tests

- Link table drives status: pass → covered; fail(app) → violated; fail(tool) → unchanged;
  quarantined → ignored; unconfirmed link → ignored.
- Same data, computed twice → identical (the point of the change).
- Structural: a run that fills and submits the registration form counts 1 form, n fields; a run
  that only opens the page counts the page and nothing else.

---

## 10. L9 — Finding the missing tests

`generateGaps` (`ai/gaps.ts`) becomes a merge of three sources, in this order:

1. **Unrun designs.** Every `TestDesign` from L2 with no test case yet. Deterministic, already has
   an oracle. Rationale text: "No test exercises the rule '{oracleText}' on {form}."
2. **Structural gaps.** Forms never submitted, pages never visited, from L8.2. For each, a design
   if L2 can make one; otherwise a model-written test for that page (one batched call for all such
   pages, with each page's map entry as context).
3. **Requirement gaps.** Requirements that are `uncovered` or `partial`. The existing model call,
   unchanged except that it receives the app map entry of `requirement.pageUrl` when known,
   instead of the flat inventory.

Filtering:

- Designed candidates: duplicate iff `designKey` exists. No fuzzy matching.
- Model candidates: the model must return `targetUrl`, `targetForm`, `kind`, and `requirementKey`.
  Two candidates are duplicates when `(shape(targetUrl), norm(targetForm), kind, requirementKey)`
  are equal **and** token overlap is at least 0.6. Overlap alone no longer rejects anything, which
  fixes the valid/invalid-email collision.
- Feasibility: a candidate is feasible when its `targetUrl` shape is in the map and its
  `targetForm`, if given, matches a form on that page. The token test in `checkFeasibility` stays
  only as the fallback when the model gave no target.

Ordering shown to the user: `violated`-adjacent first (a requirement with a failing test and no
second test), then priority, then area weight.

Tests: on ShopMax with only a happy-path registration test, the gap list contains the 7-character
boundary design and the required-field designs, each with its rule quoted; a valid-email and an
invalid-email candidate for the same form both survive filtering.

---

## 11. L10 — Reports a build system and an examiner can read

- **JUnit XML**: `GET /suite-runs/:id/junit` and `--junit <file>` on the suite command.
  One `<testcase>` per test; a failure carries the failing step, expected, actual and the oracle;
  a tool failure is `<error>`, not `<failure>`; a quarantined test is `<skipped>`.
- **HTML report**: `GET /suite-runs/:id/report` — one self-contained file (inline CSS, screenshots
  as relative links into the evidence folder, or embedded when `?embed=1`): summary, per-test
  result, failing step with its screenshot, bug links, both coverage views. Printable to PDF from
  the browser. This is the artefact to attach to the thesis.

---

## 12. L11 — Evaluation, upgraded

Extends Phase 6 of the implementation spec.

### L11.1 Switchable seeded bugs

`createShopApp({ bugs })` in `packages/demo-shop/src/app.js`, where `bugs` is a set of ids 1–5,
default all five (so nothing else changes), also settable with `SHOP_BUGS=1,3,5` or `SHOP_BUGS=none`
in `server.js`. Each seeded branch becomes `if (bugs.has(n)) { buggy } else { correct }`.
The correct behaviour for each is already described in the demo-shop README.

### L11.2 What is measured

Run every arm against **two** shops: all bugs on, and all bugs off.

| Measure | From |
|---|---|
| Detection (sensitivity) | seeded bugs reported ÷ 5, bugs-on shop |
| False alarms (specificity) | bug reports filed against the bugs-off shop. The target is zero |
| Bug yield per test, per model call, per minute | counts |
| Determinism | replay each compiled test 5 times; proportion with identical verdicts |
| Cost | model calls and tokens per arm |

### L11.3 Arms

| Arm | Test source |
|---|---|
| A | model-written suite only (today's generator) |
| B | A + model-written gap tests (the original claim) |
| C | deterministic designs only (L2), no model for design |
| D | C + model flows + structural and requirement gaps (the full V7 pipeline) |

And two ablations on arm D: without the page-changes list (L5.1), and without the grounded-finish
rule (L5.5). These show whether the oracle work reduces false alarms, which is the claim it exists
to support.

Three repetitions each. Report mean and range. State the limits in the output: one application,
five seeded bugs, a free-tier model.

---

## 13. Order of work, merged with the implementation spec

| Step | Tasks | Depends on |
|---|---|---|
| 1 | T0 baseline and benchmark | — |
| 2 | T1 replay and suite speed | 1 |
| 3 | **L1** metadata, schema migration `testing_logic` | 1 |
| 4 | **L5.1–L5.3, L5.7** page changes, new assertions | 3 |
| 5 | T2.1 batching, T2.3–T2.5 upload, checked state, blockers | 2, 4 (same files: schema, validator, executor, prompts — do them together) |
| 6 | **L5.4–L5.6** failing scripts, grounded finish, implicit oracles | 4, T3.2 bug de-duplication |
| 7 | **L6** sessions, start URL, test data, placeholders, samples | 3 |
| 8 | **L2** design engine, wired into the generator | 3, 4, 7 |
| 9 | **L7** verify-on-compile, flakiness | 2, 6 |
| 10 | T3 suite runs, CLI, cost | 2 |
| 11 | **L8** computed coverage, structural coverage, requirements from the map | 3, 8 |
| 12 | **L9** gap finding | 8, 11 |
| 13 | **L10** reports | 10, 11 |
| 14 | T4 interface (now including: design source and oracle on each test, `violated` status, structural bars, known-failing badge, link suggestions, test data editor) | 3–13 |
| 15 | T5 validation on real sites | all engine work |
| 16 | **L11** evaluation | 15 |
| 17 | T7 documentation | all |

Schema changes from both specs can share migrations if done together, but keep them in separate
commits of work so a failure is easy to locate.

---

## 14. Interface additions this spec requires

For Phase 4 of the implementation spec; the mock-ups predate these.

- **Test list**: a "designed" or "written by AI" or "yours" tag; the technique in plain words
  ("boundary: one below the minimum"); the rule it checks, quoted; a "known failure" badge for
  `expectation: known-failing`; a "quarantined" badge.
- **Draft cards**: show the oracle line ("The page states: At least 8 characters").
- **Run page**: the "SINCE YOUR LAST ACTION" list per step; an "Oracle" line under the verdict;
  an "Anomalies" tab for implicit findings.
- **Coverage page**: `violated` first, in the failure colour with an icon and the word; the four
  structural bars; link suggestions with accept and reject.
- **Bug page**: oracle kind and quoted rule; occurrences; "passes now — close?".
- **Settings**: test data editor; the automatic session's age and a "sign in again" button.

Words to use with a non-tester: "rule the page states" not "oracle"; "one below the minimum" not
"BVA min−1"; "known failure" not "expected-fail".

---

## 15. Risks and limits

| Risk | Mitigation |
|---|---|
| A designed negative test submits a real form and creates junk data | Tests run only against test environments (existing rule); unique placeholders; the reset hook. The design engine never targets forms whose submit label matches the explorer's destructive list |
| A rule parsed from English text is wrong | `confidence: 'parsed-text'`; the visible sentence is quoted in the bug; severity capped at `medium` |
| A site validates more loosely than its HTML declares on purpose | That is still a discrepancy between what the page states and what it does; report it as such, with the rule quoted, and let the user close it |
| The page-changes list misses text rendered in canvas or images | Falls back to today's behaviour (`extract`, assertions that poll) |
| Implicit oracles file noise | Only first-party HTTP 5xx files a bug; the validation matrix must show zero on healthy sites before release |
| Known-failing scripts hide a regression in an earlier step | A failure before the recorded step is reported as a tool failure with "Re-author", never as "known failure" |
| Automatic sessions expire mid-suite | One re-login per run, then a clear tool failure |
| The design engine produces many low-value tests | Caps, priorities, and the user reviews drafts before they are added |
| Non-English sites | HTML-declared constraints work in any language. Text-parsed rules and the instruction linter are English-only; say so in the README |

What this still does not do: visual checks, accessibility audits, performance budgets, API-level
tests, multi-user scenarios, anything behind a CAPTCHA.

---

## 16. Sources

- Barr, Harman, McMinn, Shahbaz, Yoo — [The Oracle Problem in Software Testing: A Survey](https://discovery-pp.ucl.ac.uk/id/eprint/1471263), IEEE TSE 41(5), 2015. The specified / derived / implicit taxonomy used in section 2.1. The category summaries were read from a [secondary source](https://en.wikipedia.org/wiki/Test_oracle), not the paper itself.
- Alian, Nashid, Shahbandeh, Mesbah — [Semantic Constraint Inference for Web Form Test Generation](https://arxiv.org/abs/2402.00950v2) (FormNexus), 2024. Infers form constraints and generates tests that invalidate them, refining on submission feedback. Only the abstract-level description was read.
- Guo, Li, Tsuchiya — [Boundary Value Test Input Generation Using Prompt Engineering with LLMs](https://arxiv.org/abs/2501.14465v1), 2025. Reports that models handle common boundaries and miss less common ones, which is the reason section 5 computes boundaries instead of asking for them. Abstract-level only.
