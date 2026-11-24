/**
 * Designing tests by computing them, not by asking a model.
 *
 * The explorer already reads a form's real constraints out of the HTML:
 * `required`, `minlength`, `min`, `max`, `type="email"`, a select's options.
 * Classic black-box technique turns those into tests mechanically — boundary
 * value analysis, required-field omission, format invalidation, equivalence
 * partitioning — so the same application always yields the same tests, each one
 * can quote the rule it checks, and none of it needs an API key.
 *
 * Why not just ask the model? Because whether the seven-character password gets
 * tested would then depend on what the model happened to write that day, and a
 * suite you cannot predict is a suite you cannot defend. Published work on
 * using language models for boundary values reports exactly this: common
 * boundaries are handled, less common ones are missed. Models remain far better
 * at the things that cannot be computed — what a successful checkout means, how
 * to word a title — and that is what they are used for here.
 *
 * Everything in this file is a pure function over the app map. No database, no
 * browser, no network.
 */
import { createHash } from 'node:crypto'
import type { DiscoveredPage, FormDescriptor, FormField } from '../engine/explorer'
import { shapeOf } from '../engine/explorer'

export type Technique = 'boundary' | 'equivalence' | 'required' | 'format' | 'uniqueness' | 'selection' | 'flow'

export interface TestDesign {
  designKey: string
  title: string
  kind: 'happy-path' | 'negative' | 'edge' | 'flow'
  technique: Technique
  pageUrl: string
  area: string
  form: string
  field?: string
  /** label -> value for every field of the form */
  input: Record<string, string>
  expectAccepted: boolean
  oracle: 'stated-rule' | 'implicit'
  /** the constraint, quoted or rendered */
  oracleText: string
  /** `declared` = read from HTML; `parsed-text` = read from an English sentence */
  confidence: 'declared' | 'parsed-text'
  auth: 'anonymous' | 'signed-in'
  priority: 1 | 2 | 3
  instruction: string
}

export interface DesignInput {
  pages: DiscoveredPage[]
  testUser?: string | null
  testData?: Record<string, string>
}

export interface DesignResult {
  designs: TestDesign[]
  /** forms that could not be designed for, and why — shown to the user */
  notes: string[]
}

// ---------------------------------------------------------------- rule parsing

/**
 * Many applications state a rule in words and enforce it only in JavaScript,
 * so the HTML declares nothing. These read the number back out of the sentence.
 * English only, and anything found this way is marked `parsed-text`.
 */
const MIN_LEN = /(?:at least|minimum(?: of)?|min\.?)\s*(\d{1,3})\s*(?:characters|chars|letters|digits)|(\d{1,3})\s*\+\s*(?:characters|chars)|(\d{1,3})\s*or more characters/i
const MAX_LEN = /(?:at most|maximum(?: of)?|max\.?|no more than|up to)\s*(\d{1,3})\s*(?:characters|chars|letters|digits)/i
const RANGE = /between\s*(\d{1,3})\s*(?:and|-|to)\s*(\d{1,3})\s*(?:characters|chars)/i
const DUPLICATE_RULE = /already (?:exists|registered|taken|in use)|is taken|in use by another/i

