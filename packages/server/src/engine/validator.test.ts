import { describe, expect, it } from 'vitest'
import type { ObservationData } from '@testpilot/shared'
import { isAllowedUrl, registrableDomain, validateProposal } from './validator'

const obs: ObservationData = {
  url: 'http://localhost:4100/register',
  title: 'Register',
  scrollY: 0,
  scrollHeight: 800,
  viewportHeight: 800,
  totalFound: 6,
  elements: [
    { index: 0, role: 'link', label: 'Products', value: '', disabled: false, editable: false, inViewport: true, href: 'http://localhost:4100/' },
    { index: 1, role: 'email', label: 'Email address', value: '', disabled: false, editable: true, inViewport: true },
    { index: 2, role: 'button', label: 'Register', value: '', disabled: false, editable: false, inViewport: true },
    { index: 3, role: 'select', label: 'Payment method', value: 'card', disabled: false, editable: false, inViewport: true, options: ['Credit card', 'Cash on delivery'] },
    { index: 4, role: 'button', label: 'Disabled', value: '', disabled: true, editable: false, inViewport: true },
    { index: 5, role: 'button', label: 'Below the fold', value: '', disabled: false, editable: false, inViewport: false, off: 'below' },
  ],
}
const ctx = {
  baseUrl: 'http://localhost:4100',
  allowedDomains: [] as string[],
  recent: [] as string[],
  assertionsPassed: 0,
  substantiveAssertionsPassed: 0,
  tabCount: 1,
}

