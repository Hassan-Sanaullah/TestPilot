import { describe, expect, it } from 'vitest'
import type { TestScript } from '@testpilot/shared'
import { compileScript, toPlaywrightSpec } from './script'
import { makePlaceholderValues } from './placeholders'

const ref = (desc: string) => JSON.stringify({ candidate: { by: 'role', role: 'button', name: desc }, description: `button ${desc}` })

const step = (index: number, action: unknown, extra: Partial<{ status: string; locator: string | null; thought: string }> = {}) => ({
  index,
  action: JSON.stringify(action),
  thought: extra.thought ?? '',
  status: extra.status ?? 'ok',
  locator: extra.locator ?? null,
})

describe('compiling a run into a replayable script', () => {
  it('keeps the actions and drops the observation-specific indices', () => {
    const script = compileScript('run_1', [
      step(1, { type: 'click', index: 4 }, { locator: ref('Register'), thought: 'open the form' }),
      step(2, { type: 'type', index: 7, text: 'a@b.com' }, { locator: ref('Email') }),
      step(3, { type: 'assertText', text: 'Welcome' }),
      step(4, { type: 'finish', verdict: 'pass', reason: 'done' }),
    ])!
    expect(script).not.toBeNull()
    expect(script.steps).toHaveLength(3) // finish is not part of the script
    expect(script.steps[0].action).toEqual({ type: 'click' }) // index removed
    expect(script.steps[0].target?.description).toContain('Register')
    expect(script.steps[1].action).toMatchObject({ type: 'type', text: 'a@b.com' })
    expect(script.steps[2].action).toMatchObject({ type: 'assertText', text: 'Welcome' })
  })

  it('refuses to compile when an element has no verified locator', () => {
    // Replaying this would act on whatever happens to be at that index later.
    expect(compileScript('run_2', [step(1, { type: 'click', index: 4 }), step(2, { type: 'assertText', text: 'x' })])).toBeNull()
  })

  it('refuses to compile a run with no assertion', () => {
    expect(compileScript('run_3', [step(1, { type: 'click', index: 4 }, { locator: ref('Go') })])).toBeNull()
  })

  it('refuses to compile a run that did not fully succeed', () => {
    expect(
      compileScript('run_4', [step(1, { type: 'assertText', text: 'x' }, { status: 'failed' })]),
    ).toBeNull()
  })

  it('drops the orientation actions the model used but a test does not need', () => {
    const script = compileScript('run_5', [
      step(1, { type: 'find', text: 'Register' }),
      step(2, { type: 'extract' }),
      step(3, { type: 'assertUrl', contains: '/done' }),
    ])!
    expect(script.steps).toHaveLength(1)
    expect(script.steps[0].action).toMatchObject({ type: 'assertUrl' })
  })
})

describe('exporting a Playwright spec', () => {
  const script: TestScript = {
    version: 1,
    compiledFrom: 'run_1',
    compiledAt: '2026-01-01T00:00:00.000Z',
    steps: [
      { index: 1, action: { type: 'click' }, target: { candidate: { by: 'role', role: 'link', name: 'Register' }, description: 'link Register' } },
      { index: 2, action: { type: 'type', text: 'a@b.com' }, target: { candidate: { by: 'label', value: 'Email address' }, description: 'textbox Email address' } },
      { index: 3, action: { type: 'assertText', text: 'already exists' } },
      { index: 4, action: { type: 'assertUrl', contains: '/register' } },
    ],
  }

  it('produces a file that is ordinary Playwright', () => {
    const spec = toPlaywrightSpec('Duplicate email is rejected', 'http://localhost:4100', script)
    expect(spec).toContain(`import { expect, test } from '@playwright/test'`)
    expect(spec).toContain(`test("Duplicate email is rejected"`)
    expect(spec).toContain(`await page.goto("http://localhost:4100")`)
    expect(spec).toContain(`getByRole("link", { name: "Register" })`)
    expect(spec).toContain(`getByLabel("Email address")`)
    expect(spec).toContain(`.fill("a@b.com")`)
    expect(spec).toContain(`toContainText("already exists")`)
    // the URL assertion is escaped into a safe regular expression
    expect(spec).toContain(`toHaveURL(new RegExp("/register"))`)
    expect(spec.endsWith('})\n')).toBe(true)
  })

  it('escapes regex metacharacters in an asserted URL', () => {
    const spec = toPlaywrightSpec('t', 'http://x', {
      ...script,
      steps: [{ index: 1, action: { type: 'assertUrl', contains: '/items?id=1' } }],
    })
    expect(spec).toContain('\\\\?id=1')
  })
})

describe('keeping compiled tests portable', () => {
  const values = makePlaceholderValues({ baseUrl: 'http://app.test', testUser: 'standard_user', testPassword: 'secret', seed: 'r1' })

  it('puts the account and generated data back behind placeholders', () => {
    // The model types real values during a run; freezing them would tie the
    // test to one account, and would re-use a "unique" email on every replay.
    const script = compileScript(
      'run_p',
      [
        step(1, { type: 'type', index: 1, text: 'standard_user' }, { locator: ref('Username') }),
        step(2, { type: 'type', index: 2, text: values.unique_email }, { locator: ref('Email') }),
        step(3, { type: 'assertText', text: 'Welcome standard_user' }),
      ],
      values,
    )!
    expect(script.steps[0].action.text).toBe('{{test_user}}')
    expect(script.steps[1].action.text).toBe('{{unique_email}}')
    expect(script.steps[2].action.text).toBe('Welcome {{test_user}}')
  })

  it('leaves unrelated text alone', () => {
    const script = compileScript('run_q', [step(1, { type: 'assertText', text: 'Epic sadface' })], values)!
    expect(script.steps[0].action.text).toBe('Epic sadface')
  })

  it('never substitutes the password, which is not in the script to begin with', () => {
    const script = compileScript('run_r', [step(1, { type: 'assertText', text: 'secret' })], values)!
    expect(script.steps[0].action.text).toBe('secret')
  })
})
