import { describe, expect, it } from 'vitest'
import { LLMRouter } from './router'
import { type CompleteRequest, type CompleteResult, type LLMProvider, MockProvider } from './provider'

class FailingProvider implements LLMProvider {
  readonly configured = true
  readonly model = 'x'
  calls = 0
  constructor(readonly name: string) {}
  async complete(_req: CompleteRequest): Promise<CompleteResult> {
    this.calls++
    throw new Error(`${this.name} down`)
  }
  async listModels() {
    return []
  }
}

describe('LLM router fallback chain', () => {
  it('falls back to the next configured provider when the preferred one fails', async () => {
    const gemini = new FailingProvider('gemini')
    const groq = new MockProvider().enqueue({ ok: true })
    const router = new LLMRouter({ gemini, groq }, 'gemini', 'groq')
    const res = await router.step({ messages: [{ role: 'user', content: 'hi' }] })
    expect(gemini.calls).toBe(1)
    expect(res.provider).toBe('mock')
    expect(JSON.parse(res.content)).toEqual({ ok: true })
  })

  it('orders providers by role', () => {
    const gemini = new MockProvider()
    const groq = new FailingProvider('groq')
    const router = new LLMRouter({ gemini, groq }, 'gemini', 'groq')
    expect(router.order('step').map((p) => p.name)).toEqual(['mock', 'groq'])
    expect(router.order('reason').map((p) => p.name)).toEqual(['groq', 'mock'])
  })

  it('uses the mock provider when nothing is configured', () => {
    const router = new LLMRouter({}, 'gemini', 'groq')
    expect(router.order('step')[0].name).toBe('mock')
  })
})

/** Provider that records the model of each call and can fail the first N. */
class ModelSpyProvider implements LLMProvider {
  readonly configured = true
  readonly models: (string | undefined)[] = []
  constructor(
    readonly name: string,
    readonly model: string,
    readonly reasonModel?: string,
    private failModels: string[] = [],
  ) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.models.push(req.model)
    const used = req.model ?? this.model
    if (this.failModels.includes(used)) throw new Error(`${used} quota exceeded`)
    return { content: '{}', usage: { prompt: 0, completion: 0 }, provider: this.name, model: used }
  }
  async listModels() {
    return []
  }
}

describe('per-role models on one provider', () => {
  it('uses the step model for step calls and the stronger model for reasoning', async () => {
    const gemini = new ModelSpyProvider('gemini', 'flash-lite', 'flash')
    const router = new LLMRouter({ gemini }, 'gemini', 'gemini')
    await router.step({ messages: [] })
    await router.reason({ messages: [] })
    expect(gemini.models).toEqual([undefined, 'flash']) // undefined = provider default (flash-lite)
    expect(router.describe().step).toBe('gemini (flash-lite)')
    expect(router.describe().reason).toBe('gemini (flash)')
  })

  it('falls back to the cheaper model when the reasoning model is out of quota', async () => {
    const gemini = new ModelSpyProvider('gemini', 'flash-lite', 'flash', ['flash'])
    const router = new LLMRouter({ gemini }, 'gemini', 'gemini')
    const res = await router.reason({ messages: [] })
    expect(gemini.models).toEqual(['flash', undefined])
    expect(res.model).toBe('flash-lite')
  })
})
