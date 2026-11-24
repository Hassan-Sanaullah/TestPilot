/**
 * M2 (validation half) — the deterministic action checker.
 *
 * The model's proposal must (1) parse against the fixed schema and (2) make
 * sense against the CURRENT observation and the run's state. Anything else is
 * rejected with a precise reason that is fed back so the model can regenerate
 * (max 3 attempts, then the step is flagged and the run fails).
 */
import { type Action, ENDS_BATCH, MAX_BATCH, ProposalSchema, actionSignature, isAssertion, isReadOnly, proposalActions } from '@testpilot/shared'
import type { ObservationData } from '@testpilot/shared'
import { registrableDomain } from './urls'

export interface ValidationContext {
  /** URL of the application under test (its registrable domain bounds navigation) */
  baseUrl: string
  /** extra hostnames the test may visit (SSO, payment sandbox, CDN) */
  allowedDomains: string[]
  /** signatures of recently executed actions (repeat guard) */
  recent: readonly string[]
  /** number of assertions that have passed so far in this run */
  assertionsPassed: number
  /**
   * Of those, how many actually verified something: a content check, or the
   * appearance of an element that was not already on the page at the start.
   * Asserting that a pre-existing nav link is visible proves nothing, and the
   * model will do exactly that to get past the finish gate if we let it.
   */
  substantiveAssertionsPassed: number
  /** how many tabs are open (bounds switchTab) */
  tabCount: number
  /**
   * Visible text on the page right now, from `collectText`. A `finish(fail)`
   * must quote evidence that is actually there; without this list the model can
   * invent the message it claims to have seen.
   */
  pageText?: readonly string[]
}

export type ValidationResult = { ok: true; action: Action; thought: string } | { ok: false; reason: string }

export type BatchResult =
  | { ok: true; actions: Action[]; thought: string; truncated?: string }
  | { ok: false; reason: string }

/** Collapse whitespace and case so a quote can be compared with page text. */
const normaliseQuote = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

const TYPEABLE_ROLES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'textarea', 'textbox', 'searchbox', 'combobox', 'date', 'time'])
const SELECTABLE_ROLES = new Set(['select', 'combobox', 'listbox'])

// `registrableDomain` lives in ./urls now; re-exported because the public
// validator API (and its tests) have always exposed it from here.
export { registrableDomain } from './urls'

export function isAllowedUrl(target: URL, baseUrl: string, allowed: string[]): boolean {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return true
  }
  if (target.origin === base.origin) return true
  if (registrableDomain(target.hostname) === registrableDomain(base.hostname)) return true
  return allowed.some((d) => {
    const clean = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!clean) return false
    return target.hostname === clean || target.hostname.endsWith('.' + clean)
  })
}

/**
 * Validate a whole reply, which may be a single action or a short plan.
 *
 * A plan is trusted only as far as it is still about the page the model saw, so
 * anything after an action whose result the model must read is dropped rather
 * than rejected — dropping costs one extra turn, rejecting costs a model call
 * and teaches it nothing.
 */
export function validateBatch(raw: unknown, obs: ObservationData, ctx: ValidationContext): BatchResult {
  const parsed = parseProposal(raw)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  const { actions, thought } = parsed

  if (actions.length > MAX_BATCH) return { ok: false, reason: `at most ${MAX_BATCH} actions per reply.` }

  // `finish` ends the run, and whether finish(pass) is allowed depends on
  // whether the assertions in the SAME plan passed — which is not known yet.
  // Rather than model that, it has to arrive on its own.
  //
  // A plan that ends with finish is the common case, though, and rejecting the
  // whole reply for it costs a model call and teaches the model nothing. So the
  // finish is simply dropped: the actions before it run, the model sees their
  // results, and it finishes on the next turn — by which point its assertions
  // have actually passed and the gate can judge them.
  const finishAt = actions.findIndex((a) => a.type === 'finish')
  let droppedFinish = false
  if (finishAt >= 0 && actions.length > 1) {
    if (finishAt !== actions.length - 1) {
      return { ok: false, reason: 'finish must be the last thing you do. Remove the actions you put after it.' }
    }
    actions.pop()
    droppedFinish = true
  }

  const accepted: Action[] = []
  let truncated: string | undefined = droppedFinish
    ? 'your finish was not carried out: send it on its own once you have seen that these actions did what you expected'
    : undefined
  for (const [i, action] of actions.entries()) {
    const r = validateAction(action, obs, ctx)
    if (!r.ok) {
      // A valid prefix is worth executing; the model sees the page afterwards
      // and decides again. Only a bad first action is worth a retry.
      if (accepted.length === 0) return { ok: false, reason: r.reason }
      truncated = `action ${i + 1} of your plan was dropped (${r.reason})`
      break
    }
    accepted.push(r.action)
    if (ENDS_BATCH.has(action.type) && i < actions.length - 1) {
      truncated = `only the first ${accepted.length} action(s) ran: after ${action.type} you need to see the page before deciding what comes next`
      break
    }
  }
  return { ok: true, actions: accepted, thought, ...(truncated ? { truncated } : {}) }
}

