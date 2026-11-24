/**
 * Deterministic replay — the mode a real test suite runs in.
 *
 * No model is consulted while the test executes, so the same test does the same
 * thing every time and a failure means the application changed, not that the
 * agent had an off day. The AI is called back in exactly one situation: a
 * locator no longer resolves, i.e. the UI moved, and none of the spare locators
 * recorded alongside it resolve either. That is a repair, it is bounded, and it
 * is reported — a silently "healed" test that quietly starts asserting
 * something else is worse than one that fails honestly.
 */
import fs from 'node:fs'
import { type BrowserContext, type Page } from 'playwright'
import { type Action, type ElementRef, type RunStatus, type ScriptStep, type StepDTO, type TestScript, describeCandidate } from '@testpilot/shared'
import { config } from '../config'
import { json, prisma } from '../db'
import { runEvents } from '../events'
import { llm as defaultLlm, type LLMRouter, parseJsonObject } from '../ai/router'
import { sharedBrowser } from './browserPool'
import { EvidenceStore, stopTracing } from './evidence'
import { Executor } from './executor'
import { resolveRefWaiting } from './locator'
import { observe, renderObservation } from './perception'
import { applyPublicPlaceholders, makePlaceholderValues, redact } from './placeholders'
import type { Anomaly, RunControl, RunOutcome } from './runner'
import { saveStep, startingUrl } from './runner'
import { isFirstParty } from './urls'
import { chooseSession } from './session'
import { TabSet } from './tabs'
import { sameTarget } from './urls'
import { timed } from './timing'

const HEAL_SYSTEM = `A recorded web test can no longer find one of its elements, because the page has changed. You are given what the element was when the test was recorded, and the elements on the page now. Choose the one that plays the same role, or say there is none.
Answer with ONLY: {"index": <the [index] of the element, or null>, "reason": "<short>"}
Choose null rather than guessing: a wrong choice makes the test silently assert the wrong thing.`

