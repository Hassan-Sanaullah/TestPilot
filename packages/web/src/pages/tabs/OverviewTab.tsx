import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { TabKey } from '../../nav'
import { api, type Project, type ProjectStats, type Run, type SuiteRun } from '../../api'
import { Donut, LineChart, Ring } from '../../components/charts'
import { IconCheck, IconPlay, IconReplay, IconSparkle } from '../../components/icons'
import { Card, Empty, ErrorBox, Pill, Section, Skeleton, StatusBadge, duration, fmtAgo, useAsync, useToast } from '../../components/ui'

/** "3.6s", "21s", "1m 05s" — short enough to sit inside a card. */
function ms(v: number | null): string {
  if (v === null) return '—'
  if (v < 1000) return `${v}ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
  if (v < 60_000) return `${Math.round(v / 1000)}s`
  return `${Math.floor(v / 60_000)}m ${String(Math.round((v % 60_000) / 1000)).padStart(2, '0')}s`
}

export default function OverviewTab({ project, tick, onGo }: { project: Project; tick: number; onGo: (tab: TabKey) => void }) {
  const stats = useAsync(() => api.get<ProjectStats>(`/api/projects/${project.id}/stats`), [project.id, tick])
  const runs = useAsync(() => api.get<Run[]>(`/api/projects/${project.id}/runs`), [project.id, tick])
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const s = stats.data

  if (stats.loading && !s) return <Skeleton rows={4} />
  if (stats.error) return <ErrorBox error={stats.error} onRetry={stats.reload} />
  if (!s) return null

  const nothingYet = s.counts.runs === 0
  const recent = (runs.data ?? []).slice(0, 6)
  const { compiled, testCases } = s.counts

  // What a full replay should take: the compiled tests, four at a time.
  const estimateMs = s.timing.replayMedianMs && compiled ? Math.round((compiled * s.timing.replayMedianMs) / 4) : null

  async function replayAll() {
    setBusy(true)
    try {
      const r = await api.post<{ suiteRun: SuiteRun; skipped: { title: string }[] }>(`/api/projects/${project.id}/suite-runs`, { compiledOnly: true })
      toast(`Running ${r.suiteRun.total} test${r.suiteRun.total === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} not authored yet` : ''}`, 'ok')
      onGo('runs')
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {nothingYet && (
        <Empty
          title="This project has not been tested yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button className="btn-secondary" onClick={() => onGo('requirements')}>
                1 · Define requirements
              </button>
              <button className="btn-primary" onClick={() => onGo('tests')}>
                2 · Write and run a test
              </button>
            </div>
          }
        >
          Start with a requirements checklist — or let TestPilot draft one from the pages themselves — then describe a test in plain English and run it.
        </Empty>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* ---------------------------------------------------------- hero */}
        <Card orb="#5C5FC8">
          <p className="text-sm text-ink2">
            {testCases} test{testCases === 1 ? '' : 's'}
            {s.lastRunAt ? ` · last run ${fmtAgo(s.lastRunAt)}` : ' · never run'}
          </p>
          <h2 className="mt-1 text-[22px] font-bold leading-tight text-ink">Replay the whole suite</h2>
          <p className="mt-1.5 max-w-md text-sm text-ink2">
            {compiled === 0
              ? 'No test has been authored yet. Run one with the AI and TestPilot records its steps, so every run after that is deterministic and free.'
              : `${compiled} of ${testCases} tests replay with no AI in the loop${estimateMs ? ` — about ${ms(estimateMs)}` : ''}.`}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn-contrast" onClick={replayAll} disabled={busy || compiled === 0}>
              <IconPlay size={16} />
              {busy ? 'Starting…' : 'Replay the suite'}
            </button>
            <button className="btn-secondary" onClick={() => onGo('tests')}>
              <IconSparkle size={16} /> Write a test
            </button>
          </div>

          {s.lastSuiteRun && (
            <div className="hr-soft" />
          )}
          {s.lastSuiteRun && (
            <p className="text-[13px] text-ink2">
              Last suite: {s.lastSuiteRun.passed} passed · {s.lastSuiteRun.failed} failed
              {s.lastSuiteRun.errored ? ` · ${s.lastSuiteRun.errored} could not run` : ''}
              {' · '}
              <a className="link" href={`/api/suite-runs/${s.lastSuiteRun.id}/report`} target="_blank" rel="noreferrer">
                open the report
              </a>
            </p>
          )}
        </Card>

        {/* ------------------------------------------------- the two modes */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Card>
            <div className="flex items-center gap-2 text-ink2">
              <IconReplay size={16} />
              <span className="text-xs font-semibold uppercase tracking-wide">Deterministic</span>
            </div>
            <p className="mt-2 text-[26px] font-bold leading-none text-ink">{ms(s.timing.replayMedianMs)}</p>
            <p className="mt-1 text-[13px] text-ink2">
              typical replay · {compiled} test{compiled === 1 ? '' : 's'}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-data-green">
              <IconCheck size={13} /> {s.cost.replayCalls} AI calls
            </p>
            {s.counts.verified > 0 && <p className="mt-1 text-[11px] text-ink2">{s.counts.verified} checked by a replay</p>}
          </Card>

          <Card>
            <div className="flex items-center gap-2 text-ink2">
              <IconSparkle size={16} />
              <span className="text-xs font-semibold uppercase tracking-wide">AI authoring</span>
            </div>
            <p className="mt-2 text-[26px] font-bold leading-none text-ink">{ms(s.timing.aiMedianMs)}</p>
            <p className="mt-1 text-[13px] text-ink2">typical first run</p>
            <p className="mt-2 text-[12px] text-ink2">
              {s.cost.aiCalls} AI calls · {s.cost.free ? 'free tier' : s.cost.estimatedUsd === null ? 'not priced' : `≈ $${s.cost.estimatedUsd.toFixed(3)}`}
            </p>
          </Card>
        </div>
      </div>

      {/* ------------------------------------------------- coverage by area */}
      {s.areas.length > 0 && (
        <Section title="Coverage by area" subtitle="Which part of the application each test belongs to, from the map TestPilot built.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.areas.map((a) => (
              <Card key={a.name} className="!p-4">
                <div className="flex items-center gap-3">
                  <Ring pct={a.coveredPct} label={`${a.name}: ${a.coveredPct === null ? 'not measured' : `${a.coveredPct}% covered`}`} color={a.failing ? '#D1476A' : '#5C5FC8'} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{a.name}</p>
                    <p className="text-[12px] text-ink2">
                      {a.tests} test{a.tests === 1 ? '' : 's'}
                      {a.failing > 0 ? ` · ${a.failing} failing` : ''}
                    </p>
                  </div>
                </div>
                {a.coveredPct === null && <p className="mt-2 text-[11px] text-ink2">No requirement for this area yet, so there is no percentage to show.</p>}
              </Card>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Runs over the last 14 days">
          <Card>
            <LineChart
              points={s.trend.map((d) => ({
                label: new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
                value: d.passed + d.failed,
                detail: `${d.passed} passed · ${d.failed} failed`,
              }))}
            />
            {s.runs.flaky > 0 && <p className="mt-2 text-xs text-ink2">{s.runs.flaky} run(s) needed a re-run before their result could be trusted.</p>}
          </Card>
        </Section>

        <Section title="Requirement coverage">
          <Card>
            {s.coverage && s.coverage.total > 0 ? (
              <Donut
                segments={[
                  ...(s.coverage.violated ? [{ label: 'violated', value: s.coverage.violated, color: '#D1476A' }] : []),
                  { label: 'covered', value: s.coverage.covered, color: '#0E9C63' },
                  { label: 'partly tested', value: s.coverage.partial, color: '#D97706' },
                  { label: 'not tested', value: s.coverage.uncovered, color: '#1C9ED9' },
                ]}
                centre={{ value: `${Math.round((100 * s.coverage.covered) / s.coverage.total)}%`, label: 'covered' }}
              />
            ) : (
              <p className="text-sm text-ink2">
                No requirements yet.{' '}
                <button className="link" onClick={() => onGo('coverage')}>
                  Open Coverage
                </button>{' '}
                to see what the suite touches — pages, forms, fields and stated rules — which needs no requirements list at all.
              </p>
            )}
          </Card>
        </Section>
      </div>

      <Section
        title="Recent runs"
        actions={
          <button className="btn-secondary btn-sm" onClick={() => onGo('runs')}>
            View all
          </button>
        }
      >
        {recent.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <Card className="!p-2">
            <table className="table">
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="w-36">
                      <StatusBadge status={r.status} failureKind={r.failureKind} expectation={r.testCase?.expectation} quarantined={r.testCase?.quarantined} flaky={r.flaky} />
                    </td>
                    <td>
                      <Link to={`/runs/${r.id}`} className="link font-medium">
                        {r.testCase?.title}
                      </Link>
                    </td>
                    <td className="hidden max-w-sm truncate text-ink2 md:table-cell" title={r.reason ?? ''}>
                      {r.reason ?? ''}
                    </td>
                    <td className="w-20 text-right text-xs text-ink2">{duration(r.startedAt, r.finishedAt)}</td>
                    <td className="w-28 text-right text-xs text-ink2">{fmtAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {(s.counts.bugsOpen > 0 || s.counts.gapsSuggested > 0 || s.counts.knownFailing > 0 || s.counts.quarantined > 0) && (
        <div className="flex flex-wrap gap-2">
          {s.counts.bugsOpen > 0 && (
            <button onClick={() => onGo('bugs')}>
              <Pill tone="quiet">
                {s.counts.bugsOpen} open bug{s.counts.bugsOpen === 1 ? '' : 's'}
              </Pill>
            </button>
          )}
          {s.counts.gapsSuggested > 0 && (
            <button onClick={() => onGo('gaps')}>
              <Pill tone="quiet">{s.counts.gapsSuggested} missing tests suggested</Pill>
            </button>
          )}
          {s.counts.knownFailing > 0 && (
            <button onClick={() => onGo('tests')}>
              <Pill tone="quiet">
                {s.counts.knownFailing} known failure{s.counts.knownFailing === 1 ? '' : 's'} recorded
              </Pill>
            </button>
          )}
          {s.counts.quarantined > 0 && (
            <button onClick={() => onGo('tests')}>
              <Pill tone="quiet">{s.counts.quarantined} quarantined as unreliable</Pill>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
