/**
 * Compiling a passing AI run into a deterministic script, and rendering that
 * script as a standalone Playwright spec for CI.
 */
import type { Action, ElementRef, ScriptStep, TestScript } from '@testpilot/shared'
import { describeCandidate } from '@testpilot/shared'
import { json } from '../db'
import { placeholderEntries, type PlaceholderValues } from './placeholders'

/**
 * Put the placeholders back.
 *
 * During a run the model sees real values, so it types "standard_user" or the
 * generated address literally. Freezing those into the script would tie the
 * test to one account and one environment — and a registration test would
 * re-use the same "unique" email on every replay and fail the second time.
 * Mapping the literals back to their tokens keeps a compiled test portable and
 * gives it fresh data on each run.
 */
function abstractValues(text: string, values?: PlaceholderValues): string {
  if (!values) return text
  // The password is absent by construction: the model types the placeholder and
  // the executor substitutes it in the browser, so it was never in the step.
  const pairs = placeholderEntries(values)
    .filter(([name]) => name !== 'test_password')
    .map(([name, value]) => [value, `{{${name}}}`] as [string, string])
  let out = text
  // Longest first, so a value contained inside another is not half-replaced.
  for (const [value, token] of pairs.sort((a, b) => b[0].length - a[0].length)) {
    // Short values would match by accident: a date fragment, a single digit.
    if (value && value.length >= 4) out = out.split(value).join(token)
  }
  return out
}

const STRING_FIELDS = ['text', 'value', 'url', 'contains', 'forText'] as const

interface StepRow {
  index: number
  action: string
  thought: string
  status: string
  locator: string | null
}

export interface CompileOptions {
  /**
   * Compile a run that ended on a FAILED assertion into a known-failing
   * script. Without this, the most valuable tests in a suite — the ones that
   * found something — stay AI-driven forever and can never be replayed to
   * check whether the defect was fixed.
   */
  allowFailingAssertion?: boolean
}

/**
 * Build a script from the steps of a run. Only steps that actually succeeded
 * are included, and a step that targeted an element without yielding a verified
 * locator makes the run non-replayable — better to keep driving with the AI
 * than to ship a script that silently acts on the wrong thing.
 */
export function compileScript(runId: string, rows: StepRow[], values?: PlaceholderValues, opts: CompileOptions = {}): TestScript | null {
  const steps: ScriptStep[] = []
  let failingStep: number | undefined
  for (const row of rows) {
    if (row.status !== 'ok') {
      // The one tolerated failure: a final assertion that the application did
      // not satisfy. Everything before it must still have worked, or we would
      // be recording a test that cannot even reach the interesting step.
      const failed = json<Action | null>(row.action, null)
      const isFailedAssertion = Boolean(opts.allowFailingAssertion && failed && String(failed.type).startsWith('assert'))
      if (!isFailedAssertion) return null
      const target = row.locator ? json<ElementRef | null>(row.locator, null) : null
      const needsElement = 'index' in failed! && (failed as { index?: number }).index !== undefined
      if (needsElement && !target) return null
      const generalised: Record<string, unknown> = { ...(failed as unknown as Record<string, unknown>) }
      delete generalised.index
      for (const f of STRING_FIELDS) {
        if (typeof generalised[f] === 'string') generalised[f] = abstractValues(generalised[f] as string, values)
      }
      steps.push({
        index: steps.length + 1,
        action: generalised,
        ...(target ? { target } : {}),
        ...(row.thought ? { note: row.thought.slice(0, 200) } : {}),
      })
      failingStep = steps.length
      break
    }
    const action = json<Action | null>(row.action, null)
    if (!action) return null
    if (action.type === 'finish') break
    // Read-only helpers the model used to orient itself are not part of the test.
    if (action.type === 'find' || action.type === 'extract') continue

    const target = row.locator ? json<ElementRef | null>(row.locator, null) : null
    // `switchTab`'s index names a TAB, not an element: it is part of the test
    // and must survive compilation. Everything else addresses an element by an
    // index that is only meaningful within the observation it came from, so
    // that index is dropped and the verified locator takes its place.
    const addressesElement = action.type !== 'switchTab'
    const needsElement = addressesElement && 'index' in action && action.index !== undefined
    if (needsElement && !target) return null

    const generalised: Record<string, unknown> = { ...(action as Record<string, unknown>) }
    if (addressesElement) delete generalised.index
    for (const f of STRING_FIELDS) {
      if (typeof generalised[f] === 'string') generalised[f] = abstractValues(generalised[f] as string, values)
    }
    steps.push({
      index: steps.length + 1,
      action: generalised,
      ...(target ? { target } : {}),
      ...(row.thought ? { note: row.thought.slice(0, 200) } : {}),
    })
  }

  // A script with no assertion proves nothing.
  if (!steps.some((s) => String(s.action.type).startsWith('assert'))) return null
  if (steps.length === 0) return null

  return {
    version: 1,
    steps,
    compiledFrom: runId,
    compiledAt: new Date().toISOString(),
    ...(failingStep !== undefined ? { expectation: 'known-failing' as const, failingStep } : { expectation: 'pass' as const }),
  }
}

