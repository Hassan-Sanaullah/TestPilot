/**
 * Reports a build system and a human can both read.
 *
 * JUnit XML because every CI system on earth understands it, and one
 * self-contained HTML file because a person needs to be able to open the
 * result, see the failing step and its screenshot, and print it.
 *
 * One distinction runs through both: a FAILURE is the application misbehaving;
 * an ERROR is TestPilot failing to drive the browser. Collapsing them is how a
 * build ends up red for reasons that say nothing about the code that was
 * pushed.
 */
import { json, prisma } from '../db'
import { type Action, describeAction, isSupportedAction } from '@testpilot/shared'

const xmlEscape = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not legal in XML at all and some parsers reject
    // the whole document over one of them.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

const htmlEscape = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

interface SuiteDetail {
  id: string
  status: string
  total: number
  passed: number
  failed: number
  errored: number
  startedAt: Date
  finishedAt: Date | null
  project: { name: string; baseUrl: string }
  runs: {
    id: string
    status: string
    reason: string | null
    failureKind: string | null
    oracle: string | null
    attempt: number
    flaky: boolean
    startedAt: Date | null
    finishedAt: Date | null
    anomalies: string
    testCase: { id: string; title: string; instruction: string; quarantined: boolean; expectation: string; oracleText: string | null }
    steps: { index: number; action: string; status: string; error: string | null; screenshotPath: string | null; url: string }[]
    bugReports: { id: string; title: string; severity: string }[]
  }[]
}

async function loadSuite(suiteRunId: string): Promise<SuiteDetail | null> {
  const suite = await prisma.suiteRun.findUnique({
    where: { id: suiteRunId },
    include: {
      project: { select: { name: true, baseUrl: true } },
      runs: {
        where: { kind: 'normal' },
        orderBy: [{ createdAt: 'asc' }],
        include: {
          testCase: { select: { id: true, title: true, instruction: true, quarantined: true, expectation: true, oracleText: true } },
          steps: { orderBy: { index: 'asc' }, select: { index: true, action: true, status: true, error: true, screenshotPath: true, url: true } },
          bugReports: { select: { id: true, title: true, severity: true } },
        },
      },
    },
  })
  return suite as SuiteDetail | null
}

/** Only the last attempt of each test is the result. */
function latestPerTest<T extends { testCase: { id: string }; attempt: number }>(runs: T[]): T[] {
  const byTest = new Map<string, T>()
  for (const r of runs) {
    const prev = byTest.get(r.testCase.id)
    if (!prev || r.attempt >= prev.attempt) byTest.set(r.testCase.id, r)
  }
  return [...byTest.values()]
}

const seconds = (from: Date | null, to: Date | null): string => (from && to ? ((to.getTime() - from.getTime()) / 1000).toFixed(3) : '0')

const failingStep = (run: SuiteDetail['runs'][number]) => run.steps.find((s) => s.status !== 'ok')

function describeStep(step: { action: string; index: number }): string {
  const a = json<Action | { type: string }>(step.action, { type: 'unknown' })
  return isSupportedAction(a) ? describeAction(a) : a.type
}

