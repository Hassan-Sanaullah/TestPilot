/**
 * Planning several actions in one reply.
 *
 * The rule that makes it safe: a plan is only about the page the model was
 * looking at. The moment that page changes, the rest of the plan is dropped and
 * the model is shown what happened — so a plan can never assert something on a
 * page it has not seen.
 */
import { describe, expect, it } from 'vitest'
import type { ObservationData } from '@testpilot/shared'
import { MAX_BATCH, proposalActions, ProposalSchema } from '@testpilot/shared'
import { validateBatch, type ValidationContext } from './validator'

const obs: ObservationData = {
  url: 'http://app.test/register',
  title: 'Register',
  scrollY: 0,
  scrollHeight: 900,
  viewportHeight: 900,
  totalFound: 4,
  elements: [
    { index: 0, role: 'textbox', label: 'Name', value: '', disabled: false, editable: true, inViewport: true },
    { index: 1, role: 'textbox', label: 'Email', value: '', disabled: false, editable: true, inViewport: true },
    { index: 2, role: 'textbox', label: 'Password', value: '', disabled: false, editable: true, inViewport: true },
    { index: 3, role: 'button', label: 'Create account', value: '', disabled: false, editable: false, inViewport: true },
  ],
}

const ctx: ValidationContext = {
  baseUrl: 'http://app.test/',
  allowedDomains: [],
  recent: [],
  assertionsPassed: 0,
  substantiveAssertionsPassed: 0,
  tabCount: 1,
}

describe('reading a plan', () => {
  it('accepts either one action or a list', () => {
    const one = ProposalSchema.parse({ thought: 'x', action: { type: 'goBack' } })
    expect(proposalActions(one)).toHaveLength(1)
    const many = ProposalSchema.parse({ thought: 'x', actions: [{ type: 'goBack' }, { type: 'extract' }] })
    expect(proposalActions(many)).toHaveLength(2)
  })

  it('rejects a reply with neither', () => {
    expect(ProposalSchema.safeParse({ thought: 'x' }).success).toBe(false)
  })

  it('tolerates the nulls a model actually sends', () => {
    // Observed from a real provider: it fills in the field it is not using
    // with null rather than omitting it. Rejecting that costs a call and a
    // retry and teaches the model nothing.
    const withNullAction = ProposalSchema.safeParse({ thought: null, action: null, actions: [{ type: 'goBack' }] })
    expect(withNullAction.success).toBe(true)
    if (withNullAction.success) {
      expect(proposalActions(withNullAction.data)).toHaveLength(1)
      expect(withNullAction.data.thought).toBe('')
    }
    const withNullActions = ProposalSchema.safeParse({ action: { type: 'goBack' }, actions: null })
    expect(withNullActions.success).toBe(true)
    // An empty list is the same as not answering.
    expect(ProposalSchema.safeParse({ actions: [] }).success).toBe(false)
  })

  it('rejects more than the batch limit', () => {
    const actions = Array.from({ length: MAX_BATCH + 1 }, () => ({ type: 'goBack' }))
    expect(ProposalSchema.safeParse({ actions }).success).toBe(false)
  })
})

describe('validating a plan', () => {
  it('passes a whole form in one reply', () => {
    const r = validateBatch(
      {
        thought: 'fill the form',
        actions: [
          { type: 'type', index: 0, text: 'Ada' },
          { type: 'type', index: 1, text: 'ada@example.com' },
          { type: 'type', index: 2, text: 'Password123!' },
          { type: 'click', index: 3 },
        ],
      },
      obs,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actions).toHaveLength(4)
      expect(r.truncated).toBeUndefined()
    }
  })

  it('keeps the valid prefix when a later action is wrong', () => {
    const r = validateBatch(
      {
        actions: [
          { type: 'type', index: 0, text: 'Ada' },
          { type: 'type', index: 44, text: 'nowhere' },
          { type: 'click', index: 3 },
        ],
      },
      obs,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actions).toHaveLength(1)
      expect(r.truncated).toMatch(/dropped/)
    }
  })

  it('rejects the whole reply when the FIRST action is wrong', () => {
    const r = validateBatch({ actions: [{ type: 'click', index: 44 }, { type: 'extract' }] }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not in the current observation/)
  })

  it('runs the plan but not a finish tacked onto the end of it', () => {
    // Whether finish(pass) is allowed depends on whether the assertions in the
    // same plan passed, which is not known when the plan is validated. The
    // model does this constantly, and rejecting the whole reply would cost a
    // call and teach it nothing — so the finish is dropped and it can send it
    // next turn, once the results are in.
    const r = validateBatch(
      {
        actions: [
          { type: 'assertText', text: 'Welcome' },
          { type: 'finish', verdict: 'pass', reason: 'done' },
        ],
      },
      obs,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actions).toHaveLength(1)
      expect(r.actions[0].type).toBe('assertText')
      expect(r.truncated).toMatch(/send it on its own/)
    }
  })

  it('refuses actions placed after a finish', () => {
    const r = validateBatch(
      {
        actions: [
          { type: 'finish', verdict: 'pass', reason: 'done' },
          { type: 'assertText', text: 'Welcome' },
        ],
      },
      obs,
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/last thing you do/)
  })

  it('still lets a finish on its own through', () => {
    const r = validateBatch({ action: { type: 'finish', verdict: 'pass', reason: 'done' } }, obs, { ...ctx, assertionsPassed: 1, substantiveAssertionsPassed: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.actions[0].type).toBe('finish')
  })

  it('truncates after an action whose result must be read first', () => {
    const r = validateBatch(
      {
        actions: [
          { type: 'navigate', url: 'http://app.test/login' },
          { type: 'type', index: 1, text: 'too soon' },
        ],
      },
      obs,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actions).toHaveLength(1)
      expect(r.truncated).toMatch(/before deciding what comes next/)
    }
  })

  it('still accepts a single-action reply unchanged', () => {
    const r = validateBatch({ thought: 'one thing', action: { type: 'click', index: 3 } }, obs, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.actions).toHaveLength(1)
  })
})

