/**
 * M1 — the fixed action schema.
 *
 * This is the ONLY vocabulary the AI may use; anything else is rejected by the
 * validator (M2) and the model is asked to regenerate.
 *
 * The project's original scope listed seven actions (navigate · click · type ·
 * select · check visibility · check text · verify navigation). That set cannot
 * drive a real website — there is no way to reach content below the fold, wait
 * for async UI, open a hover menu or read page text — so the *interaction*
 * vocabulary is extended here. The *assertion* vocabulary stays aligned with
 * the scope (visibility, text, navigation) plus a value check for form fields.
 */
import { z } from 'zod'

export const SUPPORTED_ACTIONS = [
  // navigate
  'navigate',
  'goBack',
  'switchTab',
  // interact
  'click',
  'type',
  'select',
  'hover',
  'pressKey',
  'scroll',
  'upload',
  // observe
  'wait',
  'find',
  'extract',
  // assert
  'assertVisible',
  'assertText',
  'assertUrl',
  'assertValue',
  'assertValidation',
  'assertCount',
  'assertOrder',
  // end
  'finish',
] as const
export type ActionType = (typeof SUPPORTED_ACTIONS)[number]

const index = z.number().int().nonnegative().describe('Element [index] from the CURRENT observation')

// ---- navigate ---------------------------------------------------------------
export const NavigateAction = z.object({
  type: z.literal('navigate'),
  url: z.string().min(1).describe('Absolute URL, or a path relative to the current page'),
})
export const GoBackAction = z.object({ type: z.literal('goBack') })
export const SwitchTabAction = z.object({
  type: z.literal('switchTab'),
  index: z.number().int().nonnegative().describe('Tab position, 0 = first'),
})

// ---- interact ---------------------------------------------------------------
export const ClickAction = z.object({ type: z.literal('click'), index })
export const TypeAction = z.object({
  type: z.literal('type'),
  index,
  text: z.string(),
  submit: z.boolean().optional().describe('Press Enter after typing'),
  clear: z.boolean().optional().describe('Clear the field first (default true)'),
})
export const SelectAction = z.object({ type: z.literal('select'), index, value: z.string().min(1) })
export const HoverAction = z.object({ type: z.literal('hover'), index })
export const PressKeyAction = z.object({
  type: z.literal('pressKey'),
  key: z.string().min(1).describe('Enter, Escape, Tab, ArrowDown, PageDown, Control+a, …'),
  index: index.optional().describe('Focus this element first'),
})
export const ScrollAction = z.object({
  type: z.literal('scroll'),
  direction: z.enum(['down', 'up', 'top', 'bottom', 'element']).describe('"element" scrolls to the given index'),
  amount: z.number().int().positive().max(20000).optional().describe('Pixels (default one viewport)'),
  index: index.optional(),
})

/**
 * Attach a file. The sample files are generated in memory, so a test never
 * depends on a file being present on the machine that runs it.
 */
export const UploadAction = z.object({
  type: z.literal('upload'),
  index,
  file: z.enum(['image', 'pdf', 'text', 'csv']).default('image').describe('Which sample file to attach'),
  name: z.string().max(80).optional().describe('Override the file name'),
})

// ---- observe ----------------------------------------------------------------
export const WaitAction = z.object({
  type: z.literal('wait'),
  ms: z.number().int().min(100).max(15000).optional().describe('Fixed pause; omit to wait for the page to settle'),
  forText: z.string().min(1).optional().describe('Wait until this text appears'),
})
export const FindAction = z.object({
  type: z.literal('find'),
  text: z.string().min(1).describe('Search every element on the page (including ones not listed) by label'),
})
export const ExtractAction = z.object({
  type: z.literal('extract'),
  query: z.string().optional().describe('What you are looking for — recorded with the result'),
})

// ---- assert -----------------------------------------------------------------
export const AssertVisibleAction = z.object({
  type: z.literal('assertVisible'),
  index: index.optional(),
  text: z.string().min(1).optional().describe('Visible text to look for anywhere on the page'),
})
export const AssertTextAction = z.object({
  type: z.literal('assertText'),
  index: index.optional().describe('Element to read; omit to search the whole page'),
  text: z.string().min(1).describe('Text that must be present (case-insensitive substring)'),
  absent: z.boolean().optional().describe('Assert the text is NOT present'),
  exact: z.boolean().optional().describe('The text must equal a whole visible string, case-sensitively'),
})
export const AssertUrlAction = z.object({
  type: z.literal('assertUrl'),
  contains: z.string().min(1).describe('Substring the current URL must contain'),
})
export const AssertValueAction = z.object({
  type: z.literal('assertValue'),
  index,
  text: z.string().describe('Expected value of the input/select; for a checkbox or radio use "checked" or "unchecked"'),
})

