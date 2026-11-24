/**
 * Test-data placeholders. Each run gets fresh unique values so tests like
 * "register with {{unique_email}}" never collide with earlier runs — part of
 * the "clear test data after each run" strategy (M3).
 *
 * Two kinds of value live here. GENERATED ones are derived fresh per run: a
 * unique email, a date relative to today, a phone number in the range reserved
 * for fiction. PROJECT ones come from the project's own test data, because no
 * amount of generation can invent a coupon code or a product name that the
 * application under test will actually accept.
 *
 * SECURITY: `{{test_password}}` is a secret. It is deliberately NOT expanded
 * into the instruction that goes to the LLM; the model types the placeholder
 * literally and the executor substitutes the real value in the browser.
 */

export interface PlaceholderValues {
  unique_email: string
  unique_id: string
  unique_name: string
  phone: string
  today: string
  tomorrow: string
  future_date: string
  past_date: string
  adult_birth_date: string
  test_card: string
  test_user: string
  test_password: string
  base_url: string
  /** the project's own fixtures, addressed as {{data.<key>}} */
  data: Record<string, string>
}

const SECRET_KEYS = new Set<string>(['test_password'])

/** ISO `YYYY-MM-DD`, which is what `<input type="date">` accepts from fill(). */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

const shiftDays = (from: Date, days: number): Date => new Date(from.getTime() + days * 24 * 60 * 60 * 1000)

export function makePlaceholderValues(opts: {
  baseUrl: string
  testUser?: string | null
  testPassword?: string | null
  seed?: string
  /** Project.testData, already parsed */
  data?: Record<string, string>
  /** overridable so tests can pin the date */
  now?: Date
}): PlaceholderValues {
  const seed = (opts.seed ?? '').replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  const uid = `${stamp}${rand}${seed}`
  const now = opts.now ?? new Date()
  const birth = new Date(now)
  birth.setFullYear(birth.getFullYear() - 30)

  return {
    unique_email: `tp.${uid}@example.com`,
    unique_id: uid,
    unique_name: `Test User ${rand.toUpperCase()}`,
    // +1 202 555 01xx is reserved for fiction, so it can never reach a real person.
    phone: `+1 202 555 01${String(Math.abs(hash(uid)) % 100).padStart(2, '0')}`,
    today: isoDate(now),
    tomorrow: isoDate(shiftDays(now, 1)),
    future_date: isoDate(shiftDays(now, 30)),
    past_date: isoDate(shiftDays(now, -30)),
    adult_birth_date: isoDate(birth),
    // The number every payment sandbox accepts, and no real processor does.
    test_card: '4242 4242 4242 4242',
    test_user: opts.testUser ?? '',
    test_password: opts.testPassword ?? '',
    base_url: opts.baseUrl,
    data: opts.data ?? {},
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Every resolvable name and its value, flattened — `data.coupon` included. */
export function placeholderEntries(values: PlaceholderValues): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(values)) {
    if (k === 'data') continue
    if (typeof v === 'string') out.push([k, v])
  }
  for (const [k, v] of Object.entries(values.data ?? {})) out.push([`data.${k}`, String(v)])
  return out
}

function replace(text: string, values: PlaceholderValues, allow: (name: string) => boolean): string {
  return text.replace(/\{\{\s*([a-z_]+(?:\.[a-z0-9_-]+)?)\s*\}\}/gi, (m, raw: string) => {
    const name = raw.toLowerCase()
    if (!allow(name)) return m
    if (name.startsWith('data.')) {
      const key = raw.slice('data.'.length)
      const found = values.data?.[key] ?? values.data?.[key.toLowerCase()]
      // An unknown key is left as-is rather than silently blanked: a test that
      // types an empty string looks like it passed for the wrong reason.
      return found ?? m
    }
    const direct = (values as unknown as Record<string, unknown>)[name]
    return typeof direct === 'string' ? direct : m
  })
}

/**
 * Expand every NON-secret placeholder. Safe to send to the LLM: the model needs
 * the generated email/id so it can assert on them later.
 */
export function applyPublicPlaceholders(text: string, values: PlaceholderValues): string {
  return replace(text, values, (name) => !SECRET_KEYS.has(name))
}

/** Expand secrets only — called inside the browser-facing executor. */
export function applySecretPlaceholders(text: string, values: PlaceholderValues): string {
  return replace(text, values, (name) => SECRET_KEYS.has(name))
}

/** Expand everything (tests, non-LLM paths). */
export function applyPlaceholders(text: string, values: PlaceholderValues): string {
  return replace(text, values, () => true)
}

/** Redact secret values that may have leaked into a log line. */
export function redact(text: string, values: PlaceholderValues): string {
  let out = text
  for (const k of SECRET_KEYS) {
    const v = (values as unknown as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.length >= 3) out = out.split(v).join('{{' + k + '}}')
  }
  return out
}

/** A one-line summary of the data a test may use, for the prompt. */
export function describeTestData(values: PlaceholderValues): string {
  const entries = Object.entries(values.data ?? {})
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `{{data.${k}}} = "${v}"`).join(' · ')
}