describe('grounding a failure report', () => {
  it('refuses evidence that is not on the page', () => {
    const r = validateBatch(
      {
        action: {
          type: 'finish',
          verdict: 'fail',
          reason: 'wrong message',
          expected: 'an error about the password',
          actual: 'no error at all',
          rule: 'At least 8 characters',
          evidence: 'Password must contain a symbol',
        },
      },
      obs,
      { ...ctx, pageText: ['Create an account', 'At least 8 characters'] },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/is not on the page/)
  })

  it('accepts evidence that is on the page, ignoring spacing and case', () => {
    const r = validateBatch(
      {
        action: {
          type: 'finish',
          verdict: 'fail',
          reason: 'accepted a short password',
          expected: 'the form refuses it',
          actual: 'the account was created',
          rule: 'At least 8 characters',
          evidence: 'account   CREATED',
        },
      },
      obs,
      { ...ctx, pageText: ['Account created', 'Welcome, Ada'] },
    )
    expect(r.ok).toBe(true)
  })

  it('refuses a claim that something is missing when it is right there', () => {
    const r = validateBatch(
      {
        action: {
          type: 'finish',
          verdict: 'fail',
          reason: 'no confirmation shown',
          expected: 'Account created',
          actual: 'nothing appeared',
          rule: 'registering shows a confirmation',
        },
      },
      obs,
      { ...ctx, pageText: ['Account created', 'Welcome, Ada'] },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/IS on the page/)
  })

  it('treats blocked as its own verdict, needing no evidence', () => {
    const r = validateBatch({ action: { type: 'finish', verdict: 'blocked', reason: 'the login page never loaded' } }, obs, { ...ctx, pageText: ['Service unavailable'] })
    expect(r.ok).toBe(true)
  })
})

describe('validating the new assertions', () => {
  it('requires a number to compare against for assertCount', () => {
    expect(validateBatch({ action: { type: 'assertCount', text: 'Add to cart' } }, obs, ctx).ok).toBe(false)
    expect(validateBatch({ action: { type: 'assertCount', text: 'Add to cart', min: 1 } }, obs, ctx).ok).toBe(true)
  })

  it('requires something to count', () => {
    expect(validateBatch({ action: { type: 'assertCount', equals: 3 } }, obs, ctx).ok).toBe(false)
    expect(validateBatch({ action: { type: 'assertCount', role: 'listitem', equals: 3 } }, obs, ctx).ok).toBe(true)
  })

  it('refuses an impossible range', () => {
    const r = validateBatch({ action: { type: 'assertCount', text: 'x', min: 5, max: 2 } }, obs, ctx)
    expect(r.ok).toBe(false)
  })

  it('refuses assertOrder with a repeated text', () => {
    expect(validateBatch({ action: { type: 'assertOrder', text: ['a1', 'a1'] } }, obs, ctx).ok).toBe(false)
    expect(validateBatch({ action: { type: 'assertOrder', text: ['a1', 'b2'] } }, obs, ctx).ok).toBe(true)
  })

  it('refuses upload on something that is not a file input', () => {
    const r = validateBatch({ action: { type: 'upload', index: 3, file: 'image' } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a file input/)
  })

  it('refuses a click on a file input and says what to use', () => {
    const withFile: ObservationData = {
      ...obs,
      elements: [...obs.elements, { index: 4, role: 'file', label: 'Avatar', value: '', disabled: false, editable: false, inViewport: true }],
    }
    const r = validateBatch({ action: { type: 'click', index: 4 } }, withFile, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/use upload/)
    expect(validateBatch({ action: { type: 'upload', index: 4, file: 'pdf' } }, withFile, ctx).ok).toBe(true)
  })
})
