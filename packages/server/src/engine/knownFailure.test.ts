/**
 * The behaviour this whole redesign hinges on: a test that FINDS a bug becomes
 * a replayable test, and it turns green the day the bug is fixed.
 *
 * Before this, only passing runs compiled. The most valuable test in a suite —
 * the one that caught something — stayed AI-driven forever: slow, costly, and
 * able to change its mind between runs. Nobody could replay "the coupon test"
 * after a fix and watch it pass.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

/** A page with one rule and a deliberate defect we can switch off. */
let discountPercent = 20 // the page says 10%, so this is wrong

function createApp() {
  const app = express()
  app.get('/', (_req, res) => {
    res.type('html').send(
      `<!doctype html><html><body>
        <h1>Coupon check</h1>
        <p>Use code SAVE10 for 10% off your order.</p>
        <p>Subtotal: $100.00</p>
        <form method="get" action="/total">
          <label for="code">Coupon code</label>
          <input id="code" name="code" required>
          <button type="submit">Apply coupon</button>
        </form>
      </body></html>`,
    )
  })
  app.get('/total', (req, res) => {
    const applied = String(req.query.code ?? '').toUpperCase() === 'SAVE10'
    const total = applied ? 100 - discountPercent : 100
    res.type('html').send(
      `<!doctype html><html><body>
        <h1>Order total</h1>
        <p>Use code SAVE10 for 10% off your order.</p>
        <div role="status">Total: $${total.toFixed(2)}</div>
        <a href="/">Start again</a>
      </body></html>`,
    )
  })
  return app
}

beforeAll(async () => {
  server = createApp().listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const p = await prisma.project.create({ data: { name: 'Coupon rule', baseUrl } })
  projectId = p.id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await closeSharedBrowser()
  server.close()
})

const router = (mock: { name: string }) => new LLMRouter({ mock: mock as never }, 'mock', 'mock')

describe('a test that finds a bug', () => {
  let testCaseId: string

  it('fails on the assertion and files that as an application failure', async () => {
    const tc = await prisma.testCase.create({
      data: { projectId, title: 'SAVE10 takes 10% off the subtotal', instruction: 'Apply the coupon SAVE10 to the $100.00 subtotal and verify the order total matches the discount the page advertises.' },
    })
    testCaseId = tc.id
    const run = await prisma.run.create({ data: { testCaseId, mode: 'ai' } })
    // The model asserts the total the page's own rule implies. The assertion
    // fails, and THAT is the bug report.
    const mock = new ScriptedProvider().script(
      { type: { into: 'Coupon code', text: 'SAVE10' } },
      { click: 'Apply coupon' },
      // The expected total is DERIVED from the page's own rule, so it appears
      // nowhere on the page and nowhere in the instruction.
      { action: { type: 'assertText', text: 'Total: $90.00' }, thought: 'the page says SAVE10 for 10% off your order, so $100.00 becomes $90.00' },
    )
    const outcome = await executeRun(run.id, { cancelled: false, headless: true }, router(mock))

    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('app')
    // The expectation was derived from the application's own advertised rule,
    // not invented by the model and not handed to it by the instruction.
    expect(outcome.oracle).toBe('stated-rule')

    const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    expect(saved.expectation).toBe('known-failing')
    const script = JSON.parse(saved.script!) as TestScript
    expect(script.expectation).toBe('known-failing')
    expect(script.failingStep).toBe(script.steps.length)
    expect(script.steps.at(-1)!.action.type).toBe('assertText')
  })

  it('replays as a known failure, with no model call, while the bug is there', async () => {
    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('app')
    expect(outcome.reason).toMatch(/Known failure, unchanged/)
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(row.llmCalls).toBe(0)
  })

  it('turns green the moment the bug is fixed, and says the test now passes', async () => {
    discountPercent = 10 // the fix
    try {
      const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
      const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
      expect(outcome.status).toBe('passed')
      expect(outcome.reason).toMatch(/no longer happens/)

      // And it becomes an ordinary regression test from now on.
      const saved = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
      expect(saved.expectation).toBe('pass')
      expect((JSON.parse(saved.script!) as TestScript).expectation).toBe('pass')
    } finally {
      discountPercent = 20
    }
  })

  it('reports a break BEFORE the recorded step as a tool failure, not a bug', async () => {
    // Make the test unable to reach its assertion at all: the field it types
    // into is gone. That says nothing about the coupon rule.
    const tc = await prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } })
    const script = JSON.parse(tc.script!) as TestScript
    const broken: TestScript = {
      ...script,
      expectation: 'known-failing',
      failingStep: script.steps.length,
      steps: script.steps.map((s) =>
        s.action.type === 'type' && s.target ? { ...s, target: { candidate: { by: 'testId' as const, value: 'no-such-field' }, description: 'a field that no longer exists' } } : s,
      ),
    }
    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(broken), expectation: 'known-failing' } })

    const run = await prisma.run.create({ data: { testCaseId, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false, headless: true }, router(forbiddenProvider()))
    expect(outcome.status).toBe('error')
    expect(outcome.failureKind).toBe('tool')
    expect(outcome.reason).toMatch(/could not reach its recorded step/)

    await prisma.testCase.update({ where: { id: testCaseId }, data: { script: JSON.stringify(script) } })
  })
})
