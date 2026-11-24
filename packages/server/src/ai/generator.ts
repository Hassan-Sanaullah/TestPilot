/**
 * M2 (generation half): keeps the per-run conversation with the model and asks
 * for the next structured action. Validation lives in engine/validator.ts.
 *
 * Context management is inherited from the navigator: older observations are
 * blanked (their indices are stale anyway) so the prompt stays small.
 */
import type { LLMRouter } from './router'
import { parseJsonObject } from './router'
import { GENERATOR_SYSTEM } from './prompts'
import type { ChatMessage } from './provider'

export interface GeneratedStep {
  raw: unknown
  usage: { prompt: number; completion: number }
  cached: boolean
  provider: string
  /** which model answered, recorded on the run for the cost estimate */
  model: string
}

export class StepGenerator {
  private messages: ChatMessage[]
  private observationIdx: number[] = []

  constructor(
    private readonly llm: LLMRouter,
    instruction: string,
    opts: { baseUrl: string; testUser?: string | null; hasPassword?: boolean; loggedIn?: boolean; startUrl?: string; testData?: string },
  ) {
    // The password is NEVER included. The model types the literal
    // "{{test_password}}" and the executor substitutes it in the browser.
    const account = opts.testUser
      ? `\nTest account (use only if the instruction requires logging in): username/email "${opts.testUser}"` +
        (opts.hasPassword ? `, password: type the literal text "{{test_password}}" — it is substituted for you.` : ' (no password stored).')
      : ''
    const session = opts.loggedIn ? '\nA saved login session is loaded, so you may already be signed in — check before logging in again.' : ''
    // Saying where the browser already is stops the model spending its first
    // actions navigating to a page it is looking at.
    const start = opts.startUrl && opts.startUrl !== opts.baseUrl ? `\nThe browser is already open on ${opts.startUrl}, which is the page this test is about.` : ''
    const data = opts.testData ? `\nTest data you may use (type the placeholder, it is substituted for you): ${opts.testData}` : ''
    this.messages = [
      { role: 'system', content: GENERATOR_SYSTEM },
      { role: 'user', content: `Application under test: ${opts.baseUrl}${account}${session}${start}${data}\n\nTEST INSTRUCTION:\n${instruction}` },
    ]
  }

  addObservation(text: string): void {
    this.observationIdx.push(this.messages.length)
    this.messages.push({ role: 'user', content: `OBSERVATION:\n${text}` })
    this.trim()
  }

  addProposal(rawText: string): void {
    this.messages.push({ role: 'assistant', content: rawText })
  }

  addRejection(reason: string): void {
    this.messages.push({
      role: 'user',
      content: `VALIDATOR REJECTED your last action: ${reason}\nReply with a corrected JSON object using only supported actions and indices from the current observation.`,
    })
  }

  addResult(text: string): void {
    this.messages.push({ role: 'user', content: `RESULT: ${text}` })
  }

  addNote(text: string): void {
    this.messages.push({ role: 'user', content: `[note] ${text}` })
  }

  /**
   * Keep only the last N observations verbatim.
   *
   * Two rather than three: a reply may now plan several actions, so each
   * observation covers more of the test and older ones are correspondingly
   * less useful — while the element indices in them are stale either way.
   */
  private trim(keep = 2): void {
    for (const i of this.observationIdx.slice(0, -keep)) {
      if (this.messages[i]?.content.startsWith('OBSERVATION:')) {
        this.messages[i] = { role: 'user', content: '[older observation omitted]' }
      }
    }
  }

  async next(): Promise<GeneratedStep> {
    // Gemini counts thinking tokens against max_tokens; too small a cap comes
    // back empty and costs a whole extra round trip.
    const res = await this.llm.step({ messages: this.messages, json: true, temperature: 0.1, maxTokens: 1500 })
    this.addProposal(res.content)
    let raw: unknown
    try {
      raw = parseJsonObject(res.content)
    } catch (e) {
      raw = { __parseError: (e as Error).message, text: res.content.slice(0, 200) }
    }
    return { raw, usage: res.usage, cached: Boolean(res.cached), provider: res.provider, model: `${res.provider}/${res.model}` }
  }

  get history(): readonly ChatMessage[] {
    return this.messages
  }
}