export async function replayRun(runId: string, control: RunControl, llm: LLMRouter = defaultLlm): Promise<RunOutcome> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { testCase: { include: { project: true } } } })
  const project = run.testCase.project
  const script = JSON.parse(run.testCase.script ?? 'null') as TestScript | null
  if (!script) return { status: 'error', reason: 'this test has no compiled script to replay' }

  const values = makePlaceholderValues({
    baseUrl: project.baseUrl,
    testUser: project.testUser,
    testPassword: project.testPassword,
    seed: runId,
    data: json<Record<string, string>>(project.testData, {}),
  })
  const log = (m: string) => {
    const safe = redact(m, values)
    if (!process.env.VITEST) console.log(`[replay ${runId.slice(-6)}] ${safe}`)
    runEvents.publish({ type: 'run.log', runId, message: safe })
  }

  await prisma.run.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date(), mode: 'replay' } })
  runEvents.publish({ type: 'run.status', runId, status: 'running' })

  const evidence = new EvidenceStore(runId)
  await evidence.init()
  let context: BrowserContext | undefined
  let outcome: RunOutcome = { status: 'error', reason: 'replay did not complete' }
  let healed = 0
  let llmCalls = 0
  const anomalies: Anomaly[] = []
  let currentStep = 0
  const updatedScript: TestScript = { ...script, steps: script.steps.map((s) => ({ ...s })) }
  // A known-failing script records a defect on purpose. Replaying it answers
  // one question: is the defect still there?
  const knownFailing = script.expectation === 'known-failing'
  const expectedFailure = knownFailing ? (script.failingStep ?? script.steps.length) : null

  try {
    if (project.resetUrl) await fetch(project.resetUrl, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)

    const browser = await timed(control.onTiming, 'launch', () => sharedBrowser(control.headless))
    // Replay under the same session the test was authored with, or it is not
    // the same test.
    const appPages = await prisma.appPage.findMany({ where: { projectId: project.id }, select: { url: true, requiresAuth: true, kind: true } })
    const storageState = chooseSession(project, run.testCase, appPages).storageState
    context = await browser.newContext({ viewport: { width: project.viewportWidth, height: project.viewportHeight }, storageState, ignoreHTTPSErrors: true })
    control.context = context
    const tracing = await startTracing(context, run.testCase.title)

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
        if (r.status() < 500) return
        if (!isFirstParty(r.url(), project.baseUrl)) return
        if (!['document', 'xhr', 'fetch'].includes(r.request().resourceType())) return
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
      if (!isFirst) log(`a new tab opened: ${p.url()}`)
    })
    const page = await context.newPage()
    tabs.adopt(page)
    page.setDefaultTimeout(10_000)
    const startUrl = startingUrl(run.testCase.targetUrl, project.baseUrl)
    await timed(control.onTiming, 'goto', () => page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 }))

    const executor = new Executor(page, values, control.onTiming)
    let assertionsPassed = 0

    for (const [i, step] of script.steps.entries()) {
      if (control.cancelled) {
        outcome = { status: 'cancelled', reason: 'cancelled by user' }
        break
      }
      const t0 = Date.now()
      currentStep = step.index
      const action = applyToAction(step, values)

      tabs.prune()
      if (tabs.pages.length === 0) {
        outcome = { status: 'error', reason: 'every browser tab was closed', failureKind: 'tool' }
        break
      }
      const activePage = tabs.current
      executor.setPage(activePage)

      // The run opened the base URL already; a first step that navigates to the
      // same place would load it a second time for nothing.
      if (i === 0 && step.action.type === 'navigate' && typeof step.action.url === 'string' && sameTarget(activePage.url(), String(action.url), startUrl)) {
        const saved = await saveStep(runId, {
          index: step.index,
          action: step.action,
          thought: (step.note ?? '') + ' (already on this page)',
          status: 'ok',
          validationAttempts: 1,
          rejections: [],
          error: null,
          screenshotPath: null,
          url: activePage.url(),
          durationMs: 0,
          observation: '',
          locator: null,
        })
        runEvents.publish({ type: 'run.step', runId, step: saved })
        continue
      }

      // Resolve the element, repairing the locator if the page has moved on.
      let indexForAction: number | undefined
      let healNote = ''
      if (step.target) {
        const found = await timed(control.onTiming, 'resolveRef', () => resolveRefWaiting(activePage, step.target!))
        if (found.locator) {
          if (found.repairedTo) {
            // A spare locator matched: the primary has drifted, so promote the
            // one that worked and say so. This costs no model call.
            healed++
            updatedScript.steps[i] = { ...step, target: { ...step.target, candidate: found.repairedTo.candidate, nth: found.repairedTo.nth } }
            healNote = ` (locator repaired from a recorded spare: ${describeCandidate(found.repairedTo.candidate)})`
            log(`step ${step.index}: primary locator no longer matches; a recorded spare did — ${describeCandidate(found.repairedTo.candidate)}`)
          }
          // Tag last: anything that observes the page clears these attributes.
          indexForAction = await tagElement(activePage, found.locator)
        } else {
          const repaired = await heal(activePage, step, llm)
          llmCalls += repaired.calls
          if (repaired.ref && repaired.index !== undefined) {
            healed++
            updatedScript.steps[i] = { ...step, target: repaired.ref }
            indexForAction = repaired.index
            healNote = ` (locator repaired: ${describeCandidate(repaired.ref.candidate)})`
            log(`step ${step.index}: locator repaired — ${step.target.description} → ${repaired.ref.description}`)
          } else {
            const saved = await saveStep(runId, {
              index: step.index,
              action: step.action,
              thought: step.note ?? '',
              status: 'failed',
              validationAttempts: 1,
              rejections: [],
              error: `Could not find "${step.target.description}" (${describeCandidate(step.target.candidate)}). The element is gone or changed beyond recognition.`,
              screenshotPath: await evidence.screenshot(activePage, step.index),
              url: activePage.url(),
              durationMs: Date.now() - t0,
              observation: renderObservation(await observe(activePage)),
              locator: null,
            })
            runEvents.publish({ type: 'run.step', runId, step: saved })
            outcome = knownFailing
              ? {
                  // It cannot even reach the step it was recorded to check, so
                  // it no longer tests the defect. Not a bug report.
                  status: 'error',
                  reason: `This known-failure test could not reach its recorded step ${expectedFailure}: the element "${step.target.description}" no longer exists. Re-author it.`,
                  failureKind: 'tool',
                }
              : { status: 'failed', verdict: 'fail', reason: `Step ${step.index}: the element "${step.target.description}" no longer exists on the page.`, failureKind: 'tool' }
            break
          }
        }
      }

      let result: { ok: boolean; message: string; data?: string }
      if (action.type === 'switchTab') {
        // Tab switching belongs here, not in the executor: this is what owns
        // the page list.
        const wanted = Number(action.index ?? 0)
        if (!Number.isInteger(wanted) || wanted < 0 || wanted >= tabs.pages.length) {
          result = { ok: false, message: `cannot switch to tab ${wanted}: ${tabs.pages.length} tab(s) are open` }
        } else {
          tabs.active = wanted
          executor.setPage(tabs.current)
          result = { ok: true, message: `switched to tab ${wanted} (${tabs.current.url()})` }
        }
      } else {
        const toRun = (indexForAction !== undefined ? { ...action, index: indexForAction } : action) as Action
        result = await executor.execute(toRun)
      }
      if (String(action.type).startsWith('assert') && result.ok) assertionsPassed++

      if (dialogs.length) log(`the browser handled: ${dialogs.splice(0).join('; ')}`)

      const saved = await saveStep(runId, {
        index: step.index,
        action: step.action,
        thought: (step.note ?? '') + healNote,
        status: result.ok ? 'ok' : 'failed',
        validationAttempts: 1,
        rejections: [],
        error: result.ok ? null : redact(result.message, values),
        screenshotPath: await timed(control.onTiming, 'screenshot', () => evidence.screenshot(tabs.current, step.index)),
        url: tabs.current.url(),
        durationMs: Date.now() - t0,
        observation: '',
        locator: step.target ? JSON.stringify(updatedScript.steps[i].target) : null,
      })
      runEvents.publish({ type: 'run.step', runId, step: saved })

      if (!result.ok) {
        // An assertion that fails is the application misbehaving. Anything else
        // is TestPilot failing to drive the browser, which is not a bug in the
        // application under test and must never be reported as one.
        const isAssertion = String(action.type).startsWith('assert')
        if (knownFailing && isAssertion && step.index === expectedFailure) {
          // Exactly what this test is for: the recorded defect is still there.
          outcome = {
            status: 'failed',
            verdict: 'fail',
            reason: `Known failure, unchanged — step ${step.index}: ${redact(result.message, values)}`,
            failureKind: 'app',
            failingStep: step.index,
          }
        } else if (knownFailing && !isAssertion) {
          // It broke before reaching the step it was recorded to check, so it
          // no longer tests anything. That is not a bug report.
          outcome = {
            status: 'error',
            reason: `This known-failure test could not reach its recorded step ${expectedFailure}: step ${step.index} failed (${redact(result.message, values)}). Re-author it.`,
            failureKind: 'tool',
          }
        } else {
          outcome = {
            status: 'failed',
            verdict: 'fail',
            reason: `Step ${step.index}: ${redact(result.message, values)}`,
            failureKind: isAssertion ? 'app' : 'tool',
            ...(isAssertion ? { failingStep: step.index } : {}),
          }
        }
        break
      }
      if (step.index === script.steps[script.steps.length - 1].index) {
        if (knownFailing) {
          // Every step passed, including the one that used to fail: fixed.
          outcome = {
            status: 'passed',
            verdict: 'pass',
            reason: `The recorded failure at step ${expectedFailure} no longer happens — this looks fixed.`,
          }
        } else {
          outcome =
            assertionsPassed > 0
              ? { status: 'passed', verdict: 'pass', reason: `Replayed ${script.steps.length} steps; ${assertionsPassed} assertion(s) passed.` }
              : { status: 'error', reason: 'the script contains no assertion' }
        }
      }
    }
    void tracing
  } catch (e) {
    outcome = control.cancelled ? { status: 'cancelled', reason: 'cancelled by user' } : { status: 'error', reason: redact((e as Error).message.split('\n')[0], values) }
  } finally {
    const tracePath = await timed(control.onTiming, 'traceStop', () => stopTracing(context, evidence, outcome.status))
    await timed(control.onTiming, 'contextClose', async () => {
      await context?.close().catch(() => undefined)
    })

    if (healed > 0 && outcome.status === 'passed') {
      await prisma.testCase.update({ where: { id: run.testCaseId }, data: { script: JSON.stringify(updatedScript), scriptUpdatedAt: new Date() } }).catch(() => undefined)
    }
    if (knownFailing && outcome.status === 'passed') {
      // The defect is gone. The test becomes an ordinary regression test, and
      // the bug it filed is offered for closing.
      const fixed: TestScript = { ...updatedScript, expectation: 'pass', failingStep: undefined }
      await prisma.testCase
        .update({ where: { id: run.testCaseId }, data: { expectation: 'pass', script: JSON.stringify(fixed) } })
        .catch(() => undefined)
      await prisma.bugReport
        .updateMany({ where: { testCaseId: run.testCaseId, status: 'open', passingSince: null }, data: { passingSince: new Date() } })
        .catch(() => undefined)
      log('this test passed, so the bug it was recorded for appears to be fixed')
    }
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: outcome.status as RunStatus,
        verdict: outcome.verdict ?? null,
        reason: outcome.reason + (healed ? ` ${healed} locator(s) repaired — worth a look.` : ''),
        finishedAt: new Date(),
        mode: 'replay',
        healedSteps: healed,
        failureKind: outcome.failureKind ?? null,
        llmCalls,
        tracePath,
        anomalies: JSON.stringify(anomalies.slice(0, 20)),
      },
    })
    runEvents.publish({ type: 'run.status', runId, status: outcome.status, reason: outcome.reason })
    runEvents.publish({ type: 'run.done', runId, status: outcome.status })
  }
  return outcome
}