/**
 * Render one compiled script as the body of a Playwright test.
 *
 * A script that switches tabs cannot address `page` throughout, because after
 * the switch the test is driving a different one. Such a script gets a local
 * `tab` that `switchTab` reassigns — exactly as replay does. Scripts that never
 * switch (nearly all of them) address `page` directly, which reads better.
 */
export function specBody(baseUrl: string, script: TestScript, indent = '  '): string {
  const lines: string[] = []
  const usesTabs = script.steps.some((s) => String((s.action as { type?: unknown }).type) === 'switchTab')
  const p = usesTabs ? 'tab' : 'page'
  const out = (line: string) => lines.push(indent + line)

  if (usesTabs) out(`let ${p} = page`)
  out(`await ${p}.goto(${JSON.stringify(baseUrl)})`)

  for (const s of script.steps) {
    const a = s.action as Record<string, unknown>
    const type = String(a.type)
    const el = s.target ? `${p}.${describeCandidate(s.target.candidate)}${s.target.nth !== undefined ? `.nth(${s.target.nth})` : '.first()'}` : ''
    if (s.note) out(`// ${s.note.replace(/\s+/g, ' ')}`)

    switch (type) {
      case 'navigate':
        out(`await ${p}.goto(${JSON.stringify(a.url)})`)
        break
      case 'goBack':
        out(`await ${p}.goBack()`)
        break
      case 'click':
        out(`await ${el}.click()`)
        break
      case 'type':
        out(`await ${el}.fill(${JSON.stringify(a.text)})`)
        if (a.submit) out(`await ${el}.press('Enter')`)
        break
      case 'select':
        out(`await ${el}.selectOption(${JSON.stringify(a.value)})`)
        break
      case 'hover':
        out(`await ${el}.hover()`)
        break
      case 'upload':
        out(`await ${el}.setInputFiles(${JSON.stringify(String(a.path ?? 'fixture.png'))})`)
        break
      case 'pressKey':
        out(s.target ? `await ${el}.press(${JSON.stringify(a.key)})` : `await ${p}.keyboard.press(${JSON.stringify(a.key)})`)
        break
      case 'scroll':
        out(s.target ? `await ${el}.scrollIntoViewIfNeeded()` : `await ${p}.mouse.wheel(0, 600)`)
        break
      case 'switchTab':
        // A popup is already open by this point; take it from the context.
        out(`await ${p}.waitForTimeout(250)`)
        out(`${p} = ${p}.context().pages()[${Number(a.index) || 0}]`)
        out(`await ${p}.bringToFront()`)
        break
      case 'wait':
        out(a.forText ? `await expect(${p}.getByText(${JSON.stringify(a.forText)})).toBeVisible()` : `await ${p}.waitForTimeout(${Number(a.ms) || 1000})`)
        break
      case 'assertVisible':
        out(s.target ? `await expect(${el}).toBeVisible()` : `await expect(${p}.getByText(${JSON.stringify(a.text)})).toBeVisible()`)
        break
      case 'assertText':
        if (s.target) out(`await expect(${el}).${a.absent ? 'not.' : ''}toContainText(${JSON.stringify(a.text)})`)
        else out(`await expect(${p}.locator('body')).${a.absent ? 'not.' : ''}toContainText(${JSON.stringify(a.text)})`)
        break
      case 'assertUrl':
        out(`await expect(${p}).toHaveURL(new RegExp(${JSON.stringify(escapeRe(String(a.contains)))}))`)
        break
      case 'assertValue':
        out(`await expect(${el}).toHaveValue(new RegExp(${JSON.stringify(escapeRe(String(a.text)))}, 'i'))`)
        break
      case 'assertValidation': {
        // The browser blocks the submission; the message is on the element.
        const want = a.valid === true
        out(`await expect(${el}).toHaveJSProperty('validity.valid', ${want})`)
        if (!want && typeof a.message === 'string' && a.message) {
          out(`await expect(${el}).toHaveJSProperty('validationMessage', expect.stringContaining(${JSON.stringify(a.message)}))`)
        }
        break
      }
      case 'assertCount': {
        const target = s.target ? el : `${p}.getByText(${JSON.stringify(String(a.text ?? ''))})`
        const n = Number(a.count) || 0
        if (a.comparison === 'atLeast') out(`expect(await ${target}.count()).toBeGreaterThanOrEqual(${n})`)
        else if (a.comparison === 'atMost') out(`expect(await ${target}.count()).toBeLessThanOrEqual(${n})`)
        else out(`await expect(${target}).toHaveCount(${n})`)
        break
      }
      case 'assertOrder':
        out(`// order check: ${String(a.direction ?? 'ascending')} by ${JSON.stringify(a.selector ?? '')} — see the TestPilot run for the values compared`)
        break
      default:
        out(`// unsupported in export: ${type}`)
    }
  }
  return lines.join('\n')
}

