/**
 * The design engine, on fixtures, with no browser and no model.
 *
 * The claim being tested is that the same application always yields the same
 * tests, and that the tests are the ones a tester would write: the value one
 * below the minimum, the required field left empty, the confirmation that does
 * not match. If this is right, the suite is defensible; if it depends on what a
 * model felt like writing, it is not.
 */
import { describe, expect, it } from 'vitest'
import type { DiscoveredPage, FormDescriptor } from '../engine/explorer'
import { baselineInput, constraintsFor, designTests, passwordOfLength, renderInstruction } from './design'

const page = (over: Partial<DiscoveredPage> = {}): DiscoveredPage => ({
  url: 'http://app.test/register',
  title: 'Register',
  kind: 'auth',
  forms: [],
  actions: [],
  rules: [],
  headings: [],
  samples: [],
  reachedVia: 'start',
  requiresAuth: false,
  ...over,
})

const registrationForm = (over: Partial<FormDescriptor> = {}): FormDescriptor => ({
  name: 'register',
  submitLabel: 'Create account',
  fields: [
    { label: 'Name', type: 'text', required: true, hint: '' },
    { label: 'Email', type: 'email', required: true, hint: '' },
    { label: 'Password', type: 'password', required: true, hint: 'At least 8 characters', minLength: 8 },
    { label: 'Confirm password', type: 'password', required: true, hint: '' },
  ],
  ...over,
})

const keysOf = (designs: { technique: string; field?: string; title: string }[]) => designs.map((d) => `${d.technique}:${d.field ?? '-'}`)

describe('reading the constraints', () => {
  it('prefers what the HTML declares', () => {
    const c = constraintsFor({ label: 'Password', type: 'password', required: true, hint: 'At least 12 characters', minLength: 8 }, [])
    expect(c.minLength).toBe(8)
    expect(c.declaredLength).toBe(true)
    expect(c.minLengthText).toContain('minlength="8"')
  })

  it('falls back to the rule the page states in words', () => {
    const c = constraintsFor({ label: 'Password', type: 'password', required: true, hint: 'At least 8 characters' }, [])
    expect(c.minLength).toBe(8)
    expect(c.declaredLength).toBe(false)
    expect(c.minLengthText).toContain('At least 8 characters')
  })

  it('reads several English phrasings', () => {
    const forHint = (hint: string) => constraintsFor({ label: 'Code', type: 'text', required: false, hint }, [])
    expect(forHint('minimum of 6 characters').minLength).toBe(6)
    expect(forHint('8+ characters').minLength).toBe(8)
    expect(forHint('must be 10 or more characters').minLength).toBe(10)
    expect(forHint('no more than 20 characters').maxLength).toBe(20)
    expect(forHint('between 3 and 20 characters')).toMatchObject({ minLength: 3, maxLength: 20 })
  })

  it('reads a rule stated elsewhere on the page that names the field', () => {
    const c = constraintsFor({ label: 'Password', type: 'password', required: true, hint: '' }, ['Your Password must be at least 9 characters long'])
    expect(c.minLength).toBe(9)
  })
})

describe('the baseline input', () => {
  it('fills every field with something valid', () => {
    const { input } = baselineInput(registrationForm(), [], {})
    expect(input['Email']).toBe('{{unique_email}}')
    expect(input['Name']).toBe('Ada Lovelace')
    expect(input['Password'].length).toBeGreaterThanOrEqual(12)
    // A confirmation field has to match, or every test fails for that reason.
    expect(input['Confirm password']).toBe(input['Password'])
  })

  it('refuses to guess a value for a field with a pattern, and says why', () => {
    const form = registrationForm({ fields: [{ label: 'Reference', type: 'text', required: true, hint: '', pattern: '^[A-Z]{2}-\\d{4}$' }] })
    const { input, skip } = baselineInput(form, [], {})
    expect(input).toEqual({})
    expect(skip).toContain('Test data')
  })

  it('uses a value the project supplied for such a field', () => {
    const form = registrationForm({ fields: [{ label: 'Reference', type: 'text', required: true, hint: '', pattern: '^[A-Z]{2}-\\d{4}$', name: 'ref' }] })
    const { input, skip } = baselineInput(form, [], { ref: 'AB-1234' })
    expect(skip).toBeUndefined()
    expect(input['Reference']).toBe('AB-1234')
  })

  it('picks the midpoint of a numeric range', () => {
    const form = registrationForm({ fields: [{ label: 'Quantity', type: 'number', required: true, hint: '', min: '1', max: '11' }] })
    expect(baselineInput(form, [], {}).input['Quantity']).toBe('6')
  })

  it('picks a real option, not the placeholder one', () => {
    const form = registrationForm({ fields: [{ label: 'Country', type: 'select', required: true, hint: '', options: ['-- choose --', 'Spain', 'Peru'] }] })
    expect(baselineInput(form, [], {}).input['Country']).toBe('Spain')
  })
})

