/**
 * Routes LLM calls by role and provides the fallback chain:
 *
 *   step()   — high-volume, cheap per-step generation  (default: Gemini Flash-Lite)
 *   reason() — low-volume reasoning: coverage, gaps, bug reports (default: Groq gpt-oss-120b)
 *
 * Chain for each call: preferred provider → every other configured provider →
 * cached response for an identical prompt → error. (Risk table: "retry with
 * backoff; fall back to cached results or a second provider".)
 */
import { createHash } from 'node:crypto'
import { config, type ProviderName } from '../config'
import { prisma } from '../db'
import { type CompleteRequest, type CompleteResult, type LLMProvider, LLMError, MockProvider, OpenAICompatProvider } from './provider'

export type CallKind = 'step' | 'reason'

export class LLMRouter {
  readonly providers: Record<string, LLMProvider>
  readonly mock: MockProvider

  constructor(
    providers: Record<string, LLMProvider>,
    private readonly stepName: ProviderName,
    private readonly reasonName: ProviderName,
    private readonly cacheFirst = false,
  ) {
    this.mock = (providers.mock as MockProvider | undefined) ?? new MockProvider()
    this.providers = { ...providers, mock: this.mock }
  }

  /** Providers in preference order for a given role (configured ones only). */
  order(kind: CallKind): LLMProvider[] {
    const preferred = kind === 'step' ? this.stepName : this.reasonName
    const other = kind === 'step' ? this.reasonName : this.stepName
    const names = [preferred, other, 'gemini', 'groq', 'openai'] as const
    const seen = new Set<string>()
    const out: LLMProvider[] = []
    for (const n of names) {
      const p = this.providers[n]
      if (!p || seen.has(n) || !p.configured) continue
      if (n === 'mock' && preferred !== 'mock') continue
      seen.add(n)
      out.push(p)
    }
    if (out.length === 0) out.push(this.mock) // nothing configured → mock, so the app still runs
    return out
  }

  step(req: CompleteRequest): Promise<CompleteResult> {
    // Per-step decisions are heavily constrained by the action schema and the
    // validator, so deep reasoning buys little and costs ~2s a call.
    return this.run('step', { effort: config.llm.stepEffort, ...req })
  }

  reason(req: CompleteRequest): Promise<CompleteResult> {
    return this.run('reason', req)
  }

  /**
   * Models to try on one provider, in order. Reasoning prefers the provider's
   * stronger `reasonModel` (which usually has a smaller free daily quota) and
   * falls back to its default model.
   */
  private modelsFor(p: LLMProvider, kind: CallKind): (string | undefined)[] {
    if (kind === 'reason' && p.reasonModel && p.reasonModel !== p.model) return [p.reasonModel, undefined]
    return [undefined]
  }

  private async run(kind: CallKind, req: CompleteRequest): Promise<CompleteResult> {
    const hash = createHash('sha256').update(kind).update(JSON.stringify(req.messages)).digest('hex')
    if (this.cacheFirst) {
      const hit = await this.cached(hash)
      if (hit) return hit
    }
    let lastErr: unknown
    for (const p of this.order(kind)) {
      for (const model of this.modelsFor(p, kind)) {
        try {
          const res = await p.complete(model ? { ...req, model } : req)
          if (p.name !== 'mock') void this.store(hash, kind, res)
          return res
        } catch (e) {
          lastErr = e
          console.warn(`[llm] ${p.name}${model ? `/${model}` : ''} failed for ${kind}: ${(e as Error).message}`)
        }
      }
    }
    const hit = await this.cached(hash)
    if (hit) {
      console.warn('[llm] all providers failed — serving cached response')
      return hit
    }
    throw lastErr instanceof Error ? lastErr : new LLMError('no LLM provider available', 'router')
  }

  private async cached(hash: string): Promise<CompleteResult | null> {
    const row = await prisma.llmCache.findUnique({ where: { hash } }).catch(() => null)
    if (!row) return null
    return { content: row.response, usage: { prompt: 0, completion: 0 }, provider: 'cache', model: row.model, cached: true }
  }

  private async store(hash: string, kind: CallKind, res: CompleteResult): Promise<void> {
    await prisma.llmCache
      .upsert({
        where: { hash },
        create: { hash, kind, model: `${res.provider}/${res.model}`, response: res.content },
        update: { response: res.content, model: `${res.provider}/${res.model}` },
      })
      .catch(() => undefined)
  }

  /** Human-readable summary for logs and the Settings page. */
  describe(): { profile: string; step: string; reason: string; providers: { name: string; model: string; reasonModel: string; configured: boolean }[] } {
    const list = (['gemini', 'groq', 'openai'] as const).map((n) => {
      const p = this.providers[n]
      return { name: n, model: p?.model ?? '', reasonModel: p?.reasonModel ?? '', configured: Boolean(p?.configured) }
    })
    const first = (k: CallKind) => {
      const o = this.order(k)[0]
      const m = this.modelsFor(o, k)[0] ?? o.model
      return `${o.name} (${m})`
    }
    return { profile: config.llm.profile, step: first('step'), reason: first('reason'), providers: list }
  }
}

export function buildRouter(): LLMRouter {
  const c = config.llm
  return new LLMRouter(
    {
      gemini: new OpenAICompatProvider(c.providers.gemini),
      groq: new OpenAICompatProvider(c.providers.groq),
      openai: new OpenAICompatProvider(c.providers.openai),
    },
    c.stepProvider,
    c.reasonProvider,
    c.cacheFirst,
  )
}

export const llm = buildRouter()

/** Extract a JSON object from a model reply (tolerates code fences / prose). */
export function parseJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    throw new Error(`model did not return valid JSON: ${t.slice(0, 120)}`)
  }
}