/**
 * Is the page treating this field as valid?
 *
 * Most real forms refuse an empty required field or a malformed email in the
 * browser, before anything is submitted. The message appears in a native bubble
 * that is not part of the page, so a negative test had nothing it could check
 * and either failed for the wrong reason or passed without verifying anything.
 */
export const AssertValidationAction = z.object({
  type: z.literal('assertValidation'),
  index,
  valid: z.boolean().describe('false = the browser or the page reports this field as invalid'),
  message: z.string().optional().describe('Substring of the expected validation message'),
})

/** How many things are there? Search, filter and pagination need this. */
export const AssertCountAction = z
  .object({
    type: z.literal('assertCount'),
    text: z.string().min(1).optional().describe('Count visible elements containing this text'),
    role: z.string().min(1).optional().describe('Or: count elements with this role'),
    nameContains: z.string().min(1).optional().describe('… whose accessible name contains this'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    equals: z.number().int().nonnegative().optional(),
  })
  .describe('Count matching elements and compare')

/**
 * These strings must appear in this order down the page. Sorting logic stays
 * out of the engine: the model reads the values, decides the order they should
 * be in, and asserts that order.
 */
export const AssertOrderAction = z.object({
  type: z.literal('assertOrder'),
  text: z.array(z.string().min(1)).min(2).max(8).describe('Texts in the order they must appear'),
})

// ---- end --------------------------------------------------------------------
export const FinishAction = z.object({
  type: z.literal('finish'),
  // `blocked` means "I could not carry out this test" — the page would not
  // load, an element was missing, the login was refused. That says nothing
  // about whether the application is correct, so it must never file a bug.
  verdict: z.enum(['pass', 'fail', 'blocked']),
  reason: z.string().min(1).describe('One or two sentences: what was verified, or expected vs actual'),
  expected: z.string().optional().describe('Required when the verdict is fail: what should have happened'),
  actual: z.string().optional().describe('Required when the verdict is fail: what happened instead'),
  evidence: z.string().optional().describe('Text visible on the page right now that shows the problem, quoted exactly'),
  rule: z.string().optional().describe('The instruction sentence or page rule this was judged against, quoted'),
})

export const ActionSchema = z.discriminatedUnion('type', [
  NavigateAction,
  GoBackAction,
  SwitchTabAction,
  ClickAction,
  TypeAction,
  SelectAction,
  HoverAction,
  PressKeyAction,
  ScrollAction,
  UploadAction,
  WaitAction,
  FindAction,
  ExtractAction,
  AssertVisibleAction,
  AssertTextAction,
  AssertUrlAction,
  AssertValueAction,
  AssertValidationAction,
  AssertCountAction,
  AssertOrderAction,
  FinishAction,
])
export type Action = z.infer<typeof ActionSchema>

/**
 * The most actions the model may plan in one reply.
 *
 * Asking for the next click one round trip at a time means a seven-field form
 * costs seven model calls, and six of those decisions were never in doubt. A
 * plan is only honoured while the page still looks the way the model saw it:
 * the runner stops the sequence the moment anything moves.
 */
export const MAX_BATCH = 5

/** What the model must output each step: one action, or a short plan. */
export const ProposalSchema = z
  .object({
    // Models routinely send the field they are not using as null rather than
    // omitting it, so `{"action": null, "actions": [...]}` has to parse. The
    // alternative is a schema error, a wasted call, and a retry that teaches
    // the model nothing.
    thought: z.string().nullish().transform((v) => v ?? ''),
    action: ActionSchema.nullish().transform((v) => v ?? undefined),
    actions: z
      .array(ActionSchema)
      .max(MAX_BATCH)
      .nullish()
      .transform((v) => (v && v.length ? v : undefined)),
  })
  .refine((p) => p.action !== undefined || p.actions !== undefined, {
    message: 'provide "action" or "actions"',
  })
export type Proposal = z.infer<typeof ProposalSchema>

/** The planned actions, however the model chose to phrase its reply. */
export const proposalActions = (p: Proposal): Action[] => p.actions ?? (p.action ? [p.action] : [])

/**
 * Actions the model must see the result of before planning further. Anything
 * after one of these in a plan is dropped, because the page it would act on is
 * not the page the model was looking at.
 */
export const ENDS_BATCH: ReadonlySet<string> = new Set(['navigate', 'goBack', 'switchTab', 'find', 'extract', 'wait', 'finish'])

export const ASSERTION_TYPES: ReadonlySet<string> = new Set([
  'assertVisible',
  'assertText',
  'assertUrl',
  'assertValue',
  'assertValidation',
  'assertCount',
  'assertOrder',
])
export const isAssertion = (a: { type: string }): boolean => ASSERTION_TYPES.has(a.type)

/**
 * Does this assertion check actual CONTENT, rather than merely that some
 * element exists? A bare `assertVisible{index}` can be satisfied by pointing at
 * any element that was already on the page, so on its own it is not evidence
 * that an outcome was verified. The runner additionally treats
 * `assertVisible{index}` as substantive when the element is new to the page.
 */
export function isContentAssertion(a: Action): boolean {
  switch (a.type) {
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
    // These three can only be written by someone who looked at the content:
    // a field's validity, how many things are listed, and in what order.
    case 'assertValidation':
    case 'assertCount':
    case 'assertOrder':
      return true
    case 'assertVisible':
      return Boolean(a.text)
    default:
      return false
  }
}

/** Actions that only read the page — they never change state. */
export const READ_ONLY_TYPES: ReadonlySet<string> = new Set(['find', 'extract', 'wait', 'scroll', ...ASSERTION_TYPES])
export const isReadOnly = (a: { type: string }): boolean => READ_ONLY_TYPES.has(a.type)

export const isSupportedAction = (a: unknown): a is Action =>
  typeof a === 'object' && a !== null && (SUPPORTED_ACTIONS as readonly string[]).includes((a as { type?: string }).type ?? '')

/** Schema reference embedded in the system prompt. */
export const ACTION_DOCS = `
NAVIGATE
{"type":"navigate","url":"<absolute URL or path on the same site>"}
{"type":"goBack"}
{"type":"switchTab","index":<tab position>}            // only when a new tab opened
INTERACT
{"type":"click","index":<n>}
{"type":"type","index":<n>,"text":"<text>","submit":<true|false>}   // submit=true presses Enter
{"type":"select","index":<n>,"value":"<option value or visible label>"}
{"type":"hover","index":<n>}                            // open a hover/mega menu
{"type":"pressKey","key":"Escape"|"Enter"|"Tab"|"ArrowDown"|"PageDown"|...,"index":<n optional>}
{"type":"scroll","direction":"down"|"up"|"top"|"bottom"|"element","amount":<px optional>,"index":<n for "element">}
{"type":"upload","index":<n>,"file":"image"|"pdf"|"text"|"csv"}   // attach a small sample file to a file input
OBSERVE
{"type":"wait","ms":<100-15000 optional>,"forText":"<text to appear, optional>"}
{"type":"find","text":"<label text>"}                   // searches ALL elements, including unlisted ones
{"type":"extract","query":"<what you need, optional>"}  // returns the page's visible text
ASSERT
{"type":"assertVisible","index":<n>}   or  {"type":"assertVisible","text":"<visible text>"}
{"type":"assertText","text":"<text>","absent":<true|false optional>}   or with "index":<n>
{"type":"assertUrl","contains":"<substring of the expected URL>"}
{"type":"assertValue","index":<n>,"text":"<expected field value, or "checked"/"unchecked" for a checkbox>"}
{"type":"assertValidation","index":<n>,"valid":false,"message":"<expected validation message, optional>"}
{"type":"assertCount","text":"<text>"|"role":"<role>","nameContains":"<name>","equals":<n>|"min":<n>|"max":<n>}
{"type":"assertOrder","text":["<first>","<second>","<third>"]}    // these must appear in this order
END
{"type":"finish","verdict":"pass","reason":"<what was verified>"}
{"type":"finish","verdict":"fail","reason":"<short>","expected":"<what should have happened>","actual":"<what happened>","rule":"<the instruction or page rule, quoted>","evidence":"<text visible on the page now, quoted exactly>"}
{"type":"finish","verdict":"blocked","reason":"<what stopped you>"}   // you could not run the test; NOT an application failure
`.trim()

export const ACTION_SUMMARY: Record<ActionType, string> = {
  navigate: 'Go to a URL on the application under test',
  goBack: 'Go back in browser history',
  switchTab: 'Switch to another open tab',
  click: 'Click an element by its observed index',
  type: 'Type text into an input / textarea',
  select: 'Choose an option in a <select>',
  hover: 'Hover an element (opens hover menus)',
  pressKey: 'Press a keyboard key',
  scroll: 'Scroll the page or to an element',
  upload: 'Attach a sample file to a file input',
  wait: 'Wait for the page to settle or for text to appear',
  find: 'Search all elements on the page by label',
  extract: 'Read the visible text of the page',
  assertVisible: 'Check that an element or text is visible',
  assertText: 'Check that text is present (or absent)',
  assertUrl: 'Verify navigation: current URL contains a substring',
  assertValue: 'Check the value of an input or select',
  assertValidation: 'Check whether the page reports a field as valid or invalid',
  assertCount: 'Count matching elements and compare against a number',
  assertOrder: 'Check that texts appear in a given order',
  finish: 'End the test with a pass/fail verdict',
}

/** Stable signature used for repeat detection. */
export function actionSignature(a: Action): string {
  return JSON.stringify(a)
}

const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 3) + '…' : s)

