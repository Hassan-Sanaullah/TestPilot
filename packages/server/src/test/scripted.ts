/**
 * A scripted model for tests, with one addition over `MockProvider`: a step may
 * say *which element* it wants by label instead of by index.
 *
 * Element indices are assigned fresh at every observation, so a test that
 * hard-codes `index: 0` is really asserting the order of the page's elements —
 * it breaks whenever the markup changes, for reasons that have nothing to do
 * with what is being tested. `{ click: 'Help centre' }` reads the index out of
 * the observation the engine just produced, which is what a model would do.
 */
import { MockProvider, type CompleteRequest, type CompleteResult } from '../ai/provider'

export interface ScriptedStep {
  /** a literal action, used as-is */
  action?: Record<string, unknown>
  thought?: string
  /** click the element whose label contains this text */
  click?: string
  /** type into the element whose label contains this text */
  type?: { into: string; text: string; submit?: boolean }
  /** select a value in the element whose label contains this text */
  select?: { in: string; value: string }
}

/** `  [12] button "Accept all cookies"` → 12 */
export function indexOfLabel(observation: string, needle: string): number | null {
  const want = needle.toLowerCase()
  const lines = observation.split('\n')
  for (const line of lines) {
    const m = /^\s*\[(\d+)]\s+\S+\s+"([^"]*)"/.exec(line)
    if (m && m[2].toLowerCase().includes(want)) return Number(m[1])
  }
  return null
}

export class ScriptedProvider extends MockProvider {
  private steps: ScriptedStep[] = []
  /** labels the script asked for that were not on the page */
  readonly misses: string[] = []

  script(...steps: ScriptedStep[]): this {
    this.steps.push(...steps)
    return this
  }

  override async complete(req: CompleteRequest): Promise<CompleteResult> {
    const step = this.steps.shift()
    const reply = (body: Record<string, unknown>): CompleteResult => ({
      content: JSON.stringify(body),
      usage: { prompt: 0, completion: 0 },
      provider: 'mock',
      model: 'scripted',
    })
    if (!step) return reply({ thought: 'nothing scripted', action: { type: 'finish', verdict: 'pass', reason: 'end of script' } })
    if (step.action) return reply({ thought: step.thought ?? '', action: step.action })

    // The last user message holds the observation the engine just rendered.
    const observation = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const resolve = (label: string): number | null => {
      const i = indexOfLabel(observation, label)
      if (i === null) this.misses.push(label)
      return i
    }

    if (step.click) {
      const index = resolve(step.click)
      if (index === null) return reply({ thought: `cannot see ${step.click}`, action: { type: 'find', text: step.click } })
      return reply({ thought: step.thought ?? `click ${step.click}`, action: { type: 'click', index } })
    }
    if (step.type) {
      const index = resolve(step.type.into)
      if (index === null) return reply({ thought: `cannot see ${step.type.into}`, action: { type: 'find', text: step.type.into } })
      return reply({ thought: step.thought ?? `type into ${step.type.into}`, action: { type: 'type', index, text: step.type.text, ...(step.type.submit ? { submit: true } : {}) } })
    }
    if (step.select) {
      const index = resolve(step.select.in)
      if (index === null) return reply({ thought: `cannot see ${step.select.in}`, action: { type: 'find', text: step.select.in } })
      return reply({ thought: step.thought ?? `select in ${step.select.in}`, action: { type: 'select', index, value: step.select.value } })
    }
    return reply({ thought: 'empty scripted step', action: { type: 'finish', verdict: 'fail', reason: 'the test script had an empty step' } })
  }
}

/** A provider that fails the test outright if the model is consulted at all. */
export function forbiddenProvider(): MockProvider {
  const m = new MockProvider()
  m.complete = async () => {
    throw new Error('the model must not be called here')
  }
  return m
}