function parseProposal(raw: unknown): { actions: Action[]; thought: string } | { reason: string } {
  if (raw && typeof raw === 'object' && '__parseError' in (raw as object)) {
    return { reason: `Reply was not a JSON object (${(raw as { __parseError: string }).__parseError}).` }
  }
  const parsed = ProposalSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
      .join('; ')
    return { reason: `Schema error — ${issues}. Use only the supported actions with the documented fields.` }
  }
  return { actions: proposalActions(parsed.data), thought: parsed.data.thought }
}

/** Validate one reply that must contain exactly one action. */
export function validateProposal(raw: unknown, obs: ObservationData, ctx: ValidationContext): ValidationResult {
  const parsed = parseProposal(raw)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  if (parsed.actions.length !== 1) return { ok: false, reason: 'exactly one action is expected here.' }
  const r = validateAction(parsed.actions[0], obs, ctx)
  return r.ok ? { ok: true, action: r.action, thought: parsed.thought } : r
}

export function validateAction(action: Action, obs: ObservationData, ctx: ValidationContext): { ok: true; action: Action } | { ok: false; reason: string } {
  const byIndex = new Map(obs.elements.map((e) => [e.index, e]))
  const known = obs.elements.length ? `valid indices: ${obs.elements[0].index}–${obs.elements[obs.elements.length - 1].index}` : 'no elements were observed'

  const needElement = (index: number, { allowDisabled = false } = {}) => {
    const el = byIndex.get(index)
    if (!el) return `index ${index} is not in the current observation (${known}). Use find("…") to locate an element not listed.`
    if (el.disabled && !allowDisabled) return `element [${index}] "${el.label}" is disabled — it cannot be interacted with yet.`
    return null
  }

  switch (action.type) {
    case 'navigate': {
      let url: URL
      try {
        url = new URL(action.url, obs.url || ctx.baseUrl)
      } catch {
        return { ok: false, reason: `"${action.url}" is not a valid URL.` }
      }
      if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: `only http(s) URLs are allowed, got "${url.protocol}".` }
      if (!isAllowedUrl(url, ctx.baseUrl, ctx.allowedDomains)) {
        return {
          ok: false,
          reason: `${url.hostname} is outside the application under test (${new URL(ctx.baseUrl).hostname}). Add it to the project's allowed domains if the test genuinely needs it.`,
        }
      }
      action.url = url.toString()
      break
    }
    case 'goBack':
      break
    case 'switchTab': {
      if (action.index >= ctx.tabCount) {
        return { ok: false, reason: `there ${ctx.tabCount === 1 ? 'is only 1 tab' : `are only ${ctx.tabCount} tabs`} open (0–${ctx.tabCount - 1}).` }
      }
      break
    }
    case 'click':
    case 'hover': {
      const err = needElement(action.index)
      if (err) return { ok: false, reason: err }
      if (action.type === 'click' && byIndex.get(action.index)?.role === 'file') {
        return { ok: false, reason: `element [${action.index}] is a file input — use upload to attach a file to it, not click.` }
      }
      break
    }
    case 'upload': {
      const err = needElement(action.index, { allowDisabled: true })
      if (err) return { ok: false, reason: err }
      const el = byIndex.get(action.index)!
      if (el.role !== 'file') {
        return { ok: false, reason: `element [${action.index}] is a ${el.role} ("${el.label}"), not a file input.` }
      }
      break
    }
    case 'type': {
      const err = needElement(action.index)
      if (err) return { ok: false, reason: err }
      const el = byIndex.get(action.index)!
      if (!el.editable && !TYPEABLE_ROLES.has(el.role)) {
        return { ok: false, reason: `element [${action.index}] is a ${el.role} ("${el.label}"), not a text field — choose an input or textarea.` }
      }
      break
    }
    case 'select': {
      const err = needElement(action.index)
      if (err) return { ok: false, reason: err }
      const el = byIndex.get(action.index)!
      if (!SELECTABLE_ROLES.has(el.role)) {
        return { ok: false, reason: `element [${action.index}] is a ${el.role}, not a <select>. To pick from a custom dropdown, click it and then click the option.` }
      }
      if (el.options?.length) {
        const want = action.value.toLowerCase().trim()
        const match = el.options.some((o) => o.toLowerCase().trim() === want || o.toLowerCase().includes(want))
        if (!match && Number.isNaN(Number(action.value))) {
          return { ok: false, reason: `"${action.value}" is not one of the options of [${action.index}]: ${el.options.join(' | ')}` }
        }
      }
      break
    }
    case 'pressKey': {
      if (action.index !== undefined) {
        const err = needElement(action.index)
        if (err) return { ok: false, reason: err }
      }
      if (!/^[A-Za-z0-9]$|^(Enter|Escape|Tab|Backspace|Delete|Space|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|F\d{1,2})$|^(Control|Shift|Alt|Meta)\+\S+$/.test(action.key)) {
        return { ok: false, reason: `"${action.key}" is not a recognised key name. Use Enter, Escape, Tab, ArrowDown, PageDown, Control+a, …` }
      }
      break
    }
    case 'scroll': {
      if (action.direction === 'element') {
        if (action.index === undefined) return { ok: false, reason: 'scroll with direction "element" needs an index.' }
        const err = needElement(action.index, { allowDisabled: true })
        if (err) return { ok: false, reason: err }
      }
      break
    }
    case 'wait': {
      if (!action.ms && !action.forText && ctx.recent.length === 0) break
      break
    }
    case 'find':
      break
    case 'extract':
      break
    case 'assertVisible': {
      if (action.index === undefined && !action.text) return { ok: false, reason: 'assertVisible needs an index or a text.' }
      if (action.index !== undefined) {
        const err = needElement(action.index, { allowDisabled: true })
        if (err) return { ok: false, reason: err }
      }
      break
    }
    case 'assertText': {
      if (action.index !== undefined) {
        const err = needElement(action.index, { allowDisabled: true })
        if (err) return { ok: false, reason: err }
      }
      break
    }
    case 'assertValue':
    case 'assertValidation': {
      const err = needElement(action.index, { allowDisabled: true })
      if (err) return { ok: false, reason: err }
      break
    }
    case 'assertCount': {
      if (!action.text && !action.role) return { ok: false, reason: 'assertCount needs either a text or a role to count.' }
      if (action.equals === undefined && action.min === undefined && action.max === undefined) {
        return { ok: false, reason: 'assertCount needs a number to compare against: equals, min or max.' }
      }
      if (action.min !== undefined && action.max !== undefined && action.min > action.max) {
        return { ok: false, reason: `min (${action.min}) cannot be greater than max (${action.max}).` }
      }
      break
    }
    case 'assertOrder': {
      const seen = new Set(action.text.map((t) => t.toLowerCase().trim()))
      if (seen.size !== action.text.length) return { ok: false, reason: 'assertOrder needs distinct texts; two of yours are the same.' }
      break
    }
    case 'assertUrl':
      break
    case 'finish': {
      if (action.verdict === 'pass' && ctx.assertionsPassed === 0) {
        return {
          ok: false,
          reason:
            'finish(pass) is not allowed before at least one assertion has passed — verify the expected outcome with assertText / assertUrl / assertValue / assertVisible first.',
        }
      }
      if (action.verdict === 'pass' && ctx.substantiveAssertionsPassed === 0) {
        return {
          ok: false,
          reason:
            'the only assertions that passed check elements that were already on the page before the test did anything, so they verify nothing. Assert the actual outcome: the exact message, value or URL that proves the behaviour worked (assertText / assertUrl / assertValue), or that a NEW element appeared. If the expected outcome did not happen, finish(fail) instead.',
        }
      }
      if (action.verdict === 'fail') {
        // A bug report is only worth filing if it says what should have
        // happened, what did, and on what authority.
        const missing = (['expected', 'actual', 'rule'] as const).filter((k) => !(action[k] ?? '').trim())
        if (missing.length) {
          return {
            ok: false,
            reason: `finish(fail) must say ${missing.join(', ')}. Quote the rule from the instruction or from the page itself. If you simply could not run the test, use finish(blocked) instead.`,
          }
        }
        const text = ctx.pageText
        if (text) {
          const haystack = normaliseQuote(text.join(' \n '))
          const quoted = (action.evidence ?? '').trim()
          if (quoted) {
            if (!haystack.includes(normaliseQuote(quoted))) {
              return {
                ok: false,
                reason: `the evidence you quoted ("${quoted.slice(0, 80)}") is not on the page. Quote text that is actually visible — see SINCE YOUR LAST ACTION — or use finish(blocked).`,
              }
            }
          } else {
            // No evidence means the claim is that something is MISSING, so the
            // expected text must genuinely be absent.
            const expected = normaliseQuote(action.expected ?? '')
            if (expected.length >= 4 && haystack.includes(expected)) {
              return {
                ok: false,
                reason: `you report that "${(action.expected ?? '').slice(0, 60)}" did not happen, but that text IS on the page. Re-read it, and assert the real outcome instead.`,
              }
            }
          }
        }
      }
      break
    }
  }

  // Repeat guard. Read-only actions (scroll, find, extract, wait, assertions)
  // are legitimately repeatable; state-changing ones are not.
  if (!isReadOnly(action) && action.type !== 'finish') {
    const sig = actionSignature(action)
    const repeats = ctx.recent.filter((s) => s === sig).length
    if (repeats >= 2) {
      return {
        ok: false,
        reason: `you already performed exactly this action ${repeats} times without reaching the goal — choose a different element or approach, or finish(fail) explaining what is wrong.`,
      }
    }
  }
  // Scrolling in circles is also a loop.
  if (action.type === 'scroll') {
    const sig = actionSignature(action)
    if (ctx.recent.filter((s) => s === sig).length >= 3) {
      return { ok: false, reason: 'you have scrolled the same way repeatedly without progress — try find("text"), extract, or a different element.' }
    }
  }

  void isAssertion
  return { ok: true, action }
}
