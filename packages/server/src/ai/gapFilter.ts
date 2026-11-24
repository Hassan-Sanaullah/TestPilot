/**
 * M5 (filter half) — deterministic duplicate detection and feasibility check.
 * Pure functions; unit-tested.
 */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'that', 'then', 'verify', 'check', 'should', 'be', 'it', 'as', 'at', 'by', 'from',
  'page', 'button', 'link', 'field', 'input', 'form', 'element', 'user', 'users', 'can', 'this', 'into', 'their', 'click', 'open',
])

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

export interface NearestMatch {
  index: number
  score: number
}

/** Index + similarity of the most similar existing text (or null if none). */
export function nearest(candidate: string, existing: string[]): NearestMatch | null {
  let best: NearestMatch | null = null
  existing.forEach((e, index) => {
    const score = jaccard(candidate, e)
    if (!best || score > best.score) best = { index, score }
  })
  return best
}

export const DUPLICATE_THRESHOLD = 0.8
export const AMBIGUOUS_THRESHOLD = 0.4

export type Feasibility = 'feasible' | 'infeasible' | 'unknown'

/**
 * A proposed test is feasible when every piece of UI it depends on matches
 * something in the observed inventory (DOM-only knowledge of the app).
 * Matching is lenient: one meaningful token in common with a label.
 */
export function checkFeasibility(neededUi: string[], inventoryLabels: string[]): { feasibility: Feasibility; missing: string[] } {
  if (inventoryLabels.length === 0) return { feasibility: 'unknown', missing: [] }
  if (neededUi.length === 0) return { feasibility: 'feasible', missing: [] }
  const labelTokens = inventoryLabels.map((l) => tokens(l))
  const missing: string[] = []
  for (const need of neededUi) {
    const nt = tokens(need)
    if (nt.size === 0) continue // only generic words ("submit button") → can't judge, assume present
    const found = labelTokens.some((lt) => [...nt].some((t) => lt.has(t) || [...lt].some((x) => x.startsWith(t) || t.startsWith(x))))
    if (!found) missing.push(need)
  }
  return { feasibility: missing.length ? 'infeasible' : 'feasible', missing }
}