describe('validator (M2)', () => {
  it('accepts a well-formed click on an observed element', () => {
    expect(validateProposal({ thought: 'go', action: { type: 'click', index: 2 } }, obs, ctx).ok).toBe(true)
  })

  it('accepts clicking an element that is below the fold', () => {
    expect(validateProposal({ action: { type: 'click', index: 5 } }, obs, ctx).ok).toBe(true)
  })

  it('rejects unsupported action types', () => {
    const r = validateProposal({ action: { type: 'doubleClick', index: 2 } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Schema error/)
  })

  it('rejects indices that are not in the current observation, and suggests find()', () => {
    const r = validateProposal({ action: { type: 'click', index: 99 } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not in the current observation.*find/s)
  })

  it('rejects disabled elements', () => {
    expect(validateProposal({ action: { type: 'click', index: 4 } }, obs, ctx).ok).toBe(false)
  })

  it('rejects typing into a non-editable element', () => {
    const r = validateProposal({ action: { type: 'type', index: 2, text: 'x' } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a text field/)
  })

  it('validates select values against the observed options', () => {
    expect(validateProposal({ action: { type: 'select', index: 3, value: 'Cash on delivery' } }, obs, ctx).ok).toBe(true)
    const r = validateProposal({ action: { type: 'select', index: 3, value: 'Bitcoin' } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not one of the options/)
    // select on a non-select explains the custom-dropdown alternative
    const r2 = validateProposal({ action: { type: 'select', index: 1, value: 'x' } }, obs, ctx)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toMatch(/not a <select>/)
  })

  it('validates key names', () => {
    expect(validateProposal({ action: { type: 'pressKey', key: 'Escape' } }, obs, ctx).ok).toBe(true)
    expect(validateProposal({ action: { type: 'pressKey', key: 'Control+a' } }, obs, ctx).ok).toBe(true)
    expect(validateProposal({ action: { type: 'pressKey', key: 'WiggleTheMouse' } }, obs, ctx).ok).toBe(false)
  })

  it('requires an index when scrolling to an element', () => {
    expect(validateProposal({ action: { type: 'scroll', direction: 'down' } }, obs, ctx).ok).toBe(true)
    expect(validateProposal({ action: { type: 'scroll', direction: 'element' } }, obs, ctx).ok).toBe(false)
    expect(validateProposal({ action: { type: 'scroll', direction: 'element', index: 5 } }, obs, ctx).ok).toBe(true)
  })

  it('bounds switchTab by the number of open tabs', () => {
    expect(validateProposal({ action: { type: 'switchTab', index: 1 } }, obs, ctx).ok).toBe(false)
    expect(validateProposal({ action: { type: 'switchTab', index: 1 } }, obs, { ...ctx, tabCount: 2 }).ok).toBe(true)
  })

  it('refuses finish(pass) before any assertion has passed', () => {
    expect(validateProposal({ action: { type: 'finish', verdict: 'pass', reason: 'done' } }, obs, ctx).ok).toBe(false)
    expect(validateProposal({ action: { type: 'finish', verdict: 'pass', reason: 'done' } }, obs, { ...ctx, assertionsPassed: 1, substantiveAssertionsPassed: 1 }).ok).toBe(true)
    // A failure report needs no passing assertion, but it does have to say
    // what should have happened, what did, and on whose authority.
    const grounded = { type: 'finish', verdict: 'fail', reason: 'broken', expected: 'a password rule is enforced', actual: 'a 3-character password was accepted', rule: 'At least 8 characters' }
    expect(validateProposal({ action: grounded }, obs, ctx).ok).toBe(true)
    const bare = validateProposal({ action: { type: 'finish', verdict: 'fail', reason: 'broken' } }, obs, ctx)
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.reason).toMatch(/expected, actual, rule/)
  })

  it('refuses finish(pass) when the only passed assertions verified nothing', () => {
    // Exactly the loophole a real run exploited: assert a pre-existing nav link
    // is visible, then declare success.
    const r = validateProposal({ action: { type: 'finish', verdict: 'pass', reason: 'done' } }, obs, { ...ctx, assertionsPassed: 2, substantiveAssertionsPassed: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already on the page|verify nothing/)
    // finish(fail) is always allowed — reporting a problem needs no proof of success
    const fail = {
      type: 'finish',
      verdict: 'fail',
      reason: 'accepted a 3-character password',
      expected: 'the form refuses a password shorter than 8 characters',
      actual: 'it was accepted and the account was created',
      rule: 'At least 8 characters',
    }
    expect(validateProposal({ action: fail }, obs, { ...ctx, assertionsPassed: 2 }).ok).toBe(true)
  })

  it('blocks a repeated state-changing action but allows repeated reads', () => {
    const click = JSON.stringify({ type: 'click', index: 2 })
    expect(validateProposal({ action: { type: 'click', index: 2 } }, obs, { ...ctx, recent: [click, click] }).ok).toBe(false)
    const extract = JSON.stringify({ type: 'extract' })
    expect(validateProposal({ action: { type: 'extract' } }, obs, { ...ctx, recent: [extract, extract] }).ok).toBe(true)
  })

  it('stops the agent scrolling in circles', () => {
    const s = JSON.stringify({ type: 'scroll', direction: 'down' })
    const r = validateProposal({ action: { type: 'scroll', direction: 'down' } }, obs, { ...ctx, recent: [s, s, s] })
    expect(r.ok).toBe(false)
  })

  it('reports a parse error clearly', () => {
    const r = validateProposal({ __parseError: 'Unexpected token', text: 'oops' }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a JSON object/)
  })
})

describe('navigation domain policy', () => {
  it('derives the registrable domain', () => {
    expect(registrableDomain('shop.example.com')).toBe('example.com')
    expect(registrableDomain('example.com')).toBe('example.com')
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('localhost')).toBe('localhost')
  })

  it('allows the same site and its subdomains, blocks unrelated hosts', () => {
    const base = 'https://shop.example.com/'
    expect(isAllowedUrl(new URL('https://shop.example.com/cart'), base, [])).toBe(true)
    expect(isAllowedUrl(new URL('https://accounts.example.com/login'), base, [])).toBe(true) // SSO subdomain
    expect(isAllowedUrl(new URL('https://evil.test/'), base, [])).toBe(false)
    expect(isAllowedUrl(new URL('https://checkout.stripe.com/pay'), base, ['stripe.com'])).toBe(true)
  })

  it('rejects off-site navigation with an actionable message, and non-http schemes', () => {
    const r = validateProposal({ action: { type: 'navigate', url: 'https://google.com' } }, obs, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/allowed domains/)
    expect(validateProposal({ action: { type: 'navigate', url: 'javascript:alert(1)' } }, obs, ctx).ok).toBe(false)
  })

  it('resolves relative paths against the current page', () => {
    const r = validateProposal({ action: { type: 'navigate', url: '/cart' } }, obs, ctx)
    expect(r.ok).toBe(true)
    if (r.ok && r.action.type === 'navigate') expect(r.action.url).toBe('http://localhost:4100/cart')
  })
})