interface Constraints {
  minLength?: number
  maxLength?: number
  /** true when minLength/maxLength came from HTML rather than from a sentence */
  declaredLength: boolean
  minLengthText?: string
  maxLengthText?: string
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

/** Resolve a field's length limits from HTML first, then from stated text. */
export function constraintsFor(field: FormField, pageRules: string[]): Constraints {
  const out: Constraints = { declaredLength: false }
  if (field.minLength !== undefined) {
    out.minLength = field.minLength
    out.declaredLength = true
    out.minLengthText = `minlength="${field.minLength}"`
  }
  if (field.maxLength !== undefined) {
    out.maxLength = field.maxLength
    out.declaredLength = true
    out.maxLengthText = `maxlength="${field.maxLength}"`
  }
  if (out.minLength !== undefined && out.maxLength !== undefined) return out

  // Look in the field's own hint, then in page rules that mention this field.
  const label = field.label.toLowerCase()
  const candidates = [field.hint, ...pageRules.filter((r) => label.length > 2 && r.toLowerCase().includes(label))]
  for (const text of candidates) {
    if (!text) continue
    const range = RANGE.exec(text)
    if (range) {
      if (out.minLength === undefined) {
        out.minLength = num(range[1])
        out.minLengthText = `"${text.trim()}"`
      }
      if (out.maxLength === undefined) {
        out.maxLength = num(range[2])
        out.maxLengthText = `"${text.trim()}"`
      }
      continue
    }
    if (out.minLength === undefined) {
      const m = MIN_LEN.exec(text)
      const found = m ? num(m[1] ?? m[2] ?? m[3]) : undefined
      if (found !== undefined) {
        out.minLength = found
        out.minLengthText = `"${text.trim()}"`
      }
    }
    if (out.maxLength === undefined) {
      const m = MAX_LEN.exec(text)
      const found = m ? num(m[1]) : undefined
      if (found !== undefined) {
        out.maxLength = found
        out.maxLengthText = `"${text.trim()}"`
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- baseline values

const isConfirmField = (label: string): boolean => /confirm|repeat|again|verify|retype/i.test(label)

/**
 * A password that satisfies every common composition rule at a given length,
 * so that a length test varies ONLY length.
 *
 * This matters more than it looks. ShopMax's seeded bug 5 accepts a short
 * password as long as it contains a digit; a model that picks "123" for the
 * too-short case never finds it, because "123" is rejected for a different
 * reason. Keeping the character classes constant is what makes the boundary
 * test a test of the boundary.
 */
export function passwordOfLength(n: number): string {
  const length = Math.max(4, n)
  const head = 'Tp1!'
  if (length <= head.length) return head.slice(0, length)
  const filler = 'abcdefghijklmnopqrstuvwxyz'
  let out = head
  while (out.length < length) out += filler[(out.length * 7) % filler.length]
  return out.slice(0, length)
}

/** A string of exactly `n` characters that keeps the shape of `like`. */
function stringOfLength(n: number, like: string): string {
  if (n <= 0) return ''
  if (/[A-Z]/.test(like) && /[0-9]/.test(like) && /[^A-Za-z0-9]/.test(like)) return passwordOfLength(n)
  if (like.includes('@')) {
    // Keep it a plausible email while changing its length.
    const local = 'a'.repeat(Math.max(1, n - '@example.com'.length))
    return (local + '@example.com').slice(0, Math.max(n, 'a@example.com'.length))
  }
  const base = like.replace(/\s+/g, '') || 'Testvalue'
  let out = ''
  while (out.length < n) out += base
  return out.slice(0, n)
}

const midpoint = (min?: string, max?: string): string | undefined => {
  const a = min !== undefined ? Number(min) : undefined
  const b = max !== undefined ? Number(max) : undefined
  if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) return String(Math.floor((a + b) / 2))
  if (a !== undefined && Number.isFinite(a)) return String(a)
  if (b !== undefined && Number.isFinite(b)) return String(b)
  return undefined
}

/**
 * Is this option a prompt rather than a choice? "-- Choose --", "Select one",
 * "All". A word-boundary regex alone is not enough: in "-- choose --" there is
 * no boundary after the dashes, so the punctuation has to go first.
 */
export function isPlaceholderOption(option: string): boolean {
  const words = option
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!words) return true
  return /^(select|choose|please|any|all|none|pick|other)\b/.test(words)
}

const firstRealOption = (options: string[] | undefined): string | undefined => options?.find((o) => o.trim() && !isPlaceholderOption(o))

/**
 * One valid value per field. Every negative design changes exactly one field
 * away from this baseline — the single-fault assumption that makes a failure
 * attributable to the thing being tested.
 */
export function baselineInput(form: FormDescriptor, pageRules: string[], data: Record<string, string>): { input: Record<string, string>; skip?: string } {
  const input: Record<string, string> = {}
  let firstPassword: string | undefined

  for (const field of form.fields) {
    const label = field.label
    const c = constraintsFor(field, pageRules)
    const type = field.type.toLowerCase()
    const named = data[field.name ?? ''] ?? data[label] ?? data[label.toLowerCase()]

    if (named !== undefined) {
      input[label] = named
      continue
    }

    if (field.pattern) {
      // No value can be generated from a regular expression in general, and a
      // guess that fails the pattern would test the pattern instead of the
      // thing under test. The user can supply one as test data.
      return { input: {}, skip: `the field "${label}" accepts only values matching ${field.pattern}; add a value for it under Settings → Test data and this form can be designed for.` }
    }

    switch (type) {
      case 'email':
        input[label] = '{{unique_email}}'
        continue
      case 'password': {
        if (firstPassword !== undefined && isConfirmField(label)) {
          input[label] = firstPassword
          continue
        }
        const len = Math.max(c.minLength ?? 8, 12)
        const v = passwordOfLength(c.maxLength !== undefined ? Math.min(len, c.maxLength) : len)
        firstPassword = v
        input[label] = v
        continue
      }
      case 'tel':
        input[label] = '{{phone}}'
        continue
      case 'number':
      case 'range':
        input[label] = midpoint(field.min, field.max) ?? '1'
        continue
      case 'date':
      case 'datetime-local':
      case 'month':
        input[label] = /birth|dob|born/i.test(label) ? '{{adult_birth_date}}' : '{{future_date}}'
        continue
      case 'url':
        input[label] = 'https://example.com'
        continue
      case 'select': {
        const opt = firstRealOption(field.options)
        if (opt) input[label] = opt
        continue
      }
      case 'checkbox':
        if (field.required) input[label] = 'checked'
        continue
      case 'radio':
        continue
      case 'file':
        input[label] = 'image'
        continue
      default:
        break
    }

    let value: string
    if (/user ?name|^login$/i.test(label)) value = 'tp{{unique_id}}'
    else if (/first|given/i.test(label)) value = 'Ada'
    else if (/last|sur ?name|family/i.test(label)) value = 'Lovelace'
    else if (/full ?name|^name$|your name/i.test(label)) value = 'Ada Lovelace'
    else if (/zip|post ?code/i.test(label)) value = data.postcode ?? '90210'
    else if (/city|town/i.test(label)) value = 'Springfield'
    else if (/address|street|line ?1/i.test(label)) value = '12 Test Street'
    else if (/country/i.test(label)) value = data.country ?? 'United States'
    else if (/search|query/i.test(label)) value = 'test'
    else value = `Test {{unique_id}}`

    // Respect the declared length limits even for the valid case.
    if (c.maxLength !== undefined && value.length > c.maxLength && !value.includes('{{')) value = value.slice(0, c.maxLength)
    if (c.minLength !== undefined && value.length < c.minLength && !value.includes('{{')) value = stringOfLength(c.minLength, value)
    input[label] = value
  }

  return { input }
}

// ---------------------------------------------------------------- design keys

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function designKeyFor(pageUrl: string, form: string, field: string, technique: string, variant: string): string {
  // The URL SHAPE, not the URL: /products/3 and /products/9 are the same page
  // as far as a test design is concerned.
  const shape = shapeOf(pageUrl)
  return createHash('sha1').update([shape, norm(form), norm(field), technique, variant].join('|')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- instructions

const quoteValue = (v: string): string => (v === 'checked' ? 'tick it' : `"${v}"`)

/**
 * Render a design as a plain-English instruction, from a template.
 *
 * A template rather than a model call, so that a designed suite can be produced
 * with no API key at all — and so the instruction says exactly what the design
 * says, every time.
 */
export function renderInstruction(d: Omit<TestDesign, 'instruction' | 'designKey'>, submitLabel: string): string {
  const entries = Object.entries(d.input)
  const fields = entries.length ? entries.map(([label, value]) => `${label} = ${quoteValue(value)}`).join('; ') : 'leave every field empty'
  const empty = entries.filter(([, v]) => v === '').map(([label]) => label)
  const emptyNote = empty.length ? ` Leave ${empty.map((l) => `"${l}"`).join(' and ')} empty.` : ''
  const submit = submitLabel ? ` Submit the form with "${submitLabel}".` : ' Submit the form.'

  const acceptance = d.expectAccepted
    ? `Verify that the submission is ACCEPTED: the form is no longer shown, or a confirmation appears, and no error about ${d.field ? `"${d.field}"` : 'the data entered'} is shown.`
    : `Verify that the submission is REJECTED: ${d.field ? `the field "${d.field}" is reported as invalid, or an error message about it is shown` : 'an error message is shown'}, and the form is still displayed.`

  return (
    `Open ${d.pageUrl}. In the ${d.form ? `"${d.form}"` : ''} form enter: ${fields}.${emptyNote}${submit} ` +
    `${acceptance} The page states: ${d.oracleText}`
  ).replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------- the engine

const AREA_WEIGHT: Record<string, number> = { auth: 1, checkout: 1, form: 2, cart: 2, admin: 2 }
const MAX_PER_FORM = 12
const MAX_PER_PROJECT = 60

/** Forms that exist to filter a list, not to submit data. */
function isFilterForm(form: FormDescriptor): boolean {
  if (form.fields.length === 0) return true
  return form.fields.every((f) => /search|query|filter|sort/i.test(f.label) || f.type === 'select' || f.type === 'search')
}

/** A form whose submit label suggests it destroys something. */
const DESTRUCTIVE = /delete|remove|deactivate|close account|cancel (?:order|subscription)|wipe|reset all/i

export function designTests(input: DesignInput): DesignResult {
  const designs: TestDesign[] = []
  const notes: string[] = []
  const data = input.testData ?? {}
  /**
   * Keys already produced, across the WHOLE project.
   *
   * The key is built from the URL *shape*, so /products/3 and /products/9 are
   * deliberately the same page as far as a design is concerned — which means
   * two such pages with the same form yield the same key, and that is the
   * point: it is one design, not two. The database enforces the same
   * uniqueness, so a per-form check is not enough.
   */
  const seenKeys = new Set<string>()

  const ordered = [...input.pages].sort((a, b) => (AREA_WEIGHT[a.kind] ?? 3) - (AREA_WEIGHT[b.kind] ?? 3))

  for (const page of ordered) {
    if (page.kind === 'blocked') continue
    const pageRules = page.rules ?? []
    for (const form of page.forms ?? []) {
      if (isFilterForm(form)) continue
      if (DESTRUCTIVE.test(form.submitLabel || form.name)) {
        notes.push(`No tests were designed for the "${form.submitLabel || form.name}" form on ${page.url}: it looks destructive, and a generated test must not delete anything.`)
        continue
      }

      const { input: baseline, skip } = baselineInput(form, pageRules, data)
      if (skip) {
        notes.push(`${page.url}: ${skip}`)
        continue
      }

      const formName = form.submitLabel || form.name || 'the'
      const auth: 'anonymous' | 'signed-in' = page.kind === 'auth' ? 'anonymous' : page.requiresAuth ? 'signed-in' : 'anonymous'
      const area = page.kind
      const perForm: TestDesign[] = []

      const add = (
        d: Omit<TestDesign, 'designKey' | 'instruction'> & { variant: string },
      ): void => {
        const { variant, ...rest } = d
        const designKey = designKeyFor(page.url, formName, rest.field ?? '', rest.technique, variant)
        if (seenKeys.has(designKey) || perForm.some((x) => x.designKey === designKey)) return
        seenKeys.add(designKey)
        perForm.push({ ...rest, designKey, instruction: renderInstruction(rest, form.submitLabel) })
      }

      // ---- the happy path: the baseline, accepted.
      add({
        variant: 'valid',
        title: `The "${formName}" form accepts valid details`,
        kind: 'happy-path',
        technique: 'equivalence',
        pageUrl: page.url,
        area,
        form: formName,
        input: baseline,
        expectAccepted: true,
        oracle: 'stated-rule',
        oracleText: 'a form that is filled in correctly must be accepted',
        confidence: 'declared',
        auth,
        priority: 1,
      })

      for (const field of form.fields) {
        const label = field.label
        const type = field.type.toLowerCase()
        const c = constraintsFor(field, pageRules)
        const confidence: 'declared' | 'parsed-text' = c.declaredLength ? 'declared' : 'parsed-text'
        const baseValue = baseline[label] ?? ''

        // ---- required: leave exactly this field empty.
        if (field.required && type !== 'checkbox' && type !== 'file') {
          add({
            variant: 'empty',
            title: `"${label}" is required on the "${formName}" form`,
            kind: 'negative',
            technique: 'required',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: '' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: `the field is marked required`,
            confidence: 'declared',
            auth,
            priority: 1,
          })
        }

        // ---- boundary: one below the minimum length, and the minimum itself.
        if (c.minLength !== undefined && c.minLength > 1) {
          const belowValue = type === 'password' ? passwordOfLength(c.minLength - 1) : stringOfLength(c.minLength - 1, baseValue || 'Testvalue')
          add({
            variant: 'min-1',
            title: `"${label}" of ${c.minLength - 1} characters is refused on the "${formName}" form`,
            kind: 'negative',
            technique: 'boundary',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: belowValue, ...confirmAlso(form, label, belowValue) },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: c.minLengthText ?? `at least ${c.minLength} characters`,
            confidence,
            auth,
            priority: 1,
          })
          const atValue = type === 'password' ? passwordOfLength(c.minLength) : stringOfLength(c.minLength, baseValue || 'Testvalue')
          add({
            variant: 'min',
            title: `"${label}" of exactly ${c.minLength} characters is accepted on the "${formName}" form`,
            kind: 'edge',
            technique: 'boundary',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: atValue, ...confirmAlso(form, label, atValue) },
            expectAccepted: true,
            oracle: 'stated-rule',
            oracleText: c.minLengthText ?? `at least ${c.minLength} characters`,
            confidence,
            auth,
            priority: 2,
          })
        }

        // ---- boundary: one above the maximum length. Only worth testing when
        // the limit is NOT a maxlength attribute: the browser simply will not
        // let a longer value be typed, so the test could never exercise it.
        if (c.maxLength !== undefined && field.maxLength === undefined) {
          const overValue = type === 'password' ? passwordOfLength(c.maxLength + 1) : stringOfLength(c.maxLength + 1, baseValue || 'Testvalue')
          add({
            variant: 'max+1',
            title: `"${label}" of ${c.maxLength + 1} characters is refused on the "${formName}" form`,
            kind: 'negative',
            technique: 'boundary',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: overValue, ...confirmAlso(form, label, overValue) },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: c.maxLengthText ?? `at most ${c.maxLength} characters`,
            confidence,
            auth,
            priority: 2,
          })
        }

        // ---- boundary: numeric range.
        if (type === 'number' || type === 'range') {
          const step = Number(field.step ?? '1') || 1
          if (field.min !== undefined && Number.isFinite(Number(field.min))) {
            const min = Number(field.min)
            add({
              variant: 'below-min',
              title: `"${label}" below ${min} is refused on the "${formName}" form`,
              kind: 'negative',
              technique: 'boundary',
              pageUrl: page.url,
              area,
              form: formName,
              field: label,
              input: { ...baseline, [label]: String(min - step) },
              expectAccepted: false,
              oracle: 'stated-rule',
              oracleText: `min="${field.min}"`,
              confidence: 'declared',
              auth,
              priority: 1,
            })
            add({
              variant: 'at-min',
              title: `"${label}" of exactly ${min} is accepted on the "${formName}" form`,
              kind: 'edge',
              technique: 'boundary',
              pageUrl: page.url,
              area,
              form: formName,
              field: label,
              input: { ...baseline, [label]: String(min) },
              expectAccepted: true,
              oracle: 'stated-rule',
              oracleText: `min="${field.min}"`,
              confidence: 'declared',
              auth,
              priority: 2,
            })
          }
          if (field.max !== undefined && Number.isFinite(Number(field.max))) {
            const max = Number(field.max)
            add({
              variant: 'above-max',
              title: `"${label}" above ${max} is refused on the "${formName}" form`,
              kind: 'negative',
              technique: 'boundary',
              pageUrl: page.url,
              area,
              form: formName,
              field: label,
              input: { ...baseline, [label]: String(max + step) },
              expectAccepted: false,
              oracle: 'stated-rule',
              oracleText: `max="${field.max}"`,
              confidence: 'declared',
              auth,
              priority: 1,
            })
          }
        }

        // ---- format: an email that is not one.
        if (type === 'email') {
          add({
            variant: 'bad-format',
            title: `"${label}" rejects an address that is not an email on the "${formName}" form`,
            kind: 'negative',
            technique: 'format',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: 'not-an-email' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: 'type="email"',
            confidence: 'declared',
            auth,
            priority: 1,
          })
        }
        if (type === 'url') {
          add({
            variant: 'bad-format',
            title: `"${label}" rejects a malformed address on the "${formName}" form`,
            kind: 'negative',
            technique: 'format',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: 'not a url' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: 'type="url"',
            confidence: 'declared',
            auth,
            priority: 2,
          })
        }
        if (type === 'number') {
          add({
            variant: 'bad-format',
            title: `"${label}" rejects letters on the "${formName}" form`,
            kind: 'negative',
            technique: 'format',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: 'abc' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: 'type="number"',
            confidence: 'declared',
            auth,
            priority: 3,
          })
        }

        // ---- equivalence: a confirmation field that does not match.
        if (type === 'password' && isConfirmField(label) && baseValue) {
          add({
            variant: 'mismatch',
            title: `The "${formName}" form refuses two different passwords`,
            kind: 'negative',
            technique: 'equivalence',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: passwordOfLength(baseValue.length + 2) + 'x' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: 'a confirmation field must match the value it confirms',
            confidence: 'declared',
            auth,
            priority: 1,
          })
        }

        // ---- uniqueness: the page says a value can already be taken.
        const dupRule = pageRules.find((r) => DUPLICATE_RULE.test(r))
        if (dupRule && input.testUser && (type === 'email' || /user ?name/i.test(label))) {
          add({
            variant: 'duplicate',
            title: `The "${formName}" form refuses a ${type === 'email' ? 'duplicate email address' : 'name that is taken'}`,
            kind: 'negative',
            technique: 'uniqueness',
            pageUrl: page.url,
            area,
            form: formName,
            field: label,
            input: { ...baseline, [label]: '{{test_user}}' },
            expectAccepted: false,
            oracle: 'stated-rule',
            oracleText: `"${dupRule}"`,
            confidence: 'parsed-text',
            auth,
            priority: 1,
          })
        }

        // ---- selection: try each option of a small select.
        if (type === 'select' && field.options && field.options.length >= 2 && field.options.length <= 6) {
          for (const option of field.options) {
            if (!option.trim() || isPlaceholderOption(option)) continue
            add({
              variant: `option:${norm(option)}`,
              title: `The "${formName}" form accepts "${option}" for "${label}"`,
              kind: 'edge',
              technique: 'selection',
              pageUrl: page.url,
              area,
              form: formName,
              field: label,
              input: { ...baseline, [label]: option },
              expectAccepted: true,
              oracle: 'stated-rule',
              oracleText: `"${option}" is one of the options the page offers for ${label}`,
              confidence: 'declared',
              auth,
              priority: 3,
            })
          }
        }
      }

      // Keep the most valuable designs when a form has many fields. A design
      // that is dropped here releases its key, so an identical form reached by
      // another route can still contribute one.
      perForm.sort((a, b) => a.priority - b.priority)
      const kept = perForm.slice(0, MAX_PER_FORM)
      for (const dropped of perForm.slice(MAX_PER_FORM)) seenKeys.delete(dropped.designKey)
      designs.push(...kept)
      if (perForm.length > MAX_PER_FORM) {
        notes.push(`The "${formName}" form on ${page.url} could yield ${perForm.length} tests; the ${MAX_PER_FORM} most valuable were kept.`)
      }
    }

    designs.push(...designListing(page, seenKeys))
  }

  // Project-wide cap, highest value first, then by how important the area is.
  designs.sort((a, b) => a.priority - b.priority || (AREA_WEIGHT[a.area] ?? 3) - (AREA_WEIGHT[b.area] ?? 3))
  if (designs.length > MAX_PER_PROJECT) {
    notes.push(`${designs.length} tests could be designed for this application; the ${MAX_PER_PROJECT} most valuable were kept. Run the designer again after reviewing these.`)
  }
  return { designs: designs.slice(0, MAX_PER_PROJECT), notes }
}

/** A confirmation field must follow the field it confirms. */
function confirmAlso(form: FormDescriptor, changedLabel: string, value: string): Record<string, string> {
  const changed = form.fields.find((f) => f.label === changedLabel)
  if (!changed || changed.type.toLowerCase() !== 'password' || isConfirmField(changedLabel)) return {}
  const confirm = form.fields.find((f) => f.type.toLowerCase() === 'password' && isConfirmField(f.label))
  return confirm ? { [confirm.label]: value } : {}
}

/**
 * Search, filter and sort, which are not forms with data in them but are where
 * a great many real defects live. These are written as flows for the model to
 * execute, because the steps depend on what the page does.
 */
function designListing(page: DiscoveredPage, seen?: Set<string>): TestDesign[] {
  if (page.kind !== 'listing') return []
  const samples = (page.samples ?? []).filter((s) => s.length >= 3)
  if (samples.length === 0) return []
  const out: TestDesign[] = []
  const searchForm = (page.forms ?? []).find((f) => f.fields.some((x) => /search|query/i.test(x.label) || x.type === 'search'))
  const term = samples[0].split(/\s+/)[0]

  const push = (variant: string, title: string, instruction: string, priority: 1 | 2 | 3, oracleText: string) => {
    const designKey = designKeyFor(page.url, 'listing', '', 'flow', variant)
    if (seen?.has(designKey)) return
    seen?.add(designKey)
    out.push({
      designKey,
      title,
      kind: 'flow',
      technique: 'flow',
      pageUrl: page.url,
      area: page.kind,
      form: searchForm?.submitLabel ?? 'search',
      input: {},
      expectAccepted: true,
      oracle: 'implicit',
      oracleText,
      confidence: 'declared',
      auth: page.requiresAuth ? 'signed-in' : 'anonymous',
      priority,
      instruction,
    })
  }

  if (searchForm) {
    push(
      'search-finds',
      `Searching for "${term}" finds it`,
      `Open ${page.url}. Search for "${term}". Verify that at least one result is listed and that "${samples[0]}" is among them.`,
      1,
      'a search for a word in an item name must return that item',
    )
    push(
      'search-case',
      `Searching for "${term}" ignores letter case`,
      `Open ${page.url}. Search for "${term.toLowerCase()}" and count the results, then search for "${term.toUpperCase()}". Verify that both searches return the same number of results.`,
      2,
      'a search must not depend on letter case',
    )
    push(
      'search-nonsense',
      'Searching for something that does not exist returns nothing',
      `Open ${page.url}. Search for "zzqx{{unique_id}}". Verify that no items are listed, or that a message saying nothing was found is shown.`,
      2,
      'a search with no matches must return no items rather than all of them',
    )
  }

  const filter = (page.forms ?? []).flatMap((f) => f.fields).find((x) => x.type === 'select' && (x.options?.length ?? 0) >= 2 && !/sort/i.test(x.label))
  if (filter) {
    const option = firstRealOption(filter.options)
    if (option) {
      push(
        'filter-persists',
        `The "${filter.label}" filter stays applied when changing page`,
        `Open ${page.url}. Set "${filter.label}" to "${option}". Verify the listed items match it. Then go to the next page of results, if there is one, and verify that "${filter.label}" is still set to "${option}" and that every listed item still matches it.`,
        2,
        'a filter must stay applied when moving between pages of results',
      )
    }
  }

  const sort = (page.forms ?? []).flatMap((f) => f.fields).find((x) => x.type === 'select' && /sort|order/i.test(x.label))
  if (sort) {
    const option = firstRealOption(sort.options)
    if (option) {
      push(
        'sort-ordered',
        `Sorting by "${option}" really orders the list`,
        `Open ${page.url}. Set "${sort.label}" to "${option}". Read the listed values, then use assertOrder to verify the first few appear in the order "${option}" implies.`,
        2,
        'a sort option must order the results it claims to order',
      )
    }
  }

  return out
}
