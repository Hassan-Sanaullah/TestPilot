/** Thin fetch wrapper + the shapes the dashboard uses. */
import type { StepDTO } from '@testpilot/shared'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText)
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}

export interface Project {
  id: string
  name: string
  baseUrl: string
  description: string
  resetUrl: string | null
  testUser: string | null
  hasPassword: boolean
  hasSavedLogin: boolean
  storageState: string | null
  llmCallBudget: number
  retryOnFail: boolean
  allowedDomains: string[]
  viewportWidth: number
  viewportHeight: number
  maxSteps: number
  dialogAction: 'accept' | 'dismiss'
  /** run this project's tests at the same time; off when tests share data */
  parallel?: boolean
  /** project fixtures a test may use as {{data.<key>}} */
  testData?: Record<string, string>
  /** a session captured automatically while exploring */
  hasAutoSession?: boolean
  autoSessionAt?: string | null
  createdAt: string
  _count?: { testCases: number; requirements: number; bugReports: number; gapScenarios?: number }
  requirements?: Requirement[]
  testCases?: TestCase[]
}

export interface Requirement {
  id: string
  key: string
  text: string
  source: string
  /** where the rule was found, when it came from the app map */
  pageUrl?: string | null
  /** the stated rule this requirement was derived from, quoted */
  ruleText?: string | null
}

export interface Run {
  id: string
  testCaseId: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled'
  attempt: number
  retryOfId: string | null
  flaky: boolean
  /** ai = the model drove the browser; replay = the compiled script ran */
  mode?: 'ai' | 'replay'
  healedSteps?: number
  startedAt: string | null
  finishedAt: string | null
  verdict: string | null
  reason: string | null
  llmCalls: number
  promptTokens: number
  completionTokens: number
  tracePath: string | null
  /**
   * app = the application misbehaved and this is worth a bug report;
   * tool = TestPilot could not drive the browser, which says nothing about the
   * application and must never be presented as a defect.
   */
  failureKind?: 'app' | 'tool' | null
  /** which oracle decided the verdict */
  oracle?: 'specified' | 'stated-rule' | 'implicit' | 'unstated' | null
  /** normal | verify — a verify run is the check that follows compilation */
  kind?: string
  /** 'parallel' when the solo retry passed, so the tests interfere */
  flakyCause?: string | null
  /** findings from the implicit oracles: server errors, script exceptions */
  anomalies?: { kind: 'http-5xx' | 'js-error'; step: number; url?: string; status?: number; message?: string }[]
  suiteRunId?: string | null
  model?: string | null
  createdAt: string
  testCase?: { id: string; title: string; instruction?: string; quarantined?: boolean; expectation?: string; oracleText?: string | null; project?: Project }
  steps?: StepDTO[]
  bugReports?: { id: string; title: string; severity?: string; expected?: string; actual?: string; occurrences?: number; passingSince?: string | null }[]
  _count?: { steps: number; bugReports: number }
}

export interface TestCase {
  id: string
  title: string
  instruction: string
  origin: string
  createdAt: string
  /** true = compiled; runs replay deterministically with no AI */
  hasScript?: boolean
  scriptSteps?: number
  scriptUpdatedAt?: string | null
  /** set once a replay has proven the script reproduces */
  scriptVerifiedAt?: string | null
  kind?: 'happy-path' | 'negative' | 'edge' | 'flow'
  technique?: string | null
  area?: string | null
  targetUrl?: string | null
  targetForm?: string | null
  targetField?: string | null
  designKey?: string | null
  oracle?: string | null
  /** the rule this test checks, quoted from the page or the instruction */
  oracleText?: string | null
  auth?: 'auto' | 'anonymous' | 'signed-in'
  priority?: number
  /** known-failing = it reproduces an open bug on purpose */
  expectation?: 'pass' | 'known-failing'
  quarantined?: boolean
  requirements?: { key: string; text: string; confirmed: boolean; source: string }[]
  runs?: Run[]
  _count?: { runs: number }
}

export interface ScriptStepView {
  index: number
  action: Record<string, unknown>
  target?: { candidate: Record<string, unknown>; nth?: number; description: string }
  note?: string
}

export interface TestScriptView {
  version: number
  steps: ScriptStepView[]
  compiledFrom: string
  compiledAt: string
  expectation?: 'pass' | 'known-failing'
  failingStep?: number
}

/** Coverage computed from the stored links — no model involved. */
export interface ComputedCoverage {
  requirements: {
    rows: {
      requirementId: string
      key: string
      text: string
      status: 'violated' | 'covered' | 'partial' | 'uncovered'
      rationale: string
      tests: { id: string; title: string; status: string; quarantined: boolean; confirmed: boolean }[]
      evidence: string[]
    }[]
    summary: { violated: number; covered: number; partial: number; uncovered: number }
    total: number
  }
  structural: {
    pages: Measure
    forms: Measure
    fields: Measure
    rules: Measure
    overall: number
  }
  interference: { count: number; suggest: boolean }
}

