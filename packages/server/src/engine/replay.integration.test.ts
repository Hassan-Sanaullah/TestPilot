/**
 * The product-defining behaviour: an AI run is compiled into a script, and
 * every later run replays it deterministically with NO model in the loop.
 *
 * Research on web agents reports roughly 60–70% task success on real sites, so
 * an agent re-driving the browser each time would inject its own failure rate
 * into every result. A regression suite has to be deterministic.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser } from './browserPool'
import { createShopApp } from '@testpilot/demo-shop'
import { isReplayable, type TestScript } from '@testpilot/shared'
import { MockProvider } from '../ai/provider'
import { LLMRouter } from '../ai/router'
import { prisma } from '../db'
import { replayRun } from './replay'
import { executeRun } from './runner'
import { toPlaywrightSpec } from './script'

let server: Server
let projectId: string
let baseUrl: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({
    data: { name: 'Replay test', baseUrl, resetUrl: `${baseUrl}/__reset`, testUser: 'test@example.com', testPassword: 'Password123!' },
  })
  projectId = p.id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
  server.close()
})

const router = (mock: MockProvider) => new LLMRouter({ mock }, 'mock', 'mock')

/** Drive one AI run that dismisses the cookie wall and checks the register page. */
async function authorWithAi(testCaseId: string) {
  const run = await prisma.run.create({ data: { testCaseId, mode: 'ai' } })
  const mock = new MockProvider().enqueue(
    { thought: 'clear the cookie banner', action: { type: 'find', text: 'Accept all cookies' } },
    { thought: 'accept cookies', action: { type: 'click', index: 0 } },
    { thought: 'go to the registration page', action: { type: 'navigate', url: `${baseUrl}/register` } },
    { thought: 'check the heading', action: { type: 'assertText', text: 'Create an account' } },
    { thought: 'the rule is stated on the page', action: { type: 'assertText', text: 'At least 8 characters' } },
    { thought: 'done', action: { type: 'finish', verdict: 'pass', reason: 'registration page is correct' } },
  )
  // The cookie button index is not known ahead of time; find() reports it and
  // the next scripted action uses index 0, so point it at the real element.
  const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
  return { run, outcome, mock }
}

describe('compile then replay', () => {
  let testCaseId: string

  it('compiles a passing AI run into a script with verified locators', async () => {
    const tc = await prisma.testCase.create({
      data: { projectId, title: 'Registration page states its password rule', instruction: 'Open the registration page and verify it states the password rule.' },
    })
    testCaseId = tc.id

    const run = await prisma.run.create({ data: { testCaseId, mode: 'ai' } })
    const mock = new MockProvider().enqueue(
      { action: { type: 'navigate', url: `${baseUrl}/register` } },
      { action: { type: 'assertText', text: 'Create an account' } },
      { action: { type: 'assertText', text: 'At least 8 characters' } },
      { action: { type: 'finish', verdict: 'pass', reason: 'verified' } },
    )
    const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
    expect(outcome.status).toBe('passed')

    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    expect(saved.script).toBeTruthy()
    const script = JSON.parse(saved.script!) as TestScript
    expect(isReplayable(script)).toBe(true)
    expect(script.compiledFrom).toBe(run.id)
    expect(script.steps.map((s) => s.action.type)).toEqual(['navigate', 'assertText', 'assertText'])
  })

  it('replays without calling the model at all', async () => {
    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    // A provider that throws if touched: any LLM use fails the test outright.
    const forbidden = new MockProvider()
    forbidden.complete = async () => {
      throw new Error('the model must not be called during a replay')
    }

    const t0 = Date.now()
    const outcome = await replayRun(run.id, { cancelled: false }, router(forbidden))
    const seconds = (Date.now() - t0) / 1000

    expect(outcome.status).toBe('passed')
    const saved = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(saved.mode).toBe('replay')
    expect(saved.llmCalls).toBe(0)
    expect(saved.healedSteps).toBe(0)
    expect(seconds).toBeLessThan(30)
  })

  it('reports a real failure when the application changes, rather than healing it away', async () => {
    // Point an assertion at text the page does not contain: the test must fail.
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    const script = JSON.parse(tc.script!) as TestScript
    const broken: TestScript = {
      ...script,
      steps: script.steps.map((s) => (s.action.type === 'assertText' && s.action.text === 'At least 8 characters' ? { ...s, action: { ...s.action, text: 'At least 99 characters' } } : s)),
    }
    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(broken) } })

    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false }, router(new MockProvider()))
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toMatch(/ASSERTION FAILED/)

    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(script) } })
  })

  it('exports the script as a runnable Playwright spec', async () => {
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    const spec = toPlaywrightSpec(tc.title, baseUrl, JSON.parse(tc.script!))
    expect(spec).toContain(`import { expect, test } from '@playwright/test'`)
    expect(spec).toContain('toContainText("At least 8 characters")')
  })
})

void authorWithAi

// The pool keeps Chromium alive between runs; vitest cannot exit until it closes.
afterAll(closeSharedBrowser)
