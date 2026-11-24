/**
 * Three replay behaviours that used to be broken, each the reason a real suite
 * would have reported a failure that was not the application's fault:
 *
 *   1. a test that opens a second tab could be authored but never replayed
 *   2. an element rendered a moment after load was declared missing
 *   3. a renamed test id spent a model call per step instead of using the spare
 *      locators recorded next to it
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createShopApp } from '@testpilot/demo-shop'
import type { TestScript } from '@testpilot/shared'
import { LLMRouter } from '../ai/router'
import { prisma } from '../db'
import { forbiddenProvider, ScriptedProvider } from '../test/scripted'
import { closeSharedBrowser } from './browserPool'
import { replayRun } from './replay'
import { executeRun } from './runner'

let server: Server
let projectId: string
let baseUrl: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({ data: { name: 'Replay tabs', baseUrl, testUser: 'test@example.com', testPassword: 'Password123!' } })
  projectId = p.id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await closeSharedBrowser()
  server.close()
})

const router = (mock: { name: string }) => new LLMRouter({ mock: mock as never }, 'mock', 'mock')

describe('replaying a test that uses a second tab', () => {
  let testCaseId: string

  it('authors it with the AI and compiles a script including the tab switch', async () => {
    const tc = await prisma.testCase.create({
      data: { projectId, title: 'The help centre opens in a new tab', instruction: 'Open the help centre from the footer and confirm it loads.' },
    })
    testCaseId = tc.id
    const run = await prisma.run.create({ data: { testCaseId, mode: 'ai' } })
    const mock = new ScriptedProvider().script(
      { click: 'Accept all cookies', thought: 'clear the cookie wall' },
      { click: 'Help centre', thought: 'open the help centre' },
      { action: { type: 'switchTab', index: 1 }, thought: 'the link opened a new tab' },
      { action: { type: 'assertText', text: 'Contact support' }, thought: 'the help page has loaded' },
      { action: { type: 'finish', verdict: 'pass', reason: 'the help page opened in its own tab' } },
    )
    const outcome = await executeRun(run.id, { cancelled: false, headless: true }, router(mock))
    expect(mock.misses).toEqual([])
    expect(outcome.status).toBe('passed')

    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    const script = JSON.parse(saved.script!) as TestScript
    expect(script.steps.map((s) => s.action.type)).toContain('switchTab')
  })

  it('replays the tab switch with no model call at all', async () => {
    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
    expect(outcome.status).toBe('passed')
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(row.llmCalls).toBe(0)
  })
})

describe('replaying a click on an element that arrives late', () => {
  let testCaseId: string

  it('authors a click on the button that appears after 1.5s', async () => {
    const tc = await prisma.testCase.create({
      data: { projectId, title: 'The late control can be used once it appears', instruction: 'Open the slow page, wait for the control and click it.' },
    })
    testCaseId = tc.id
    const run = await prisma.run.create({ data: { testCaseId, mode: 'ai' } })
    const mock = new ScriptedProvider().script(
      { click: 'Accept all cookies', thought: 'clear the cookie wall' },
      { action: { type: 'navigate', url: `${baseUrl}/slow` } },
      { action: { type: 'wait', forText: 'Late button' }, thought: 'the control is rendered by a script' },
      { click: 'Late button' },
      { action: { type: 'assertText', text: 'Late button was clicked' } },
      { action: { type: 'finish', verdict: 'pass', reason: 'the late control works' } },
    )
    const outcome = await executeRun(run.id, { cancelled: false, headless: true }, router(mock))
    expect(mock.misses).toEqual([])
    expect(outcome.status).toBe('passed')
    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    expect(saved.script).toBeTruthy()
  })

  it('waits for the element instead of asking a model to find a replacement', async () => {
    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
    expect(outcome.status).toBe('passed')
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(row.llmCalls).toBe(0)
    expect(row.healedSteps).toBe(0)
  })

  it('repairs a renamed test id from a recorded spare, with no model call', async () => {
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    const script = JSON.parse(tc.script!) as TestScript
    const isLateButton = (step: TestScript['steps'][number]) => step.action.type === 'click' && Boolean(step.target?.description.includes('Late button'))
    const click = script.steps.find(isLateButton)
    expect(click?.target).toBeTruthy()
    // The button carries data-testid="late-button" and the text "Late button",
    // so capture should have kept at least one more verified locator as a spare.
    expect(click!.target!.alternates?.length).toBeGreaterThan(0)

    const broken: TestScript = {
      ...script,
      // Only the late button: renaming every click would exercise two repairs.
      steps: script.steps.map((s) => (isLateButton(s) ? { ...s, target: { ...s.target!, candidate: { by: 'testId' as const, value: 'renamed-by-a-developer' } } } : s)),
    }
    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(broken) } })

    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
    expect(outcome.status).toBe('passed')
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(row.llmCalls).toBe(0)
    expect(row.healedSteps).toBe(1)

    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(script) } })
  })
})

describe('replay does not reload the page it is already on', () => {
  it('records a first navigate to the base URL as instant', async () => {
    const tc = await prisma.testCase.create({
      data: { projectId, title: 'Accepting cookies dismisses the banner', instruction: 'Open the shop, accept cookies and confirm the banner is gone.' },
    })
    const author = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'ai' } })
    // The first step navigates to the page the run already opened — that is
    // what this test is about. The assertion checks something the test caused,
    // because asserting text that was there all along verifies nothing.
    const mock = new ScriptedProvider().script(
      { action: { type: 'navigate', url: baseUrl } },
      { click: 'Accept all cookies' },
      { action: { type: 'assertText', text: 'We use cookies', absent: true } },
      { action: { type: 'finish', verdict: 'pass', reason: 'the banner is gone' } },
    )
    expect((await executeRun(author.id, { cancelled: false, headless: true }, router(mock))).status).toBe('passed')

    const run = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay' } })
    expect((await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))).status).toBe('passed')

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { index: 'asc' } })
    expect(JSON.parse(steps[0].action).type).toBe('navigate')
    expect(steps[0].durationMs).toBe(0)
    expect(steps[0].thought).toContain('already on this page')
  })
})
