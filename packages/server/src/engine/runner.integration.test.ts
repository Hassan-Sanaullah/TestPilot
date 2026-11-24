/**
 * End-to-end pipeline test with a scripted (mock) LLM and a real headless
 * Chromium against the demo shop: Input → Observe → Generate → Validate →
 * Execute → evidence → verdict, plus the coverage profiler and bug writer.
 * No API keys needed.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser } from './browserPool'
import { createShopApp } from '@testpilot/demo-shop'
import { fileBugReport } from '../ai/bugs'
import { profileCoverage } from '../ai/coverage'
import { MockProvider } from '../ai/provider'
import { LLMRouter } from '../ai/router'
import { config } from '../config'
import { prisma } from '../db'
import { executeRun } from './runner'

let server: Server
let baseUrl: string
let projectId: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({
    data: { name: 'Demo Shop (test)', baseUrl, resetUrl: `${baseUrl}/__reset`, testUser: 'test@example.com', testPassword: 'Password123!' },
  })
  projectId = p.id
  await prisma.requirement.createMany({
    data: [
      { projectId, key: 'R1', text: 'The registration page lets a visitor create an account' },
      { projectId, key: 'R2', text: 'Users can log in with valid credentials' },
    ],
  })
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
  server.close()
})

function router(mock: MockProvider): LLMRouter {
  return new LLMRouter({ mock }, 'mock', 'mock')
}

describe('runner (M1–M3) end to end', () => {
  it('executes a passing test: navigate → assert → finish', async () => {
    const tc = await prisma.testCase.create({ data: { projectId, title: 'Open registration', instruction: 'Open the registration page and verify the heading.' } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id } })
    const mock = new MockProvider().enqueue(
      { thought: 'go to register', action: { type: 'navigate', url: '/register' } },
      { thought: 'check heading', action: { type: 'assertText', text: 'Create an account' } },
      { thought: 'done', action: { type: 'finish', verdict: 'pass', reason: 'registration page shows "Create an account"' } },
    )
    const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
    expect(outcome.status).toBe('passed')

    const saved = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { steps: { orderBy: { index: 'asc' } } } })
    expect(saved.status).toBe('passed')
    expect(saved.llmCalls).toBe(3)
    expect(saved.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok'])
    expect(saved.steps[1].url).toContain('/register')
    expect(saved.tracePath).toBeTruthy()
    expect(fs.existsSync(`${config.evidenceDir}/${saved.tracePath}`)).toBe(true)
    expect(fs.existsSync(`${config.evidenceDir}/${saved.steps[0].screenshotPath}`)).toBe(true)
    // The observation populated the DOM inventory (feasibility knowledge for M5).
    expect(await prisma.elementInventory.count({ where: { projectId } })).toBeGreaterThan(3)
  })

  it('rejects an ungrounded action 3 times, then flags the step and fails the run', async () => {
    const tc = await prisma.testCase.create({ data: { projectId, title: 'Bad model', instruction: 'x' } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id } })
    const mock = new MockProvider().enqueue(
      { action: { type: 'click', index: 999 } }, // index not in the observation
      { action: { type: 'doubleClick', index: 1 } }, // not a supported action
      'not even json', // unparseable
    )
    const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toMatch(/^invalid_step/)
    const steps = await prisma.step.findMany({ where: { runId: run.id } })
    expect(steps).toHaveLength(1)
    expect(steps[0].status).toBe('flagged')
    expect(steps[0].validationAttempts).toBe(3)
    expect(JSON.parse(steps[0].rejections)).toHaveLength(3)
    // Each rejection was fed back to the model as a new turn.
    expect(mock.calls[2].messages.filter((m) => m.content.startsWith('VALIDATOR REJECTED'))).toHaveLength(2)
  })

  it('fails the run on a failed assertion and the bug writer files a report', async () => {
    const tc = await prisma.testCase.create({ data: { projectId, title: 'Wrong expectation', instruction: 'Open the home page and verify a message that is not there.' } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id } })
    const mock = new MockProvider().enqueue({ action: { type: 'assertText', text: 'This text does not exist anywhere' } })
    const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toMatch(/ASSERTION FAILED/)

    const bugMock = new MockProvider().enqueue({ title: 'Home page lacks expected message', severity: 'low', expected: 'message shown', actual: 'not shown', notes: '' })
    const bug = await fileBugReport(run.id, router(bugMock))
    expect(bug.title).toBe('Home page lacks expected message')
    expect(JSON.parse(bug.stepsToReproduce)[1]).toMatch(/← FAILS/)
    expect(bug.screenshotPath).toBeTruthy()
  })

  it('respects the per-run LLM call budget', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { llmCallBudget: 5 } })
    const tc = await prisma.testCase.create({ data: { projectId, title: 'Budget', instruction: 'x' } })
    const run = await prisma.run.create({ data: { testCaseId: tc.id } })
    const mock = new MockProvider()
    for (let i = 0; i < 10; i++) mock.enqueue({ action: { type: 'navigate', url: i % 2 ? '/register' : '/login' } })
    const outcome = await executeRun(run.id, { cancelled: false }, router(mock))
    expect(outcome.status).toBe('error')
    expect(outcome.reason).toMatch(/budget_exceeded/)
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).llmCalls).toBe(5)
    await prisma.project.update({ where: { id: projectId }, data: { llmCallBudget: 40 } })
  })
})

describe('coverage profiler (M4) on real evidence', () => {
  it('maps requirements to evidence and enforces the passed-assertion rule', async () => {
    const mock = new MockProvider().enqueue({
      items: [
        { key: 'R1', status: 'covered', evidence: ['S2', 'S3'], rationale: 'registration page verified' },
        { key: 'R2', status: 'covered', evidence: ['S1'], rationale: 'claimed without assertion' },
      ],
    })
    const profile = await profileCoverage(projectId, router(mock))
    const byKey = Object.fromEntries(profile.items.map((i) => [i.requirement.key, i]))
    expect(byKey.R1.status).toBe('covered')
    expect(byKey.R2.status).toBe('partial') // downgraded by the guard
    expect(JSON.parse(profile.summary)).toMatchObject({ total: 2 })
  })
})

// The pool keeps Chromium alive between runs; vitest cannot exit until it closes.
afterAll(closeSharedBrowser)
