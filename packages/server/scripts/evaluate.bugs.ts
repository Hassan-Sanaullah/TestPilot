/**
 * Ground truth for the evaluation: the five defects seeded into ShopMax.
 *
 * Matching a bug report to a seeded defect has to be done by keyword, because
 * the report's wording comes from a model. The patterns are deliberately
 * narrow — a report that merely mentions "cart" does not count as having found
 * the coupon bug — because a generous matcher would flatter the result, and the
 * number this produces is the headline claim of the whole project.
 */

export interface SeededBug {
  id: number
  name: string
  /** what correct behaviour would have been, from the demo-shop README */
  correct: string
  /** does this report describe this defect? */
  match: (text: string) => boolean
}

/** Everything a report says, lower-cased and joined, is what gets matched. */
export const reportText = (parts: (string | null | undefined)[]): string => parts.filter(Boolean).join(' \n ').toLowerCase()

const all = (...tests: RegExp[]) => (text: string) => tests.every((r) => r.test(text))
const some = (...tests: RegExp[]) => (text: string) => tests.some((r) => r.test(text))
const and = (...fns: ((t: string) => boolean)[]) => (text: string) => fns.every((f) => f(text))

export const SEEDED_BUGS: SeededBug[] = [
  {
    id: 1,
    name: 'SAVE10 deducts 20% instead of the advertised 10%',
    correct: 'the coupon SAVE10 reduces the subtotal by exactly 10%',
    match: and(some(/save10/, /coupon/, /discount/), some(/10\s*%/, /20\s*%/, /\btotal\b/, /subtotal/)),
  },
  {
    id: 2,
    name: 'Search is case-sensitive',
    correct: 'searching for a product name matches regardless of letter case',
    match: and(some(/search/, /\bquery\b/), some(/case/, /lower\s*-?case/, /upper\s*-?case/, /no results/, /nothing (was )?found/, /0 results/)),
  },
  {
    id: 3,
    name: 'Pagination drops the category filter',
    correct: 'the selected category stays applied when moving to another page of results',
    match: and(some(/filter/, /categor/), some(/page\s*2/, /pagination/, /next page/, /another page/, /second page/)),
  },
  {
    id: 4,
    name: 'Admin order total sorts as text',
    correct: 'the admin order list sorts by total as a number, so $9.99 comes before $1020.40',
    match: and(some(/sort/, /order/), some(/total/, /numeric/, /alphabetic/, /as text/, /string/), some(/admin/, /\$/, /sort/)),
  },
  {
    id: 5,
    name: 'Short password accepted when it contains a digit',
    correct: 'a password shorter than 8 characters is refused, whatever it contains',
    match: and(some(/password/), some(/8 characters/, /too short/, /shorter/, /minimum length/, /length/, /\bab1\b/)),
  },
]

export interface Match {
  bugId: number
  reportId: string
}

/**
 * Pair reports with seeded defects.
 *
 * A report may match more than one pattern; it is credited to the first, and a
 * second report for an already-found defect is a duplicate, not a new find.
 * Reports matching nothing are FALSE REPORTS — the measure that stops
 * "found 5 of 5" from being achievable by reporting everything.
 */
export function scoreReports(reports: { id: string; text: string }[]): {
  found: number[]
  matches: Match[]
  falseReports: string[]
  duplicates: number
} {
  const matches: Match[] = []
  const found = new Set<number>()
  const falseReports: string[] = []
  let duplicates = 0

  for (const report of reports) {
    const hit = SEEDED_BUGS.find((b) => b.match(report.text))
    if (!hit) {
      falseReports.push(report.id)
      continue
    }
    if (found.has(hit.id)) {
      duplicates++
      continue
    }
    found.add(hit.id)
    matches.push({ bugId: hit.id, reportId: report.id })
  }

  return { found: [...found].sort((a, b) => a - b), matches, falseReports, duplicates }
}
