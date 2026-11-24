/**
 * M3 — the execution engine. One call = one test run:
 *
 *   reset target → launch Chromium (optionally with a saved login session)
 *   → [ observe → generate → validate(≤3) → execute → evidence ]* → verdict
 *
 * Built for real sites: tracks popups/new tabs, auto-handles JS dialogs,
 * restores saved authentication state, and records the exact observation the
 * model saw at every step.
 */
import fs from 'node:fs'
import type { BrowserContext, Page } from 'playwright'
import { type Action, type ObservationData, type RunStatus, type StepDTO, actionSignature, isAssertion, isContentAssertion, isReadOnly } from '@testpilot/shared'
import { config } from '../config'
import { json, prisma } from '../db'
import { runEvents } from '../events'
import { llm as defaultLlm, type LLMRouter } from '../ai/router'
import { StepGenerator } from '../ai/generator'
import { sharedBrowser } from './browserPool'
import { EvidenceStore, stopTracing } from './evidence'
import { Executor } from './executor'
import { InventoryCollector } from './inventory'
import { detectBlocker } from './blockers'
import { collectText, diffText, observe, pageFingerprint, renderChanges, renderObservation, type PageText, type TextChanges } from './perception'
import { applyPublicPlaceholders, describeTestData, makePlaceholderValues, redact } from './placeholders'
import { compileScript } from './script'
import { captureAutoSession, chooseSession, looksSignedOut } from './session'
import { TabSet } from './tabs'
import { mark, timed, type TimingSink } from './timing'
import { isFirstParty, sameTarget } from './urls'
import { validateBatch } from './validator'

export interface RunControl {
  cancelled: boolean
  /** the run's own context; cancelling a run closes it */
  context?: BrowserContext
  /** force headless regardless of config (suite runs); undefined = use config */
  headless?: boolean
  /** optional measurement hook, used by scripts/bench.mts */
  onTiming?: TimingSink
}

export interface RunOutcome {
  status: RunStatus
  verdict?: 'pass' | 'fail' | 'blocked'
  reason: string
  /** app = the application misbehaved; tool = TestPilot could not drive it */
  failureKind?: 'app' | 'tool'
  /**
   * Which kind of oracle decided this. `specified` = the instruction said so;
   * `stated-rule` = the application says so itself; `implicit` = it is wrong on
   * any site; `unstated` = the model inferred an expectation nobody wrote down,
   * which is reported but never trusted at full severity.
   */
  oracle?: 'specified' | 'stated-rule' | 'implicit' | 'unstated'
  /** the index of the step whose assertion failed, when one did */
  failingStep?: number
}

/** A finding from an implicit oracle: wrong on any site, nobody has to specify it. */
export interface Anomaly {
  kind: 'http-5xx' | 'js-error'
  step: number
  url?: string
  status?: number
  message?: string
}

class RunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function executeRun(runId: string, control: RunControl, llm: LLMRouter = defaultLlm): Promise<RunOutcome> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { testCase: { include: { project: true } } } })
  const project = run.testCase.project
  const values = makePlaceholderValues({
    baseUrl: project.baseUrl,
    testUser: project.testUser,
    testPassword: project.testPassword,
    seed: runId,
    data: json<Record<string, string>>(project.testData, {}),
  })
  // Only non-secret placeholders are expanded into the prompt.
  const instruction = applyPublicPlaceholders(run.testCase.instruction, values)
  const log = (message: string) => {
    const safe = redact(message, values)
    if (!process.env.VITEST) console.log(`[run ${runId.slice(-6)}] ${safe}`)
    runEvents.publish({ type: 'run.log', runId, message: safe })
  }
  const maxSteps = project.maxSteps || config.maxSteps
  const allowedDomains = json<string[]>(project.allowedDomains, [])

  await prisma.run.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date() } })
  runEvents.publish({ type: 'run.status', runId, status: 'running' })

  const evidence = new EvidenceStore(runId)
  await evidence.init()
  const inventory = new InventoryCollector()
  let context: BrowserContext | undefined
  let llmCalls = 0
  let promptTokens = 0
  let completionTokens = 0
  let lastModel = ''
  let outcome: RunOutcome = { status: 'error', reason: 'run did not complete' }
  // Implicit oracles: things that are wrong on any site, watched for free.
  const anomalies: Anomaly[] = []
  let currentStep = 0

  try {
    if (project.resetUrl) await resetTarget(project.resetUrl, log)

    const browser = await timed(control.onTiming, 'launch', () => sharedBrowser(control.headless))

    // Which session, and should this test be signed in at all? A test about
    // signing in must not start already signed in.
    const appPages = await prisma.appPage.findMany({ where: { projectId: project.id }, select: { url: true, requiresAuth: true, kind: true } })
    const session = chooseSession(project, run.testCase, appPages)
    const storageState = session.storageState
    log(storageState ? `starting signed in — ${session.why}` : `starting signed out — ${session.why}`)
    context = await browser.newContext({
      viewport: { width: project.viewportWidth, height: project.viewportHeight },
      storageState,
      ignoreHTTPSErrors: true,
    })
    control.context = context
    // Authoring runs are the ones a person actually opens a trace for, so they
    // are always recorded unless tracing is switched off entirely.
    const tracing = config.traceMode !== 'off'
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true, title: run.testCase.title })

    const dialogs: string[] = []
    const attachDialogHandler = (p: Page) => {
      p.on('dialog', async (d) => {
        const note = `${d.type()} dialog: "${d.message()}" → ${project.dialogAction === 'dismiss' ? 'dismissed' : 'accepted'}`
        dialogs.push(note)
        log(note)
        try {
          if (project.dialogAction === 'dismiss') await d.dismiss()
          else await d.accept()
        } catch {
          /* already handled */
        }
      })
    }

    const watchForAnomalies = (p: Page) => {
      p.on('response', (r) => {
        if (anomalies.length >= 20) return
        const req = r.request()
        if (r.status() < 500) return
        // Only the application under test. A third-party script failing is
        // noise the user cannot act on.
        if (!isFirstParty(r.url(), project.baseUrl)) return
        if (!['document', 'xhr', 'fetch'].includes(req.resourceType())) return
        anomalies.push({ kind: 'http-5xx', step: currentStep, url: r.url(), status: r.status() })
        log(`the server returned HTTP ${r.status()} for ${new URL(r.url()).pathname}`)
      })
      p.on('pageerror', (e) => {
        if (anomalies.length >= 20) return
        anomalies.push({ kind: 'js-error', step: currentStep, message: e.message.slice(0, 300) })
      })
    }

    const tabs = new TabSet(context, (p, isFirst) => {
      attachDialogHandler(p)
      watchForAnomalies(p)
      // The very first page is the run opening the browser, not a popup.
      if (!isFirst) log(`a new tab opened: ${p.url()}`)
    })
    const page = await context.newPage()
    tabs.adopt(page)
    page.setDefaultTimeout(10_000)

    // Open the page the test is actually about, when it names one. This saves
    // the navigation steps (and model calls) that every test used to spend
    // finding its way from the home page.
    const startUrl = startingUrl(run.testCase.targetUrl, project.baseUrl)
    log(`opening ${startUrl}`)
    await timed(control.onTiming, 'goto', () => page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 }))

    // A saved session expires. If we meant to be signed in and clearly are not,
    // sign in once more rather than failing a test for an unrelated reason.
    if (session.expectsSignIn) {
      const authPages = appPages.filter((p) => p.kind === 'auth').map((p) => p.url)
      const hasPasswordField = await page.locator('input[type=password]:visible').count().then((n) => n > 0, () => false)
      if (looksSignedOut(page.url(), hasPasswordField, authPages)) {
        log('the saved session looks expired — signing in again')
        const { tryLogin } = await import('./explorer')
        const ok = await tryLogin(page, project.baseUrl, project.testUser ?? '', project.testPassword ?? '')
        if (!ok) throw new RunError('session_expired', 'the saved session has expired and signing in again failed. Record a session in Settings, or check the test account.')
        await captureAutoSession(context, project.id).catch(() => undefined)
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => undefined)
      }
    }

    const gen = new StepGenerator(llm, instruction, {
      baseUrl: project.baseUrl,
      testUser: project.testUser,
      hasPassword: Boolean(project.testPassword),
      loggedIn: Boolean(storageState),
      startUrl,
      testData: describeTestData(values),
    })
    const executor = new Executor(page, values, control.onTiming)
    const recent: string[] = []
    let assertionsPassed = 0
    let substantiveAssertionsPassed = 0
    let failStreak = 0
    let pendingNote: string | null = null
    // Labels and text present before the test changed anything; asserting one
    // of these is not evidence that an outcome occurred.
    let baselineLabels: Set<string> | null = null
    let baselineText: Set<string> | null = null
    let previousText: PageText | null = null
    let previousUrl = ''
    // Steps are counted across the whole run, not per model turn: one reply may
    // plan several actions, and the step limit bounds actions, not thinking.
    let stepIndex = 0
    let lastChanges: TextChanges | null = null

    for (let turn = 1; stepIndex < maxSteps; turn++) {
      if (control.cancelled) throw new RunError('cancelled', 'cancelled by user')

      // ---- OBSERVE (M1)
      tabs.prune()
      if (tabs.pages.length === 0) throw new RunError('no_page', 'every browser tab was closed')
      const activePage = tabs.current
      executor.setPage(activePage)

      const tObserve = Date.now()
      let obs: ObservationData
      try {
        obs = await observe(activePage, { tabCount: tabs.pages.length, activeTab: tabs.active })
      } catch (e) {
        throw new RunError('observe_failed', `could not read the page: ${(e as Error).message}`)
      }
      // What a person could read, and what changed since the last action. This
      // is what lets the model verify an outcome instead of guessing its wording.
      const pageText = await timed(control.onTiming, 'collectText', () => collectText(activePage)).catch(() => ({ text: [], alerts: [] }))
      const navigated = previousUrl !== '' && previousUrl !== obs.url
      const changes = diffText(previousText, pageText, navigated)
      previousText = pageText
      previousUrl = obs.url
      lastChanges = changes

      const observeMs = Date.now() - tObserve
      mark(control.onTiming, 'observe', observeMs)
      inventory.add(obs)
      executor.setObservation(obs)
      if (!baselineLabels) baselineLabels = new Set(obs.elements.map((e) => `${e.role}|${e.label}`))
      if (!baselineText) baselineText = new Set(pageText.text.map(normaliseText))

      // A page that offers almost nothing is usually not a page at all.
      if (obs.elements.length < 3) {
        const blocker = await detectBlocker(activePage)
        if (blocker) throw new RunError('blocked', `${blocker.advice} (${blocker.detail})`)
      }

      const changeText = renderChanges(changes)
      const observationText = renderObservation(obs) + (changeText ? `\n\n${changeText}` : '')
      gen.addObservation(observationText)
      if (dialogs.length) {
        gen.addNote(`The browser handled: ${dialogs.splice(0).join('; ')}`)
      }
      if (pendingNote) {
        gen.addNote(pendingNote)
        pendingNote = null
      }

      // ---- GENERATE + VALIDATE (M2), max 3 attempts
      let batch: Action[] | undefined
      let thought = ''
      let truncationNote: string | undefined
      const rejections: string[] = []
      let attempts = 0
      let lastRaw: unknown = null
      const tThink = Date.now()
      while (attempts < 3 && !batch) {
        if (llmCalls >= project.llmCallBudget) {
          throw new RunError('budget_exceeded', `LLM call budget of ${project.llmCallBudget} exhausted`)
        }
        attempts++
        const g = await gen.next()
        if (!g.cached) llmCalls++
        promptTokens += g.usage.prompt
        completionTokens += g.usage.completion
        lastModel = g.model || lastModel
        lastRaw = g.raw
        const v = validateBatch(g.raw, obs, {
          baseUrl: project.baseUrl,
          allowedDomains,
          recent,
          assertionsPassed,
          substantiveAssertionsPassed,
          tabCount: tabs.pages.length,
          pageText: pageText.text,
        })
        if (v.ok) {
          batch = v.actions
          thought = v.thought
          truncationNote = v.truncated
        } else {
          rejections.push(v.reason)
          gen.addRejection(v.reason)
          log(`turn ${turn}: validator rejected attempt ${attempts} — ${v.reason}`)
        }
      }

      const thinkMs = Date.now() - tThink
      mark(control.onTiming, 'think', thinkMs)
      if (!batch || batch.length === 0) {
        stepIndex++
        const step = await saveStep(runId, {
          index: stepIndex,
          action: { type: 'invalid', proposal: lastRaw },
          thought: '',
          status: 'flagged',
          validationAttempts: attempts,
          rejections,
          error: `Rejected ${attempts}× by the validator: ${rejections.at(-1) ?? ''}`,
          screenshotPath: await evidence.screenshot(activePage, stepIndex),
          url: obs.url,
          durationMs: 0,
          observation: observationText,
          changes,
        })
        runEvents.publish({ type: 'run.step', runId, step })
        outcome = { status: 'failed', verdict: 'fail', reason: `invalid_step: the AI could not produce a valid action at step ${stepIndex} (${rejections.at(-1)})`, failureKind: 'tool' }
        break
      }

      if (batch.length > 1) log(`turn ${turn}: a plan of ${batch.length} actions`)

      // ---- EXECUTE (M3)
      // The page as the model saw it. A plan is only valid while this holds:
      // typing in a field does not change it, but a click that submits,
      // navigates or opens a dialog does, and everything planned after that
      // would be acting on a page the model has never seen.
      const seen = await pageFingerprint(activePage).catch(() => '')
      const tabsAtObserve = tabs.pages.length
      const results: string[] = []
      let stopNote: string | null = truncationNote ?? null
      let executed = 0
      let verdictReached = false

      for (const [b, action] of batch.entries()) {
        if (control.cancelled) throw new RunError('cancelled', 'cancelled by user')
        if (stepIndex >= maxSteps) {
          stopNote = `the step limit (${maxSteps}) was reached part-way through the plan`
          break
        }
        if (b > 0) {
          const now = await pageFingerprint(tabs.current).catch(() => 'changed')
          if (now !== seen || tabs.pages.length !== tabsAtObserve) {
            stopNote = `stopped after ${b} of ${batch.length} actions: the page changed, so the rest of the plan was about a page you had not seen`
            break
          }
        }

        // Skip a navigation to the page we are already on.
        if (action.type === 'navigate' && sameTarget(tabs.current.url(), action.url, project.baseUrl)) {
          stepIndex++
          executed++
          results.push(`${executed}. already on ${action.url}`)
          const step = await saveStep(runId, {
            index: stepIndex,
            action,
            thought: b === 0 ? thought : '(same plan)',
            status: 'ok',
            validationAttempts: attempts,
            rejections: b === 0 ? rejections : [],
            error: null,
            screenshotPath: null,
            url: tabs.current.url(),
            durationMs: 0,
            observation: b === 0 ? observationText : '',
            changes: b === 0 ? changes : null,
          })
          runEvents.publish({ type: 'run.step', runId, step })
          continue
        }

        if (!isReadOnly(action) && action.type !== 'finish') {
          recent.push(actionSignature(action))
          if (recent.length > 8) recent.shift()
        } else if (action.type === 'scroll') {
          recent.push(actionSignature(action))
          if (recent.length > 8) recent.shift()
        }

        stepIndex++
        currentStep = stepIndex
        const t0 = Date.now()
        let result: { ok: boolean; message: string; data?: string }
        if (action.type === 'switchTab') {
          // Tab switching belongs to the runner — it owns the page list.
          tabs.active = action.index
          executor.setPage(tabs.current)
          result = { ok: true, message: `switched to tab ${action.index} (${tabs.current.url()})` }
        } else {
          result = await executor.execute(action)
        }

        if (isAssertion(action) && result.ok) {
          assertionsPassed++
          let substantive = isContentAssertion(action)
          // A check on something that was already there before the test did
          // anything proves nothing, whether it is an element or a string.
          if (substantive && (action.type === 'assertText' || (action.type === 'assertVisible' && action.text))) {
            const needle = normaliseText(action.type === 'assertText' ? action.text : (action.text as string))
            const wasThereAllAlong = [...(baselineText ?? [])].some((t) => t.includes(needle))
            if (wasThereAllAlong && !(action.type === 'assertText' && action.absent)) substantive = false
          }
          if (!substantive && action.type === 'assertVisible' && action.index !== undefined) {
            const el = obs.elements.find((e) => e.index === action.index)
            substantive = Boolean(el && !baselineLabels?.has(`${el.role}|${el.label}`))
          }
          if (substantive) substantiveAssertionsPassed++
        }

        const screenshotPath = await timed(control.onTiming, 'screenshot', () => evidence.screenshot(tabs.current, stepIndex))
        const step = await saveStep(runId, {
          index: stepIndex,
          action,
          thought: b === 0 ? thought : '(same plan)',
          status: result.ok ? 'ok' : 'failed',
          validationAttempts: attempts,
          rejections: b === 0 ? rejections : [],
          error: result.ok ? null : redact(result.message, values),
          screenshotPath,
          url: tabs.current.url(),
          durationMs: Date.now() - t0,
          observation: b === 0 ? observationText : '',
          changes: b === 0 ? changes : null,
          // Verified during the action; this is what makes the run compilable.
          locator: executor.lastRef ? JSON.stringify(executor.lastRef) : null,
        })
        runEvents.publish({ type: 'run.step', runId, step })
        executed++
        results.push(`${executed}. ${redact(result.message, values)}`)
        if (result.data) results.push(result.data)

        if (action.type === 'finish') {
          outcome = finishOutcome(action, instruction, pageText, project.baseUrl)
          verdictReached = true
          break
        }
        if (isAssertion(action) && !result.ok) {
          outcome = {
            status: 'failed',
            verdict: 'fail',
            reason: `Step ${stepIndex}: ${redact(result.message, values)}`,
            failureKind: 'app',
            // The assertion quotes something the page states, or the test does.
            oracle: oracleForAssertion(action, instruction, pageText, b === 0 ? thought : ''),
            failingStep: stepIndex,
          }
          verdictReached = true
          break
        }

        failStreak = result.ok ? 0 : failStreak + 1
        if (!result.ok) {
          const remaining = batch.length - (b + 1)
          if (remaining > 0) stopNote = `the remaining ${remaining} action(s) of your plan were dropped because this one failed`
          break
        }
      }

      if (executed > 1 || stopNote) log(`turn ${turn}: executed ${executed} of ${batch.length} action(s)${stopNote ? ` — ${stopNote}` : ''}`)
      gen.addResult(`RESULTS:\n${results.join('\n')}${stopNote ? `\n(${stopNote})` : ''}`)

      if (verdictReached) break
      if (failStreak >= 4) throw new RunError('action_failures', 'four consecutive actions failed to execute')
      if (stepIndex >= maxSteps) outcome = { status: 'error', reason: `step limit (${maxSteps}) reached without a verdict`, failureKind: 'tool' }
    }
  } catch (e) {
    if (control.cancelled || (e instanceof RunError && e.code === 'cancelled')) {
      outcome = { status: 'cancelled', reason: 'cancelled by user' }
    } else if (e instanceof RunError) {
      outcome = { status: 'error', reason: `${e.code}: ${e.message}`, failureKind: 'tool' }
    } else {
      outcome = { status: 'error', reason: redact((e as Error).message.split('\n')[0], values) }
    }
  } finally {
    const tracePath = await timed(control.onTiming, 'traceStop', () => stopTracing(context, evidence, outcome.status, { alwaysKeep: true }))
    // Close the context, not the browser: the browser is shared by every run.
    await timed(control.onTiming, 'contextClose', async () => {
      await context?.close().catch(() => undefined)
    })
    await inventory.persist(project.id)

    // A run becomes a deterministic script, so every later run is free, fast
    // and repeatable instead of re-asking a model to find its way again. A run
    // that FAILED an assertion compiles too, as a known failure: that is the
    // most valuable test in the suite, and it is the one that will turn green
    // the day the bug is fixed.
    const compilable = outcome.status === 'passed' || (outcome.status === 'failed' && outcome.failureKind === 'app' && outcome.failingStep !== undefined)
    if (compilable) {
      try {
        const rows = await prisma.step.findMany({ where: { runId }, orderBy: { index: 'asc' }, select: { index: true, action: true, thought: true, status: true, locator: true } })
        const script = compileScript(runId, rows, values, outcome.status === 'passed' ? {} : { allowFailingAssertion: true })
        if (script) {
          await prisma.testCase.update({
            where: { id: run.testCaseId },
            data: {
              script: JSON.stringify(script),
              scriptUpdatedAt: new Date(),
              scriptFromRunId: runId,
              scriptVerifiedAt: null,
              expectation: script.expectation ?? 'pass',
            },
          })
          log(
            script.expectation === 'known-failing'
              ? `compiled ${script.steps.length} steps as a KNOWN FAILURE — replay it after a fix and it turns green`
              : `compiled ${script.steps.length} steps into a replayable script — future runs need no AI`,
          )
        } else {
          log('could not compile a script from this run; future runs will use the AI again')
        }
      } catch (e) {
        log(`script compilation failed: ${(e as Error).message}`)
      }
    }

    // A first-party server error during an otherwise passing test is a real
    // defect the test itself was never looking for.
    const serverErrors = anomalies.filter((a) => a.kind === 'http-5xx')
    if (serverErrors.length && outcome.status === 'passed') {
      outcome = { ...outcome, reason: `${outcome.reason} The server returned HTTP ${serverErrors[0].status} during this test — see Anomalies.`, oracle: 'implicit' }
    }

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: outcome.status,
        verdict: outcome.verdict ?? null,
        reason: outcome.reason,
        finishedAt: new Date(),
        llmCalls,
        promptTokens,
        completionTokens,
        tracePath,
        failureKind: outcome.failureKind ?? null,
        oracle: outcome.oracle ?? null,
        anomalies: JSON.stringify(anomalies.slice(0, 20)),
        model: lastModel || null,
      },
    })
    runEvents.publish({ type: 'run.status', runId, status: outcome.status, reason: outcome.reason })
    runEvents.publish({ type: 'run.done', runId, status: outcome.status })
  }
  return outcome
}

