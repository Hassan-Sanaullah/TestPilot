/**
 * Two bugs found by pointing TestPilot at a real website (saucedemo.com), both
 * of which produced confidently wrong output:
 *
 *  1. Replay tagged the resolved element with data-tp-id and then called
 *     observe(), whose first act is to strip every data-tp-id. The tag was gone
 *     before the action ran, so every replay failed on its first step.
 *  2. That tooling failure was then written up as a CRITICAL bug against the
 *     application — seven fabricated defects against a site that works.
 *
 * The second is the dangerous one: a testing tool that invents failures is
 * worse than no tool.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser } from './browserPool'
import { createShopApp } from '@testpilot/demo-shop'
import type { TestScript } from '@testpilot/shared'
import { MockProvider } from '../ai/provider'
import { LLMRouter } from '../ai/router'
import { prisma } from '../db'
import { replayRun } from './replay'

let server: Server
let projectId: string
let baseUrl: string

beforeAll(async () => {
  server = createShopApp().listen(0)
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const p = await prisma.project.create({ data: { name: 'Replay regression', baseUrl, retryOnFail: false } })
  projectId = p.id
})
afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await prisma.$disconnect()
  server.close()
})

const router = () => new LLMRouter({ mock: new MockProvider() }, 'mock', 'mock')

async function testCaseWithScript(title: string, steps: TestScript['steps']) {
  const script: TestScript = { version: 1, steps, compiledFrom: 'fixture', compiledAt: new Date().toISOString() }
  return prisma.testCase.create({ data: { projectId, title, instruction: title, script: JSON.stringify(script) } })
}

describe('replay regressions found on a real site', () => {
  it('acts on an element that was resolved by locator (the tag must survive)', async () => {
    const tc = await testCaseWithScript('type into a real field', [
      { index: 1, action: { type: 'navigate', url: `${baseUrl}/register` } },
      {
        index: 2,
        action: { type: 'type', text: 'Ada Lovelace' },
        target: { candidate: { by: 'label', value: 'Full name' }, description: 'textbox Full name' },
      },
      {
        index: 3,
        action: { type: 'assertValue', text: 'Ada Lovelace' },
        target: { candidate: { by: 'label', value: 'Full name' }, description: 'textbox Full name' },
      },
    ])

    const run = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false }, router())

    expect(outcome.status).toBe('passed')
    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { index: 'asc' } })
    expect(steps.every((s) => s.status === 'ok')).toBe(true)
    // The specific symptom: a selector built from an undefined index.
    expect(steps.map((s) => s.error ?? '').join(' ')).not.toMatch(/undefined/)
  })

  it('classifies a missing element as a TOOL failure, never as an application bug', async () => {
    const tc = await testCaseWithScript('element that no longer exists', [
      { index: 1, action: { type: 'navigate', url: `${baseUrl}/register` } },
      {
        index: 2,
        action: { type: 'click' },
        target: { candidate: { by: 'label', value: 'A field that was removed' }, description: 'button Gone' },
      },
    ])

    const run = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false }, router())

    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('tool')
    const saved = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    expect(saved.failureKind).toBe('tool')
  })

  it('classifies a failed assertion as an APPLICATION failure', async () => {
    const tc = await testCaseWithScript('assertion that does not hold', [
      { index: 1, action: { type: 'navigate', url: `${baseUrl}/register` } },
      { index: 2, action: { type: 'assertText', text: 'this text is certainly not on the page' } },
    ])

    const run = await prisma.run.create({ data: { testCaseId: tc.id, mode: 'replay' } })
    const outcome = await replayRun(run.id, { cancelled: false }, router())

    expect(outcome.status).toBe('failed')
    expect(outcome.failureKind).toBe('app')
    expect(outcome.reason).toMatch(/ASSERTION FAILED/)
  })
})

// The pool keeps Chromium alive between runs; vitest cannot exit until it closes.
afterAll(closeSharedBrowser)