/**
 * Replays are short, so a trace is a large share of their cost. Snapshots are
 * what make a trace worth opening, screenshots are the expensive part, and the
 * step evidence already covers those.
 */
async function startTracing(context: BrowserContext, title: string): Promise<boolean> {
  if (config.traceMode === 'off') return false
  await context.tracing.start({ screenshots: false, snapshots: true, title })
  return true
}

/** Give the resolved element the attribute the executor addresses elements by. */
async function tagElement(page: Page, loc: import('playwright').Locator): Promise<number> {
  const id = 900000 + Math.floor(Math.random() * 90000)
  await loc.evaluate((el, value) => el.setAttribute('data-tp-id', String(value)), id).catch(() => undefined)
  void page
  return id
}

/** Ask the model which element now plays the role the recorded one did. */
async function heal(page: Page, step: ScriptStep, llm: LLMRouter): Promise<{ ref: ElementRef | null; index?: number; calls: number }> {
  if (!step.target) return { ref: null, calls: 0 }
  try {
    const obs = await observe(page)
    const res = await llm.reason({
      messages: [
        { role: 'system', content: HEAL_SYSTEM },
        {
          role: 'user',
          content:
            `THE STEP: ${JSON.stringify(step.action)}\n` +
            `THE ELEMENT WHEN RECORDED: ${step.target.description} — found with ${describeCandidate(step.target.candidate)}\n\n` +
            `THE PAGE NOW\n${renderObservation(obs)}`,
        },
      ],
      json: true,
      temperature: 0,
    })
    const parsed = parseJsonObject(res.content) as { index?: number | null }
    const idx = typeof parsed.index === 'number' ? parsed.index : null
    if (idx === null) return { ref: null, calls: 1 }
    const el = obs.elements.find((e) => e.index === idx)
    if (!el) return { ref: null, calls: 1 }
    const { captureRef } = await import('./locator')
    for (const frame of page.frames()) {
      const loc = frame.locator(`[data-tp-id="${idx}"]`).first()
      if ((await loc.count().catch(() => 0)) > 0) {
        const ref = await captureRef(frame, loc, idx)
        if (ref) return { ref, index: idx, calls: 1 }
      }
    }
    return { ref: null, calls: 1 }
  } catch {
    return { ref: null, calls: 1 }
  }
}

/** Resolve placeholders in a script step the same way an AI run does. */
function applyToAction(step: ScriptStep, values: ReturnType<typeof makePlaceholderValues>): Record<string, unknown> {
  const a = { ...step.action }
  for (const key of ['text', 'value', 'url', 'contains', 'forText'] as const) {
    if (typeof a[key] === 'string') a[key] = applyPublicPlaceholders(a[key] as string, values)
  }
  return a
}

export type { StepDTO }
