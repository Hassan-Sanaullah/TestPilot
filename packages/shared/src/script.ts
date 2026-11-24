/**
 * Compiled test scripts.
 *
 * Research on web agents is blunt about this: frontier agents succeed on
 * roughly 60–70% of tasks on real websites. An agent that re-drives the browser
 * on every run therefore injects its own ~30% failure rate into your results,
 * and a suite whose failures are mostly agent error is useless as a regression
 * signal.
 *
 * So the AI is used to AUTHOR a test once, and the result is compiled into a
 * deterministic script of resilient locators. Re-runs replay that script with
 * no model in the loop: repeatable, free, and fast. The AI returns only to
 * REPAIR a locator that has drifted — and when it does, it says so.
 */

/** How to find an element, in Playwright's own order of preference. */
export type LocatorCandidate =
  | { by: 'testId'; value: string }
  | { by: 'role'; role: string; name?: string }
  | { by: 'label'; value: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; value: string }
  | { by: 'css'; value: string }

/** A locator plus how to disambiguate if it matches more than one element. */
export interface ElementRef {
  candidate: LocatorCandidate
  /** index to use when the candidate matches several elements */
  nth?: number
  /** what this element looked like when recorded, for healing and for humans */
  description: string
  /**
   * Other locators that were ALSO verified against this same element when it
   * was recorded. If a `data-testid` is renamed, the role-and-name locator
   * still finds the button, and the repair costs nothing instead of a model
   * call. Scripts compiled before this existed simply have none.
   */
  alternates?: { candidate: LocatorCandidate; nth?: number }[]
}

export interface ScriptStep {
  index: number
  /** the original action, minus the observation-specific element index */
  action: Record<string, unknown>
  /** present for actions that target an element */
  target?: ElementRef
  /** the model's reason for this step, kept for readability */
  note?: string
}

export interface TestScript {
  version: 1
  steps: ScriptStep[]
  compiledFrom: string
  compiledAt: string
  /**
   * `known-failing` means the last step is an assertion that FAILED when the
   * test was authored, because the application has a defect. Replaying it is
   * how you find out whether the defect is still there: it should fail at
   * `failingStep` and nowhere else, and the day it passes the bug is fixed.
   */
  expectation?: 'pass' | 'known-failing'
  failingStep?: number
}

export function describeCandidate(c: LocatorCandidate): string {
  switch (c.by) {
    case 'testId':
      return `getByTestId(${JSON.stringify(c.value)})`
    case 'role':
      return c.name ? `getByRole(${JSON.stringify(c.role)}, { name: ${JSON.stringify(c.name)} })` : `getByRole(${JSON.stringify(c.role)})`
    case 'label':
      return `getByLabel(${JSON.stringify(c.value)})`
    case 'placeholder':
      return `getByPlaceholder(${JSON.stringify(c.value)})`
    case 'text':
      return `getByText(${JSON.stringify(c.value)})`
    case 'css':
      return `locator(${JSON.stringify(c.value)})`
  }
}

/** True when a test can run without the AI. */
export const isReplayable = (script: unknown): script is TestScript =>
  Boolean(script && typeof script === 'object' && Array.isArray((script as TestScript).steps) && (script as TestScript).steps.length > 0)
