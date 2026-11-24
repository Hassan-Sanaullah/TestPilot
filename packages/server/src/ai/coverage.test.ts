import { describe, expect, it } from 'vitest'
import { applyCoverageGuard, buildEvidence, type EvidenceStep } from './coverage'

const runs = [
  {
    id: 'run_abcdef',
    status: 'passed',
    reason: 'verified',
    testCase: { title: 'Register valid user' },
    steps: [
      { id: 's1', status: 'ok', action: JSON.stringify({ type: 'click', index: 3 }), error: null, url: 'http://x/' },
      { id: 's2', status: 'ok', action: JSON.stringify({ type: 'type', index: 1, text: 'a@b.com' }), error: null, url: 'http://x/register' },
      { id: 's3', status: 'ok', action: JSON.stringify({ type: 'assertText', text: 'Welcome' }), error: null, url: 'http://x/' },
      { id: 's4', status: 'failed', action: JSON.stringify({ type: 'assertUrl', contains: '/orders' }), error: 'ASSERTION FAILED', url: 'http://x/' },
    ],
  },
]

describe('coverage checker (M4)', () => {
  it('labels evidence steps S1..Sn with assertion outcomes', () => {
    const { text, steps } = buildEvidence(runs)
    expect(steps.map((s) => s.label)).toEqual(['S1', 'S2', 'S3', 'S4'])
    expect(text).toContain('S3 [ok] assert page contains "Welcome" → ASSERTION PASSED')
    expect(text).toContain('S4 [failed] assert URL contains "/orders" → ASSERTION FAILED')
  })

  it('downgrades "covered" without a passed assertion, and "uncovered" when nothing is cited', () => {
    const { steps } = buildEvidence(runs)
    const byLabel = new Map<string, EvidenceStep>(steps.map((s) => [s.label, s]))
    expect(applyCoverageGuard({ status: 'covered', evidence: ['S1', 'S2'], rationale: 'flow exercised' }, byLabel).status).toBe('partial')
    expect(applyCoverageGuard({ status: 'covered', evidence: ['S2', 'S3'], rationale: 'verified' }, byLabel).status).toBe('covered')
    expect(applyCoverageGuard({ status: 'covered', evidence: ['S4'], rationale: 'assert failed' }, byLabel).status).toBe('partial')
    expect(applyCoverageGuard({ status: 'partial', evidence: [], rationale: '' }, byLabel).status).toBe('uncovered')
    const r = applyCoverageGuard({ status: 'covered', evidence: ['S3', 'S99'], rationale: 'ok' }, byLabel)
    expect(r.evidence).toEqual(['s3']) // unknown labels dropped, labels mapped to step ids
  })
})