async function resetTarget(resetUrl: string, log: (m: string) => void): Promise<void> {
  try {
    const res = await fetch(resetUrl, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    log(`reset hook ${resetUrl} → HTTP ${res.status}`)
  } catch (e) {
    log(`reset hook failed (continuing): ${(e as Error).message}`)
  }
}

export type StepInput = {
  index: number
  action: unknown
  thought: string
  status: 'ok' | 'failed' | 'flagged'
  validationAttempts: number
  rejections: string[]
  error: string | null
  screenshotPath: string | null
  url: string
  durationMs: number
  observation: string
  locator?: string | null
  changes?: TextChanges | null
}

const MAX_OBSERVATION_CHARS = 12_000

export async function saveStep(runId: string, s: StepInput): Promise<StepDTO> {
  const row = await prisma.step.create({
    data: {
      runId,
      index: s.index,
      action: JSON.stringify(s.action),
      thought: s.thought,
      status: s.status,
      validationAttempts: s.validationAttempts,
      rejections: JSON.stringify(s.rejections),
      error: s.error,
      screenshotPath: s.screenshotPath,
      url: s.url,
      durationMs: s.durationMs,
      observation: s.observation.slice(0, MAX_OBSERVATION_CHARS),
      locator: s.locator ?? null,
      changes: s.changes ? JSON.stringify(s.changes) : null,
    },
  })
  return toStepDTO(row)
}

export function toStepDTO(row: {
  id: string
  runId: string
  index: number
  action: string
  thought: string
  status: string
  validationAttempts: number
  rejections: string
  error: string | null
  screenshotPath: string | null
  url: string
  durationMs: number
  observation?: string | null
  locator?: string | null
  createdAt: Date
}): StepDTO {
  let action: unknown = null
  let rejections: string[] = []
  try {
    action = JSON.parse(row.action)
  } catch {
    /* keep null */
  }
  try {
    rejections = JSON.parse(row.rejections)
  } catch {
    /* keep [] */
  }
  return {
    id: row.id,
    runId: row.runId,
    index: row.index,
    action,
    thought: row.thought,
    status: row.status as StepDTO['status'],
    validationAttempts: row.validationAttempts,
    rejections,
    error: row.error,
    screenshotPath: row.screenshotPath,
    url: row.url,
    durationMs: row.durationMs,
    observation: row.observation ?? null,
    locator: row.locator ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

const normaliseText = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Which oracle backs a failed assertion?
 *
 * The question is where the EXPECTATION came from, not whether it holds — when
 * an assertion fails, the text it expected is by definition not on the page, so
 * looking for it there would classify every real find as "inferred".
 *
 *   specified    the test instruction says what to expect
 *   stated-rule  the page says it, either literally or in the rule the model
 *                quoted in its reasoning ("10% off" → a $90 total is derived
 *                from the application's own words, not invented)
 *   unstated     nobody said it; still reported, never at full severity
 */
function oracleForAssertion(action: Action, instruction: string, pageText: { text: string[] }, thought: string): RunOutcome['oracle'] {
  const expected =
    action.type === 'assertText' || (action.type === 'assertVisible' && action.text)
      ? String((action as { text?: string }).text ?? '')
      : action.type === 'assertValidation'
        ? (action.message ?? '')
        : action.type === 'assertValue'
          ? action.text
          : ''
  const tokens = significantTokens(expected)
  // A URL, count or order check carries its expectation in the test itself.
  if (tokens.length === 0) return 'specified'

  if (tokens.every((t) => normaliseText(instruction).includes(t))) return 'specified'
  const page = pageText.text.map(normaliseText).join(' \n ')
  if (tokens.every((t) => page.includes(t))) return 'stated-rule'
  // The expected value may be DERIVED from a rule rather than copied from it:
  // the page says "10% off", the test asserts the resulting total. Accept the
  // page as the authority when the model's reasoning quotes something the page
  // actually says.
  if (quotesThePage(thought, page)) return 'stated-rule'
  return 'unstated'
}

/**
 * The parts of an expectation worth matching: words and numbers, without
 * punctuation or wrapper words. "Total: $90.00" becomes ["total", "90.00"], so
 * an instruction that says "the total is $90.00" counts as having specified it.
 */
function significantTokens(text: string): string[] {
  return normaliseText(text)
    .split(/[^a-z0-9.@%-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 3)
    .slice(0, 8)
}

/** Does this reasoning contain a phrase that appears verbatim on the page? */
function quotesThePage(thought: string, pageText: string): boolean {
  const words = normaliseText(thought).split(/[^a-z0-9.@%$-]+/).filter(Boolean)
  // Longest phrases first: a six-word match is evidence, a two-word match
  // ("the page") is a coincidence, so stop before it gets that short.
  for (let size = Math.min(6, words.length); size >= 3; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const phrase = words.slice(i, i + size).join(' ')
      if (phrase.length >= 8 && pageText.includes(phrase)) return true
    }
  }
  return false
}

/** Turn a `finish` action into the run outcome, including which oracle it used. */
function finishOutcome(action: Action & { type: 'finish' }, instruction: string, pageText: { text: string[] }, baseUrl: string): RunOutcome {
  void baseUrl
  if (action.verdict === 'pass') {
    return { status: 'passed', verdict: 'pass', reason: action.reason, oracle: 'specified' }
  }
  if (action.verdict === 'blocked') {
    // "I could not run the test." That says nothing about the application, so
    // it must never reach the bug reporter.
    return { status: 'error', verdict: 'blocked', reason: `blocked: ${action.reason}`, failureKind: 'tool' }
  }
  const rule = normaliseText(action.rule ?? '')
  const oracle: RunOutcome['oracle'] =
    rule.length >= 4 && normaliseText(instruction).includes(rule)
      ? 'specified'
      : rule.length >= 4 && pageText.text.some((t) => normaliseText(t).includes(rule))
        ? 'stated-rule'
        : 'unstated'
  const detail = [action.expected ? `Expected: ${action.expected}` : '', action.actual ? `Actual: ${action.actual}` : '', action.rule ? `Rule: ${action.rule}` : '']
    .filter(Boolean)
    .join(' · ')
  return { status: 'failed', verdict: 'fail', reason: detail ? `${action.reason} — ${detail}` : action.reason, failureKind: 'app', oracle }
}

/** The page a test should open first: the one it is about, or the home page. */
export function startingUrl(targetUrl: string | null | undefined, baseUrl: string): string {
  if (!targetUrl) return baseUrl
  try {
    const target = new URL(targetUrl, baseUrl)
    const base = new URL(baseUrl)
    // Only inside the application under test; a stored target could be stale.
    if (target.origin !== base.origin) return baseUrl
    return target.href
  } catch {
    return baseUrl
  }
}