const SPEC_HEADER = `import { expect, test } from '@playwright/test'`

/** Render one script as a standalone runnable Playwright test file. */
export function toPlaywrightSpec(title: string, baseUrl: string, script: TestScript): string {
  return [
    SPEC_HEADER,
    ``,
    `// Generated by TestPilot from run ${script.compiledFrom} on ${script.compiledAt}.`,
    `// Authored by AI, executed deterministically — edit freely, it is ordinary Playwright.`,
    ``,
    `test(${JSON.stringify(title)}, async ({ page }) => {`,
    specBody(baseUrl, script),
    `})`,
    ``,
  ].join('\n')
}

/** Render every compiled test of a project as one spec file for a build. */
export function toProjectSpec(projectName: string, baseUrl: string, cases: { title: string; script: TestScript; expectation?: string }[]): string {
  const lines: string[] = [SPEC_HEADER, ``, `// Generated by TestPilot on ${new Date().toISOString()}.`, ``, `test.describe(${JSON.stringify(projectName)}, () => {`]
  for (const c of cases) {
    // A known-failing test documents an open bug: it must not break the build,
    // and when it starts passing Playwright says so instead of staying silent.
    if (c.expectation === 'known-failing') lines.push(`  test.fail(${JSON.stringify(c.title)}, async ({ page }) => {`)
    else lines.push(`  test(${JSON.stringify(c.title)}, async ({ page }) => {`)
    lines.push(specBody(baseUrl, c.script, '    '))
    lines.push(`  })`, ``)
  }
  lines.push(`})`, ``)
  return lines.join('\n')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