/** One-line rendering for logs and the UI. */
export function describeAction(a: Action): string {
  switch (a.type) {
    case 'navigate':
      return `navigate → ${a.url}`
    case 'goBack':
      return 'go back'
    case 'switchTab':
      return `switch to tab ${a.index}`
    case 'click':
      return `click [${a.index}]`
    case 'type':
      return `type "${short(a.text)}" into [${a.index}]${a.submit ? ' + Enter' : ''}`
    case 'select':
      return `select "${a.value}" in [${a.index}]`
    case 'hover':
      return `hover [${a.index}]`
    case 'pressKey':
      return `press ${a.key}${a.index !== undefined ? ` on [${a.index}]` : ''}`
    case 'scroll':
      return a.direction === 'element' ? `scroll to [${a.index}]` : `scroll ${a.direction}${a.amount ? ` ${a.amount}px` : ''}`
    case 'upload':
      return `attach a sample ${a.file} file to [${a.index}]`
    case 'wait':
      return a.forText ? `wait for "${short(a.forText)}"` : a.ms ? `wait ${a.ms}ms` : 'wait for the page to settle'
    case 'find':
      return `find "${short(a.text)}"`
    case 'extract':
      return `extract page text${a.query ? ` (${short(a.query)})` : ''}`
    case 'assertVisible':
      return a.index !== undefined ? `assert [${a.index}] is visible` : `assert text visible: "${short(a.text!, 60)}"`
    case 'assertText':
      return `assert ${a.index !== undefined ? `[${a.index}]` : 'page'} ${a.absent ? 'does NOT contain' : 'contains'} "${short(a.text, 60)}"`
    case 'assertUrl':
      return `assert URL contains "${a.contains}"`
    case 'assertValue':
      return `assert [${a.index}] value is "${short(a.text, 40)}"`
    case 'assertValidation':
      return `assert [${a.index}] is ${a.valid ? 'accepted' : 'rejected'}${a.message ? ` with "${short(a.message, 40)}"` : ''}`
    case 'assertCount':
      return `assert ${describeCountTarget(a)} ${describeBound(a)}`
    case 'assertOrder':
      return `assert this order: ${a.text.map((t) => `"${short(t, 20)}"`).join(' → ')}`
    case 'finish':
      return `finish(${a.verdict}): ${a.reason}`
  }
}

const describeCountTarget = (a: { text?: string; role?: string; nameContains?: string }): string =>
  a.text ? `elements containing "${short(a.text, 30)}"` : `${a.role} elements${a.nameContains ? ` named like "${short(a.nameContains, 24)}"` : ''}`

const describeBound = (a: { min?: number; max?: number; equals?: number }): string => {
  if (a.equals !== undefined) return `number exactly ${a.equals}`
  const parts: string[] = []
  if (a.min !== undefined) parts.push(`at least ${a.min}`)
  if (a.max !== undefined) parts.push(`at most ${a.max}`)
  return `number ${parts.join(' and ') || 'unconstrained'}`
}
