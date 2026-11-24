# Choosing a paid LLM for TestPilot

A comparison to decide from later. Costs are modelled on **this project's measured token usage**,
not on generic estimates.

> **Prices checked 13 November 2026** from third-party trackers, which disagreed with each other on
> several models. Treat every figure as indicative and confirm on the provider's own pricing page
> before committing. Links at the bottom.

---

## 1. The short answer

**At your scale, cost is not the deciding factor — pick on reliability and quality.**

Running TestPilot for an entire final-year project costs roughly **$0.06 – $2.20 in total**,
depending on provider. That is the whole thing: authoring every test, re-authoring after changes,
coverage profiling, missing-test generation and bug reports. The gap between the cheapest and the
most expensive option is about **two dollars**.

So the question is not "which is cheapest" but "which produces correct tests with the fewest
failures", and secondarily "which is fastest to work with".

| If you want | Use | Total project cost |
|---|---|---|
| **Best results, cost irrelevant** | Claude Sonnet 5.5 (reasoning) + GPT-5 mini (steps) | ~$1.50 |
| **Best value — recommended** | GPT-5 mini for both roles | **~$0.29** |
| **Cheapest that is still sane** | GPT-5 nano (steps) + Claude Haiku 5.5 (reasoning) | ~$0.08 |
| **Stay free** | Gemini Flash-Lite + Groq (current setup) | $0 |

---

## 2. Why cost barely matters now

TestPilot uses the model to **author** a test once, then compiles it into a deterministic
Playwright script. Re-runs replay that script with **no model in the loop**.

Measured on this machine, across 54 real runs:

| | AI authoring run | Replay |
|---|---|---|
| LLM calls | 6.5 average | **0** |
| Input tokens | 17,498 average | **0** |
| Output tokens | 326 average | **0** |
| Wall clock | 15–22 s | 5–11 s |

**31 replay runs consumed zero tokens.** Cost therefore scales with *how many tests you write*,
not with *how often you run them*. You can run the suite in CI a thousand times a day for nothing.

This is the single most important fact for budgeting, and it is why a paid key is affordable even
on a student budget.

---

## 3. The workload being priced

Measured from your own runs:

- **Authoring one test:** 17,500 input + 330 output tokens
- **Explore + write a suite:** ~4,000 input + 1,500 output (one reasoning call)
- **Coverage profile:** ~5,000 input + 800 output
- **Missing-test generation:** ~6,000 input + 1,500 output
- **Bug report:** ~3,000 input + 400 output
- **Replay:** zero

Note the shape: **input dominates output by about 54 to 1**. Input price is what matters; output
price is almost irrelevant. This also means **prompt caching is worth more than a cheaper headline
rate** — within one authoring run the system prompt and instruction repeat across all 6.5 calls.
Providers that discount cached input (OpenAI ~90% off, Anthropic ~90% off, Gemini, DeepSeek) could
cut the real bill by roughly a third to a half. The tables below do **not** assume caching, so they
are pessimistic.

### A whole FYP, modelled

20 tests, each authored twice (once, then re-authored after an app change), 3 suite generations,
10 coverage profiles, 5 gap generations, 15 bug reports, unlimited replays:

**≈ 840,000 input tokens + 40,000 output tokens.**

---

## 4. Cost comparison

### Whole project (840K in / 40K out)

| Provider & model | Input $/M | Output $/M | **Project total** | Notes |
|---|---|---|---|---|
| **GPT-5 nano** | 0.05 | 0.40 | **$0.06** | Cheapest credible option |
| **Claude Haiku 5.5** | 0.10 | 0.50 | **$0.10** | Strong instruction-following for the price |
| **Groq gpt-oss-20b** | 0.075 | 0.30 | **$0.08** | Open-weight, very fast |
| **DeepSeek V4.1-Flash** | 0.15 | 0.60 | **$0.15** | Off-peak; doubles at peak |
| **Mistral Small 4** | 0.15 | 0.60 | **$0.15** | |
| **Groq gpt-oss-120b** | 0.15 | 0.60 | **$0.15** | Open-weight, fastest inference |
| **Gemini 3.1 Flash-Lite** | 0.25 | 1.50 | **$0.27** | Paid version of your current model |
| **GPT-5 mini** | 0.25 | 2.00 | **$0.29** | ← best quality-per-dollar |
| **Gemini 3.5 Flash-Lite** | 0.30 | 2.50 | **$0.35** | |
| **Grok 4.3** | 1.25 | 2.50 | **$1.15** | |
| **Claude Sonnet 5.5** | 2.00 | 10.00 | **$2.08** | Best reasoning in this list |
| **Gemini 3.1 Pro** | 2.00 | 12.00 | **$2.16** | |

### Per 100 tests authored (1.75M in / 33K out)

Use this if your suite grows well beyond the FYP.

| Model | Cost per 100 tests | Cost per test |
|---|---|---|
| GPT-5 nano | $0.10 | $0.001 |
| Claude Haiku 5.5 | $0.19 | $0.002 |
| DeepSeek / Groq 120b | $0.28 | $0.003 |
| GPT-5 mini | $0.50 | $0.005 |
| Gemini 3.5 Flash-Lite | $0.61 | $0.006 |
| Grok 4.3 | $2.27 | $0.023 |
| Claude Sonnet 5.5 | $3.83 | $0.038 |
| Gemini 3.1 Pro | $3.90 | $0.039 |

