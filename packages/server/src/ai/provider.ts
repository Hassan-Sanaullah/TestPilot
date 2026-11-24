/**
 * LLM providers. Every supported vendor (Gemini via AI Studio, Groq, OpenAI)
 * exposes an OpenAI-compatible /chat/completions endpoint, so a single HTTP
 * client covers all of them. No vendor SDKs.
 *
 * Risk controls (from the project risk table):
 *   - per-provider throttle (min interval) to stay under free-tier RPM caps
 *   - exponential backoff with jitter on 429 / 5xx
 *   - graceful degradation when a model rejects `response_format`
 */
import type { ProviderConfig } from '../config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompleteRequest {
  messages: ChatMessage[]
  /** ask for a JSON object response */
  json?: boolean
  temperature?: number
  maxTokens?: number
  /** override the provider's default model for this one call (per-role models) */
  model?: string
  /**
   * How much the model should "think" before answering. Gemini 3.x reasons by
   * default, which costs ~2s per call — worth it for analysis, wasteful for
   * picking the next click when a schema and validator already constrain the
   * answer. Silently dropped by providers that do not support it.
   */
  effort?: 'minimal' | 'low' | 'medium' | 'high'
}

export interface CompleteResult {
  content: string
  usage: { prompt: number; completion: number }
  provider: string
  model: string
  cached?: boolean
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  /** stronger model used for reasoning calls, when configured */
  readonly reasonModel?: string
  readonly configured: boolean
  complete(req: CompleteRequest): Promise<CompleteResult>
  listModels(): Promise<string[]>
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string
  readonly model: string
  readonly reasonModel?: string
  private lastCallAt = 0
  private supportsJsonMode = true
  /**
   * Adaptive spacing between calls. Starts at the configured floor (0 by
   * default: a fixed delay on every call wastes far more time than the rare
   * 429 costs). A rate-limit response raises it; sustained success decays it
   * back down.
   */
  private adaptiveMs = 0
  private okStreak = 0
  private supportsEffort = true

  constructor(private readonly cfg: ProviderConfig) {
    this.name = cfg.name
    this.model = cfg.model
    this.reasonModel = cfg.reasonModel || undefined
    this.adaptiveMs = cfg.minIntervalMs
  }

  get configured(): boolean {
    return Boolean(this.cfg.apiKey)
  }

  /** Current spacing, exposed for diagnostics. */
  get pacingMs(): number {
    return this.adaptiveMs
  }

  private async throttle(): Promise<void> {
    const gap = Math.max(this.cfg.minIntervalMs, this.adaptiveMs)
    if (gap > 0) {
      const wait = this.lastCallAt + gap - Date.now()
      if (wait > 0) await sleep(wait)
    }
    this.lastCallAt = Date.now()
  }

  private onRateLimited(): void {
    this.okStreak = 0
    this.adaptiveMs = Math.min(20_000, Math.max(1500, this.adaptiveMs * 2 || 1500))
    console.warn(`[llm] ${this.name} rate-limited — spacing calls ${this.adaptiveMs}ms apart`)
  }

  private onSuccess(): void {
    if (this.adaptiveMs <= this.cfg.minIntervalMs) return
    if (++this.okStreak >= 5) {
      this.okStreak = 0
      this.adaptiveMs = Math.max(this.cfg.minIntervalMs, Math.floor(this.adaptiveMs / 2))
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (!this.configured) throw new LLMError(`${this.name}: no API key configured`, this.name)

    const model = req.model || this.model
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.1,
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.json && this.supportsJsonMode) body.response_format = { type: 'json_object' }
    if (req.effort && this.supportsEffort) body.reasoning_effort = req.effort

    let lastErr: LLMError | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle()
      let res: Response
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        })
      } catch (e) {
        lastErr = new LLMError(`${this.name}: network error: ${(e as Error).message}`, this.name)
        await sleep(backoff(attempt))
        continue
      }

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string | null }; finish_reason?: string }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const choice = data.choices?.[0]
        const content = choice?.message?.content ?? ''
        this.onSuccess()
        // An empty reply is usually the output cap hit by a model that spent
        // its budget "thinking". Retry once with more room before giving up.
        if (!content.trim() && attempt < 2) {
          body.max_tokens = Math.min(4000, Number(body.max_tokens ?? 800) * 2)
          lastErr = new LLMError(`${this.name}/${model} returned an empty reply (finish_reason=${choice?.finish_reason ?? 'unknown'})`, this.name)
          continue
        }
        return {
          content,
          usage: { prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 },
          provider: this.name,
          model,
        }
      }

      const text = await res.text().catch(() => '')
      // Some models reject response_format — drop it and retry once.
      if (res.status === 400 && req.json && this.supportsJsonMode && /response_format|json_object/i.test(text)) {
        this.supportsJsonMode = false
        delete body.response_format
        continue
      }
      // Likewise for reasoning_effort, which many models do not accept. The
      // error text is often generic, so retry without it before giving up.
      if (res.status === 400 && this.supportsEffort && body.reasoning_effort !== undefined) {
        this.supportsEffort = false
        delete body.reasoning_effort
        console.warn(`[llm] ${this.name} rejected reasoning_effort — continuing without it`)
        continue
      }
      lastErr = new LLMError(`${this.name}/${model} HTTP ${res.status}: ${text.slice(0, 300)}`, this.name, res.status)
      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429) this.onRateLimited()
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt))
        continue
      }
      throw lastErr // 4xx other than 429: not retryable
    }
    throw lastErr ?? new LLMError(`${this.name}: failed`, this.name)
  }

  async listModels(): Promise<string[]> {
    if (!this.configured) return []
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new LLMError(`${this.name} /models HTTP ${res.status}`, this.name, res.status)
    const data = (await res.json()) as { data?: { id: string }[] }
    return (data.data ?? []).map((m) => m.id.replace(/^models\//, '')).sort()
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500
}

/**
 * Scripted provider for tests and offline demos. Responses are consumed in
 * order; when the queue is empty it returns a `finish(pass)` proposal so the
 * pipeline still terminates.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock'
  readonly model = 'mock'
  readonly configured = true
  protected queue: string[] = []
  readonly calls: CompleteRequest[] = []

  enqueue(...responses: (string | object)[]): this {
    for (const r of responses) this.queue.push(typeof r === 'string' ? r : JSON.stringify(r))
    return this
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push({ ...req, messages: req.messages.map((m) => ({ ...m })) }) // snapshot: callers mutate their arrays
    const content =
      this.queue.shift() ??
      JSON.stringify({ thought: 'mock provider: nothing scripted', action: { type: 'finish', verdict: 'pass', reason: 'mock' } })
    return { content, usage: { prompt: 0, completion: 0 }, provider: 'mock', model: 'mock' }
  }

  async listModels(): Promise<string[]> {
    return ['mock']
  }
}