export interface Measure {
  covered: number
  total: number
  missing: string[]
}

export interface SuiteRun {
  id: string
  projectId: string
  status: 'running' | 'passed' | 'failed' | 'cancelled'
  total: number
  passed: number
  failed: number
  errored: number
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  runs?: Run[]
}

export interface CoverageProfile {
  id: string
  createdAt: string
  runIds: string[]
  summary: { covered: number; partial: number; uncovered: number; total: number }
  items: { id: string; status: 'covered' | 'partial' | 'uncovered'; rationale: string; evidence: string[]; requirement: Requirement }[]
}

export interface GapScenario {
  id: string
  title: string
  instruction: string
  status: 'suggested' | 'accepted' | 'rejected' | 'converted'
  rationale: string
  feasibility: 'feasible' | 'infeasible' | 'unknown'
  neededUi: string[]
  duplicateOf: string | null
  requirement: Requirement | null
  createdAt: string
}

export interface BugReport {
  id: string
  runId: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  stepsToReproduce: string[]
  expected: string
  actual: string
  notes: string
  screenshotPath: string | null
  status: 'open' | 'closed'
  createdAt: string
  /** how many times this same defect has been seen */
  occurrences?: number
  lastSeenAt?: string
  lastRunId?: string | null
  /** set when the test that filed this starts passing again */
  passingSince?: string | null
  testCaseId?: string | null
  /** which oracle decided it, and the rule quoted */
  oracle?: string | null
  oracleText?: string | null
  markdown?: string
  run?: { id: string; attempt: number; testCase?: { title: string; instruction?: string; project?: Project } }
}

export interface ProjectStats {
  counts: {
    requirements: number
    testCases: number
    compiled: number
    verified: number
    quarantined: number
    knownFailing: number
    runs: number
    bugsOpen: number
    bugsTotal: number
    gapsSuggested: number
  }
  runs: { passed: number; failed: number; error: number; cancelled: number; flaky: number }
  passRate: number | null
  coverage: { violated?: number; covered: number; partial: number; uncovered: number; total: number } | null
  trend: { date: string; passed: number; failed: number }[]
  timing: { replayMedianMs: number | null; aiMedianMs: number | null }
  cost: {
    llmCalls: number
    promptTokens: number
    completionTokens: number
    aiCalls: number
    replayCalls: number
    estimatedUsd: number | null
    free: boolean
  }
  areas: { name: string; tests: number; failing: number; coveredPct: number | null }[]
  lastRunAt: string | null
  lastSuiteRun: { id: string; status: string; passed: number; failed: number; errored: number; total: number; finishedAt: string | null } | null
}

export interface LintIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  hint: string
}

export interface LintResult {
  issues: LintIssue[]
  verdict: 'good' | 'needs-work'
  problems: string[]
  improved: string | null
  alternatives: { title: string; instruction: string }[]
}

export interface DraftTest {
  title: string
  instruction: string
  kind: 'happy-path' | 'negative' | 'edge' | 'flow'
  why: string
  duplicateOf?: string
  warnings: string[]
  /** designed = computed from the app's own rules; model = written by the AI */
  source?: 'designed' | 'model'
  technique?: string
  area?: string
  targetUrl?: string
  targetForm?: string
  targetField?: string
  designKey?: string
  oracle?: string
  oracleText?: string
  auth?: string
  priority?: number
  requirementKeys?: string[]
}

export interface SuiteResult {
  drafts: DraftTest[]
  crawled: string[]
  message: string
  /** what the designer could not do, and why */
  notes?: string[]
}

export interface AppPage {
  id: string
  url: string
  title: string
  kind: string
  forms: {
    name: string
    submitLabel: string
    fields: {
      label: string
      type: string
      required: boolean
      hint: string
      options?: string[]
      minLength?: number
      maxLength?: number
      min?: string
      max?: string
      pattern?: string
    }[]
  }[]
  actions: string[]
  rules: string[]
  headings: string[]
  /** sample item titles found on a listing, usable as real test data */
  samples?: string[]
  requiresAuth: boolean
  discoveredAt: string
}

export interface AppMap {
  pages: AppPage[]
  topics: string[]
}

export interface InventoryItem {
  id: string
  url: string
  role: string
  label: string
  href: string | null
  seenAt: string
}

export interface AuthStatus {
  active: boolean
  saved: boolean
  url?: string
  elapsedMs?: number
}

export interface LlmStatus {
  profile: string
  step: string
  reason: string
  providers: {
    name: string
    model: string
    reasonModel: string
    configured: boolean
    reachable: boolean
    models: string[]
    modelAvailable?: boolean | null
    reasonModelAvailable?: boolean | null
    error?: string
  }[]
}

export const evidenceUrl = (p: string | null | undefined) => (p ? `/evidence/${p}` : '')