describe('password values for a length boundary', () => {
  it('keeps the character classes so only the length varies', () => {
    // The point: ShopMax accepts a short password when it contains a digit.
    // A test that uses "123" for the too-short case is rejected for the wrong
    // reason and never finds that. Every length must still satisfy the
    // composition rules.
    for (const n of [4, 7, 8, 12, 30]) {
      const v = passwordOfLength(n)
      expect(v).toHaveLength(n)
      expect(v).toMatch(/[A-Z]/)
      expect(v).toMatch(/[a-z]/)
      expect(v).toMatch(/[0-9]/)
      expect(v).toMatch(/[^A-Za-z0-9]/)
    }
  })
})

describe('designing for a registration form', () => {
  const result = designTests({ pages: [page({ forms: [registrationForm()] })], testUser: 'test@example.com' })

  it('produces the cases a tester would write', () => {
    const keys = keysOf(result.designs)
    expect(keys).toContain('equivalence:-') // the happy path
    expect(keys).toContain('required:Name')
    expect(keys).toContain('required:Email')
    expect(keys).toContain('boundary:Password')
    expect(keys).toContain('format:Email')
    expect(keys).toContain('equivalence:Confirm password')
  })

  it('tests one below the minimum AND the minimum itself', () => {
    const below = result.designs.find((d) => d.technique === 'boundary' && d.title.includes('7 characters'))
    const at = result.designs.find((d) => d.technique === 'boundary' && d.title.includes('exactly 8'))
    expect(below?.expectAccepted).toBe(false)
    expect(at?.expectAccepted).toBe(true)
    expect(below!.input['Password']).toHaveLength(7)
    expect(at!.input['Password']).toHaveLength(8)
    // Only the length differs from a valid password.
    expect(below!.input['Password']).toMatch(/[A-Z].*[0-9]|[0-9].*[A-Z]/)
    expect(below!.input['Password']).toMatch(/[^A-Za-z0-9]/)
  })

  it('changes the confirmation field alongside the password it confirms', () => {
    const below = result.designs.find((d) => d.technique === 'boundary' && d.title.includes('7 characters'))!
    expect(below.input['Confirm password']).toBe(below.input['Password'])
  })

  it('quotes the rule each test rests on', () => {
    const boundary = result.designs.find((d) => d.technique === 'boundary')!
    expect(boundary.oracle).toBe('stated-rule')
    expect(boundary.oracleText).toContain('minlength="8"')
    expect(boundary.confidence).toBe('declared')
  })

  it('marks a rule read from a sentence as less certain', () => {
    const textOnly = designTests({
      pages: [
        page({
          forms: [
            registrationForm({
              fields: [
                { label: 'Email', type: 'email', required: true, hint: '' },
                { label: 'Password', type: 'password', required: true, hint: 'At least 8 characters' },
              ],
            }),
          ],
        }),
      ],
    })
    const boundary = textOnly.designs.find((d) => d.technique === 'boundary' && d.title.includes('7 characters'))
    expect(boundary).toBeTruthy()
    expect(boundary!.confidence).toBe('parsed-text')
    expect(boundary!.oracleText).toContain('At least 8 characters')
  })

  it('tests a duplicate email when the page says one can be taken', () => {
    const withRule = designTests({
      pages: [page({ forms: [registrationForm()], rules: ['That email address is already registered.'] })],
      testUser: 'test@example.com',
    })
    const dup = withRule.designs.find((d) => d.technique === 'uniqueness')
    expect(dup).toBeTruthy()
    expect(dup!.input['Email']).toBe('{{test_user}}')
    expect(dup!.expectAccepted).toBe(false)
  })

  it('writes an instruction that names the rule and the expected outcome', () => {
    const below = result.designs.find((d) => d.title.includes('7 characters'))!
    expect(below.instruction).toContain('Create account')
    expect(below.instruction).toContain('REJECTED')
    expect(below.instruction).toContain('The page states')
    expect(below.instruction).toContain('Password =')
  })
})

describe('designing for a numeric field', () => {
  const designs = designTests({
    pages: [
      page({
        url: 'http://app.test/cart',
        kind: 'cart',
        forms: [{ name: 'qty', submitLabel: 'Update', fields: [{ label: 'Quantity', type: 'number', required: true, hint: '', min: '1', max: '10', step: '1' }] }],
      }),
    ],
  }).designs

  it('tests just outside and just inside both ends', () => {
    const values = designs.filter((d) => d.technique === 'boundary').map((d) => ({ v: d.input['Quantity'], ok: d.expectAccepted }))
    expect(values).toEqual(
      expect.arrayContaining([
        { v: '0', ok: false },
        { v: '1', ok: true },
        { v: '11', ok: false },
      ]),
    )
  })
})