Even a thousand-test suite authored on the most expensive model here costs under **$40, once**.

---

## 5. What actually matters, beyond price

TestPilot asks two very different things of a model, and they are configured separately
(`LLM_STEP_PROVIDER` / `LLM_REASON_PROVIDER`):

**Step model** — called 6–8 times per authoring run. Must return a single valid JSON action every
time, grounded in a list of page elements. Needs: reliable structured output, good instruction
following, low latency. Does **not** need deep reasoning — the action schema and validator already
constrain it.

**Reasoning model** — called a handful of times per project for coverage analysis, missing-test
generation, instruction rewriting and bug reports. Needs judgement; latency and cost barely matter
because the volume is tiny.

| Factor | Why it matters here | Best performers |
|---|---|---|
| **Structured-output reliability** | An invalid JSON reply costs a whole retry. Observed on the free tier: Gemini returned empty replies when its thinking budget consumed `max_tokens` | OpenAI, Anthropic |
| **Latency** | Directly sets authoring time. Measured: Gemini Flash-Lite 3.2s default, **1.3s with `reasoning_effort: minimal`** | Groq (fastest), GPT-5 nano/mini |
| **Rate limits** | The real pain of the free tier. Any paid tier removes it | All paid |
| **Prompt caching** | Your workload is 54:1 input-heavy; caching is worth more than a lower rate | OpenAI, Anthropic, Gemini, DeepSeek |
| **Reasoning quality** | Determines whether generated tests assert something meaningful | Claude Sonnet, Gemini Pro, GPT-5 mini |
| **Stability** | Free Gemini returned 503s under load during testing | Paid tiers generally |

### Practical cautions

- **Gemini renames models often.** Two models that worked in testing (`gemini-2.0-flash-lite`,
  `gemini-2.5-flash-lite`) were already retired. The **AI settings** page lists what your key can
  actually reach — check it after any change.
- **DeepSeek has peak/off-peak pricing**, so the headline rate is not what you always pay.
- **Groq hosts open-weight models.** Excellent speed and price, but a different quality class from
  frontier models — fine for steps, weaker for the reasoning role.
- **Check the provider is billable from your country** before relying on it. This is a real
  blocker for some providers in some regions and is worth five minutes of checking first.

---

## 6. Recommended configurations

All three work with the existing code; nothing needs rewriting.

### A. Recommended — GPT-5 mini for everything (~$0.29 total)

Simplest, one key, strong structured output, good enough reasoning.

```ini
LLM_PROFILE=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-mini
OPENAI_REASON_MODEL=gpt-5-mini
LLM_STEP_EFFORT=minimal
```

### B. Best results — cheap steps, strong reasoning (~$1.50 total)

The split the architecture was designed for. Costs more only where judgement matters.

```ini
LLM_PROFILE=openai
LLM_STEP_PROVIDER=openai
LLM_REASON_PROVIDER=anthropic   # see note below
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-mini
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5-5
```

> Anthropic is **not wired in yet**. Its API is not OpenAI-compatible, so it needs a small provider
> class (~40 lines) alongside the existing one. Say the word and I will add it. Everything else in
> this document works today.

### C. Cheapest sane (~$0.08 total)

```ini
LLM_PROFILE=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-nano
OPENAI_REASON_MODEL=gpt-5-mini
LLM_STEP_EFFORT=minimal
```

### D. Stay free

What you have now. Fine for development; the limit you will hit is requests per day, not money.

```ini
LLM_PROFILE=free
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_REASON_MODEL=gemini-3.5-flash
```

---

## 7. How to decide, concretely

Because switching is one `.env` change and a restart, you can **measure rather than guess**:

1. Keep the free setup as your baseline.
2. Put $5 on one paid provider.
3. Delete the compiled scripts for 5 tests (`Re-author` in the UI) and author them on each model.
4. Compare, from the dashboard's own numbers:
   - how many runs passed first time without validator rejections,
   - whether the generated tests assert something specific or something vague,
   - authoring time per test,
   - tokens used (shown per run).
5. Keep the winner. $5 will cover far more than this experiment.

This is also a defensible section for the thesis: a measured provider comparison on your own
workload, rather than a quoted benchmark.

---

## 8. Sources

Prices collected 13 November 2026. Third-party trackers disagreed on several models — verify
officially before committing.

- Official: [OpenAI](https://platform.openai.com/pricing) ·
  [Anthropic](https://www.anthropic.com/pricing) ·
  [Google Gemini](https://ai.google.dev/gemini-api/docs/pricing) ·
  [Groq](https://groq.com/pricing) · [DeepSeek](https://platform.deepseek.com/api-docs/pricing)
- Trackers consulted: [API Evangelist](https://apievangelist.com/2026/11/06/openai-api-pricing-what-every-model-costs-per-million-tokens/) ·
  [SpendLint](https://spendlint.dev/pricing/openai-api) ·
  [benchlm](https://benchlm.ai/llm-pricing) ·
  [maximem](https://www.maximem.ai/blog/llm-api-pricing-comparison-2026) ·
  [aipricing.guru](https://www.aipricing.guru/anthropic-pricing/)

All token figures in sections 2–4 are measured from this project's own database, not estimated.