export async function junitXml(suiteRunId: string): Promise<string> {
  const suite = await loadSuite(suiteRunId)
  if (!suite) throw new Error('suite run not found')
  const runs = latestPerTest(suite.runs)

  const cases = runs.map((run) => {
    const name = xmlEscape(run.testCase.title)
    const time = seconds(run.startedAt, run.finishedAt)
    const head = `    <testcase classname="${xmlEscape(suite.project.name)}" name="${name}" time="${time}"`

    if (run.testCase.quarantined) {
      return `${head}>\n      <skipped message="quarantined: this test has proven unreliable and does not decide the build"/>\n    </testcase>`
    }
    if (run.status === 'passed') return `${head}/>`

    const step = failingStep(run)
    const detail = [
      run.reason ?? '',
      step ? `Failing step ${step.index}: ${describeStep(step)}` : '',
      step?.url ? `On page: ${step.url}` : '',
      step?.error ? `Error: ${step.error}` : '',
      run.oracle ? `Oracle: ${run.oracle}${run.testCase.oracleText ? ` — ${run.testCase.oracleText}` : ''}` : '',
      run.bugReports.length ? `Bug report: ${run.bugReports.map((b) => `${b.title} (${b.severity})`).join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    // A tool failure is an error, not a failure: it says nothing about the
    // application, and a build should not read it as a regression.
    const tag = run.status === 'failed' && run.failureKind !== 'tool' ? 'failure' : 'error'
    const message = xmlEscape((run.reason ?? 'the run did not complete').slice(0, 300))
    return `${head}>\n      <${tag} message="${message}" type="${tag === 'failure' ? 'AssertionFailure' : 'ToolFailure'}">${xmlEscape(detail)}</${tag}>\n    </testcase>`
  })

  const skipped = runs.filter((r) => r.testCase.quarantined).length
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="TestPilot" tests="${runs.length}" failures="${suite.failed}" errors="${suite.errored}" skipped="${skipped}" time="${seconds(suite.startedAt, suite.finishedAt)}">`,
    `  <testsuite name="${xmlEscape(suite.project.name)}" tests="${runs.length}" failures="${suite.failed}" errors="${suite.errored}" skipped="${skipped}" timestamp="${suite.startedAt.toISOString()}" time="${seconds(suite.startedAt, suite.finishedAt)}">`,
    `    <properties>`,
    `      <property name="application" value="${xmlEscape(suite.project.baseUrl)}"/>`,
    `      <property name="suiteRun" value="${suite.id}"/>`,
    `    </properties>`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join('\n')
}

const STYLE = `
:root { color-scheme: light dark; --page:#f5f6fa; --card:#fff; --ink:#171a21; --ink2:#5b6377; --line:#e2e6ef;
  --pass:#0e9c63; --fail:#d1476a; --warn:#d97706; --accent:#5c5fc8; }
@media (prefers-color-scheme: dark) { :root { --page:#222633; --card:#2a2f3e; --ink:#f2f4f8; --ink2:#a7aec0; --line:#3a4156; } }
* { box-sizing: border-box; }
body { margin:0; padding:32px 20px; background:var(--page); color:var(--ink);
  font:15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; }
h1 { font-size:26px; margin:0 0 4px; }
h2 { font-size:18px; margin:32px 0 12px; }
.sub { color:var(--ink2); margin:0 0 24px; }
.cards { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:8px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 18px; min-width:120px; }
.card .n { font-size:26px; font-weight:650; }
.card .l { color:var(--ink2); font-size:13px; }
.test { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:12px; padding:14px 18px; margin-bottom:10px; }
.test.passed { border-left-color:var(--pass); }
.test.failed { border-left-color:var(--fail); }
.test.error { border-left-color:var(--warn); }
.test.skipped { border-left-color:var(--ink2); }
.title { font-weight:600; }
.meta { color:var(--ink2); font-size:13px; margin-top:2px; }
.tag { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); margin-left:6px; }
details { margin-top:10px; }
summary { cursor:pointer; color:var(--accent); font-size:14px; }
table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--ink2); font-weight:600; }
tr.bad td { color:var(--fail); }
img.shot { max-width:100%; border:1px solid var(--line); border-radius:8px; margin-top:8px; }
.bar { height:8px; background:var(--line); border-radius:99px; overflow:hidden; margin:6px 0 2px; }
.bar > i { display:block; height:100%; background:var(--accent); }
code { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size:12.5px; }
@media print { body { background:#fff; padding:0; } .test, .card { break-inside: avoid; } summary { display:none; } details { open: true; } }
`

export interface ReportOptions {
  /** prefix for screenshot links, e.g. "/evidence/" */
  evidenceBase?: string
}

export async function htmlReport(suiteRunId: string, opts: ReportOptions = {}): Promise<string> {
  const suite = await loadSuite(suiteRunId)
  if (!suite) throw new Error('suite run not found')
  const runs = latestPerTest(suite.runs)
  const base = opts.evidenceBase ?? '/evidence/'

  const { computeCoverage } = await import('../ai/traceability')
  const { computeStructuralCoverage } = await import('../ai/structural')
  const projectId = (await prisma.suiteRun.findUniqueOrThrow({ where: { id: suiteRunId }, select: { projectId: true } })).projectId
  const [coverage, structural] = await Promise.all([computeCoverage(projectId), computeStructuralCoverage(projectId)])

  const classOf = (run: SuiteDetail['runs'][number]): string =>
    run.testCase.quarantined ? 'skipped' : run.status === 'passed' ? 'passed' : run.status === 'failed' && run.failureKind !== 'tool' ? 'failed' : 'error'

  const verdict = (run: SuiteDetail['runs'][number]): string => {
    if (run.testCase.quarantined) return 'Quarantined'
    if (run.status === 'passed') return run.testCase.expectation === 'known-failing' ? 'Fixed' : 'Passed'
    if (run.status === 'failed' && run.failureKind !== 'tool') return run.testCase.expectation === 'known-failing' ? 'Known failure' : 'Failed'
    return 'Could not run'
  }

  const testBlocks = runs.map((run) => {
    const step = failingStep(run)
    const anomalies = json<{ kind: string; url?: string; status?: number; message?: string }[]>(run.anomalies, [])
    const stepRows = run.steps
      .map(
        (s) =>
          `<tr class="${s.status === 'ok' ? '' : 'bad'}"><td>${s.index}</td><td><code>${htmlEscape(describeStep(s))}</code></td><td>${s.status}</td><td>${htmlEscape(s.error ?? '')}</td></tr>`,
      )
      .join('')

    return `
      <div class="test ${classOf(run)}">
        <div class="title">${htmlEscape(run.testCase.title)}
          <span class="tag">${verdict(run)}</span>
          ${run.flaky ? '<span class="tag">flaky</span>' : ''}
          ${run.oracle ? `<span class="tag">${run.oracle}</span>` : ''}
        </div>
        <div class="meta">${htmlEscape(run.reason ?? '')}</div>
        ${run.testCase.oracleText ? `<div class="meta">Rule relied on: ${htmlEscape(run.testCase.oracleText)}</div>` : ''}
        ${run.bugReports.length ? `<div class="meta">Bug: ${run.bugReports.map((b) => `${htmlEscape(b.title)} (${b.severity})`).join(', ')}</div>` : ''}
        ${anomalies.length ? `<div class="meta">Anomalies: ${anomalies.map((a) => htmlEscape(a.kind === 'http-5xx' ? `HTTP ${a.status} on ${a.url}` : (a.message ?? 'script error'))).join(' · ')}</div>` : ''}
        ${step?.screenshotPath ? `<img class="shot" src="${base}${step.screenshotPath}" alt="the page at the failing step">` : ''}
        <details><summary>${run.steps.length} step${run.steps.length === 1 ? '' : 's'}</summary>
          <table><tr><th>#</th><th>Action</th><th>Result</th><th>Detail</th></tr>${stepRows}</table>
        </details>
      </div>`
  })

  const bar = (label: string, m: { covered: number; total: number }) =>
    `<tr><th>${label}</th><td>${m.covered} of ${m.total}</td><td style="width:50%"><div class="bar"><i style="width:${m.total ? Math.round((100 * m.covered) / m.total) : 0}%"></i></div></td></tr>`

  const coverageBlock =
    coverage.total > 0
      ? `<table><tr><th>Status</th><th>Requirements</th></tr>
          <tr><td>Violated — a test for it is failing</td><td>${coverage.summary.violated}</td></tr>
          <tr><td>Covered</td><td>${coverage.summary.covered}</td></tr>
          <tr><td>Partly tested</td><td>${coverage.summary.partial}</td></tr>
          <tr><td>Not tested</td><td>${coverage.summary.uncovered}</td></tr></table>`
      : `<p class="sub">No requirements list for this project, so only the structural figures below apply.</p>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(suite.project.name)} — test report</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
  <h1>${htmlEscape(suite.project.name)}</h1>
  <p class="sub">${htmlEscape(suite.project.baseUrl)} · ${suite.startedAt.toISOString().replace('T', ' ').slice(0, 19)} · ${seconds(suite.startedAt, suite.finishedAt)}s</p>

  <div class="cards">
    <div class="card"><div class="n">${suite.total}</div><div class="l">tests</div></div>
    <div class="card"><div class="n" style="color:var(--pass)">${suite.passed}</div><div class="l">passed</div></div>
    <div class="card"><div class="n" style="color:var(--fail)">${suite.failed}</div><div class="l">failed</div></div>
    <div class="card"><div class="n" style="color:var(--warn)">${suite.errored}</div><div class="l">could not run</div></div>
  </div>

  <h2>Tests</h2>
  ${testBlocks.join('')}

  <h2>Requirement coverage</h2>
  ${coverageBlock}

  <h2>What the suite touches</h2>
  <table>
    ${bar('Pages', structural.pages)}
    ${bar('Forms submitted', structural.forms)}
    ${bar('Fields used', structural.fields)}
    ${bar('Stated rules checked', structural.rules)}
  </table>
  <p class="sub">A form counts only when a test entered something and submitted it. Anything that could not be matched to a field counts for nothing, so these figures understate rather than flatter.</p>

  <p class="sub">Generated by TestPilot. A failure means the application misbehaved; "could not run" means TestPilot could not drive the browser and says nothing about the application.</p>
</div></body></html>
`
}