describe('determinism and caps', () => {
  it('produces byte-identical designs for identical input', () => {
    const input = { pages: [page({ forms: [registrationForm()] })], testUser: 'test@example.com' }
    const a = designTests(input).designs
    const b = designTests(input).designs
    expect(a.map((d) => d.designKey)).toEqual(b.map((d) => d.designKey))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('gives the same key to the same design on two pages of one shape', () => {
    const one = designTests({ pages: [page({ url: 'http://app.test/items/3', kind: 'form', forms: [registrationForm()] })] }).designs
    const two = designTests({ pages: [page({ url: 'http://app.test/items/9', kind: 'form', forms: [registrationForm()] })] }).designs
    expect(one.map((d) => d.designKey)).toEqual(two.map((d) => d.designKey))
  })

  it('keeps the project within its cap and says what it dropped', () => {
    const manyFields = Array.from({ length: 20 }, (_, i) => ({ label: `Field ${i}`, type: 'text', required: true, hint: '', minLength: 4 }))
    const pages = Array.from({ length: 12 }, (_, i) => page({ url: `http://app.test/f${i}`, kind: 'form', forms: [{ name: 'f', submitLabel: 'Save', fields: manyFields }] }))
    const r = designTests({ pages })
    expect(r.designs.length).toBeLessThanOrEqual(60)
    expect(r.notes.join(' ')).toMatch(/most valuable were kept/)
  })

  it('never produces the same design key twice, across pages of one shape', () => {
    // The key is built from the URL SHAPE, so two product pages are the same
    // page as far as a design is concerned. That is deliberate — but it means
    // the same form reached twice must yield ONE design, not a duplicate key
    // the database then rejects.
    const form = { name: 'add', submitLabel: 'Add to cart', fields: [{ label: 'Quantity', type: 'number', required: true, hint: '', min: '1', max: '10' }] }
    const r = designTests({
      pages: [
        page({ url: 'http://app.test/products/3', kind: 'detail', forms: [form] }),
        page({ url: 'http://app.test/products/9', kind: 'detail', forms: [form] }),
        page({ url: 'http://app.test/products/42', kind: 'detail', forms: [form] }),
      ],
    })
    const keys = r.designs.map((d) => d.designKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.length).toBeGreaterThan(0)
  })

  it('puts the most valuable tests first', () => {
    const r = designTests({ pages: [page({ forms: [registrationForm()] })], testUser: 'test@example.com' })
    const priorities = r.designs.map((d) => d.priority)
    expect([...priorities]).toEqual([...priorities].sort((a, b) => a - b))
  })

  it('refuses to design a test that would delete something', () => {
    const r = designTests({
      pages: [page({ url: 'http://app.test/account', kind: 'form', forms: [{ name: 'del', submitLabel: 'Delete my account', fields: [{ label: 'Password', type: 'password', required: true, hint: '' }] }] })],
    })
    expect(r.designs).toHaveLength(0)
    expect(r.notes.join(' ')).toMatch(/looks destructive/)
  })

  it('ignores a search box, which is a filter and not a form to submit data to', () => {
    const r = designTests({ pages: [page({ url: 'http://app.test/products', kind: 'listing', forms: [{ name: 's', submitLabel: 'Search', fields: [{ label: 'Search', type: 'search', required: false, hint: '' }] }] })] })
    expect(r.designs.filter((d) => d.technique !== 'flow')).toHaveLength(0)
  })
})

describe('designing for a listing page', () => {
  const r = designTests({
    pages: [
      page({
        url: 'http://app.test/products',
        kind: 'listing',
        samples: ['Aurora Desk Lamp', 'Nimbus Wireless Mouse', 'Cobalt Notebook'],
        forms: [
          {
            name: 'filters',
            submitLabel: 'Apply',
            fields: [
              { label: 'Search', type: 'search', required: false, hint: '' },
              { label: 'Category', type: 'select', required: false, hint: '', options: ['All', 'Lighting', 'Office'] },
              { label: 'Sort by', type: 'select', required: false, hint: '', options: ['Price: low to high', 'Newest'] },
            ],
          },
        ],
      }),
    ],
  })

  it('searches for something that actually exists', () => {
    const search = r.designs.find((d) => d.title.includes('Searching for "Aurora"'))
    expect(search).toBeTruthy()
    expect(search!.instruction).toContain('Aurora Desk Lamp')
  })

  it('covers case-insensitivity, no matches, a persistent filter and a real sort', () => {
    const titles = r.designs.map((d) => d.title).join(' | ')
    expect(titles).toMatch(/ignores letter case/)
    expect(titles).toMatch(/does not exist returns nothing/)
    expect(titles).toMatch(/stays applied when changing page/)
    expect(titles).toMatch(/really orders the list/)
  })

  it('designs nothing for a listing with no sample items to search for', () => {
    const bare = designTests({ pages: [page({ url: 'http://app.test/empty', kind: 'listing', samples: [] })] })
    expect(bare.designs).toHaveLength(0)
  })
})

describe('rendering an instruction', () => {
  it('names the empty field when a required-field test leaves one blank', () => {
    const text = renderInstruction(
      {
        title: 't',
        kind: 'negative',
        technique: 'required',
        pageUrl: 'http://app.test/register',
        area: 'auth',
        form: 'Create account',
        field: 'Email',
        input: { Name: 'Ada', Email: '' },
        expectAccepted: false,
        oracle: 'stated-rule',
        oracleText: 'the field is marked required',
        confidence: 'declared',
        auth: 'anonymous',
        priority: 1,
      },
      'Create account',
    )
    expect(text).toContain('Leave "Email" empty')
    expect(text).toContain('REJECTED')
    expect(text).toContain('reported as invalid')
  })
})
