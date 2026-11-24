/**
 * What a run cost, roughly.
 *
 * Two reasons this exists. A student on a free tier needs to know when a suite
 * is about to burn the day's quota; and anyone deciding whether to run the AI
 * author or the compiled script needs to see that the script is free.
 *
 * The figures are indicative only: published list prices change, and every
 * caller must present them as an estimate. Tokens are counted exactly, so the
 * ratio between two runs is reliable even when the absolute number drifts.
 */

export interface Price {
  /** matches `provider/model`, as recorded on a run */
  match: RegExp
  /** US dollars per million input tokens */
  inPerM: number
  /** US dollars per million output tokens */
  outPerM: number
  /** free tier: metered, but not billed */
  free?: boolean
}

/**
 * Most specific first: the table is scanned in order, so a pattern for a
 * particular model must precede the catch-all for its provider.
 */
export const PRICES: Price[] = [
  // Free tiers. Metered by requests per day rather than by tokens.
  { match: /^gemini\//i, inPerM: 0, outPerM: 0, free: true },
  { match: /^groq\//i, inPerM: 0, outPerM: 0, free: true },
  { match: /^(mock|cache|scripted)/i, inPerM: 0, outPerM: 0, free: true },

  // Paid, per million tokens.
  { match: /gpt-5-mini|gpt-4o-mini|gpt-4\.1-mini/i, inPerM: 0.15, outPerM: 0.6 },
  { match: /gpt-5-nano|gpt-4\.1-nano/i, inPerM: 0.05, outPerM: 0.4 },
  { match: /gpt-5|gpt-4\.1|gpt-4o/i, inPerM: 2.5, outPerM: 10 },
  { match: /claude.*haiku/i, inPerM: 0.8, outPerM: 4 },
  { match: /claude.*sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /claude.*opus/i, inPerM: 15, outPerM: 75 },
]

export interface CostEstimate {
  /** US dollars; 0 on a free tier */
  usd: number
  free: boolean
  /** true when the model is not in the table, so the figure is a guess of zero */
  unknownModel: boolean
  model: string
  promptTokens: number
  completionTokens: number
}

export function estimateCost(model: string | null | undefined, promptTokens: number, completionTokens: number): CostEstimate {
  const name = (model ?? '').trim()
  const base: Omit<CostEstimate, 'usd' | 'free' | 'unknownModel'> = { model: name, promptTokens, completionTokens }
  if (!name) return { ...base, usd: 0, free: true, unknownModel: true }

  const price = PRICES.find((p) => p.match.test(name))
  if (!price) return { ...base, usd: 0, free: false, unknownModel: true }

  const usd = (promptTokens / 1_000_000) * price.inPerM + (completionTokens / 1_000_000) * price.outPerM
  return { ...base, usd, free: Boolean(price.free), unknownModel: false }
}

/** Add up several runs. */
export function totalCost(runs: { model?: string | null; promptTokens: number; completionTokens: number }[]): CostEstimate & { runs: number } {
  let usd = 0
  let prompt = 0
  let completion = 0
  let anyPaid = false
  let anyUnknown = false
  for (const r of runs) {
    const e = estimateCost(r.model, r.promptTokens, r.completionTokens)
    usd += e.usd
    prompt += r.promptTokens
    completion += r.completionTokens
    if (!e.free) anyPaid = true
    if (e.unknownModel && (r.promptTokens || r.completionTokens)) anyUnknown = true
  }
  return { usd, free: !anyPaid, unknownModel: anyUnknown, model: '', promptTokens: prompt, completionTokens: completion, runs: runs.length }
}

/**
 * How to show it. Below a tenth of a cent the number is noise, so say "under
 * $0.001" rather than printing a row of zeros.
 */
export function formatCost(e: CostEstimate): string {
  if (e.free) return 'free'
  if (e.usd === 0 && e.unknownModel) return 'not priced'
  if (e.usd > 0 && e.usd < 0.001) return 'under $0.001'
  return `≈ $${e.usd.toFixed(e.usd < 1 ? 3 : 2)}`
}
