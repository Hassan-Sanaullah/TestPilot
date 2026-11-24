import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ComputedCoverage, type Project } from '../../api'
import { Donut, MeasureRow } from '../../components/charts'
import { IconAlert, IconCheck, IconCross, IconSparkle } from '../../components/icons'
import { Badge, Card, Empty, ErrorBox, Section, Skeleton, Spinner, Tabs, useAsync, useToast } from '../../components/ui'

const STATUS_WORDS: Record<string, string> = {
  violated: 'Violated',
  covered: 'Covered',
  partial: 'Partly tested',
  uncovered: 'Not tested',
}

const STATUS_HINT: Record<string, string> = {
  violated: 'A test for this requirement is failing, so the application does not satisfy it. This is the most important row on the page.',
  covered: 'A test for this passes and verifies its outcome.',
  partial: 'The behaviour is exercised but nothing verifies the result.',
  uncovered: 'No confirmed test is linked to this requirement.',
}

export default function CoverageTab({ project }: { project: Project }) {
  const [tick, setTick] = useState(0)
  const [view, setView] = useState<'requirements' | 'structure'>('requirements')
  const [busy, setBusy] = useState<'' | 'links'>('')
  const toast = useToast()
  const { data, error, loading, reload } = useAsync(() => api.get<ComputedCoverage>(`/api/projects/${project.id}/coverage/computed`), [project.id, tick])

  async function suggestLinks() {
    setBusy('links')
    try {
      const r = await api.post<{ suggestions: { testTitle: string; requirementKeys: string[] }[] }>(`/api/projects/${project.id}/coverage/suggest-links`)
      toast(r.suggestions.length ? `${r.suggestions.length} test(s) matched to requirements — accept the ones that are right.` : 'Nothing new to suggest.', 'ok')
      setTick((t) => t + 1)
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally {
      setBusy('')
    }
  }

  async function decide(testCaseId: string, requirementId: string, accept: boolean) {
    try {
      await api.post(`/api/testcases/${testCaseId}/requirements/${requirementId}`, { accept })
      setTick((t) => t + 1)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  if (loading && !data) return <Skeleton rows={4} />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!data) return null

  const { requirements: req, structural, interference } = data
  const hasRequirements = req.total > 0

  return (
    <div className="space-y-5">
      <Section
        title="Coverage"
        subtitle="Computed from the stored link between each test and the requirement it verifies, and from the results of those tests. No model is asked for an opinion, so the same data always gives the same answer."
        actions={
          <div className="flex items-center gap-2">
            <Tabs
              options={[
                { key: 'requirements' as const, label: 'Requirements' },
                { key: 'structure' as const, label: 'What the suite touches' },
              ]}
              value={view}
              onChange={setView}
            />
          </div>
        }
      >
        {interference.suggest && (
          <div className="flex items-start gap-3 rounded-ctl border border-data-amber/40 bg-data-amber/10 px-4 py-3 text-sm text-ink">
            <IconAlert size={16} />
            <span>
              {interference.count} failures passed when re-run on their own, which usually means this project&rsquo;s tests share data and interfere with each other. Turn off
              parallel runs in{' '}
              <Link className="link" to={`/projects/${project.id}?tab=settings`}>
                Settings
              </Link>
              .
            </span>
          </div>
        )}
      </Section>

      {view === 'requirements' ? (
        !hasRequirements ? (
          <Empty
            title="No requirements yet"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link className="btn-primary" to={`/projects/${project.id}?tab=requirements`}>
                  Draft a requirements list
                </Link>
                <button className="btn-secondary" onClick={() => setView('structure')}>
                  See what the suite touches instead
                </button>
              </div>
            }
          >
            Requirement coverage needs a list of requirements. TestPilot can draft one from the rules the application states about itself — or use the structural figures, which
            need no list at all.
          </Empty>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
              <Card>
                <Donut
                  segments={[
                    ...(req.summary.violated ? [{ label: 'violated', value: req.summary.violated, color: '#D1476A' }] : []),
                    { label: 'covered', value: req.summary.covered, color: '#0E9C63' },
                    { label: 'partly tested', value: req.summary.partial, color: '#D97706' },
                    { label: 'not tested', value: req.summary.uncovered, color: '#1C9ED9' },
                  ]}
                  centre={{ value: `${Math.round((100 * req.summary.covered) / Math.max(1, req.total))}%`, label: 'covered' }}
                />
              </Card>
              <Card className="space-y-3">
                {req.summary.violated > 0 && (
                  <p className="flex items-start gap-2 text-sm text-bad">
                    <IconCross size={16} />
                    <span>
                      <strong>
                        {req.summary.violated} requirement{req.summary.violated === 1 ? '' : 's'} {req.summary.violated === 1 ? 'is' : 'are'} violated.
                      </strong>{' '}
                      A test for each is failing because the application does not do what the requirement says.
                    </span>
                  </p>
                )}
                {req.summary.uncovered > 0 && (
                  <p className="text-sm text-ink2">
                    {req.summary.uncovered} requirement{req.summary.uncovered === 1 ? ' has' : 's have'} no confirmed test.{' '}
                    <Link className="link" to={`/projects/${project.id}?tab=gaps`}>
                      Find the missing tests →
                    </Link>
                  </p>
                )}
                <div className="hr-soft" />
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn-secondary btn-sm" disabled={busy === 'links'} onClick={suggestLinks}>
                    {busy === 'links' ? <Spinner label="Matching…" /> : <IconSparkle size={15} />}
                    Match tests to requirements
                  </button>
                  <span className="text-[12px] text-ink2">Suggestions only — you accept or reject each one, and nothing changes the figures until you do.</span>
                </div>
              </Card>
            </div>

            <Card className="!p-2">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-14">Req</th>
                    <th>What it says</th>
                    <th className="w-36">Status</th>
                    <th>Tests</th>
                  </tr>
                </thead>
                <tbody>
                  {req.rows.map((r) => (
                    <tr key={r.requirementId}>
                      <td className="font-mono text-xs font-bold text-ink2">{r.key}</td>
                      <td>
                        <p className="text-ink">{r.text}</p>
                        <p className="mt-0.5 text-[12px] text-ink2">{r.rationale}</p>
                      </td>
                      <td>
                        <span className={`badge ${r.status === 'violated' ? 'bg-bad/15 text-bad' : r.status === 'covered' ? 'bg-data-green/15 text-data-green' : r.status === 'partial' ? 'bg-data-amber/15 text-data-amber' : 'bg-data-blue/15 text-data-blue'}`} title={STATUS_HINT[r.status]}>
                          {r.status === 'violated' ? <IconCross size={13} /> : r.status === 'covered' ? <IconCheck size={13} /> : <IconAlert size={13} />}
                          {STATUS_WORDS[r.status]}
                        </span>
                      </td>
                      <td>
                        {r.tests.length === 0 ? (
                          <span className="text-[12px] text-ink2">none</span>
                        ) : (
                          <ul className="space-y-1">
                            {r.tests.map((t) => (
                              <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-[13px]">
                                <span className="text-ink">{t.title}</span>
                                <Badge status={t.status === 'never run' ? 'queued' : t.status}>{t.status}</Badge>
                                {t.quarantined && <Badge status="quarantined">quarantined</Badge>}
                                {!t.confirmed && (
                                  <>
                                    <Badge status="suggested">suggested</Badge>
                                    <button className="btn-xs btn-secondary" onClick={() => decide(t.id, r.requirementId, true)}>
                                      Accept
                                    </button>
                                    <button className="btn-xs btn-ghost" onClick={() => decide(t.id, r.requirementId, false)}>
                                      Reject
                                    </button>
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[26px] font-bold leading-none text-ink">{structural.overall}%</p>
                <p className="mt-1 text-sm text-ink2">of what TestPilot can see in this application is touched by a test</p>
              </div>
              <p className="max-w-sm text-[12px] text-ink2">
                This needs no requirements list. A form counts only when a test entered something <em>and</em> submitted it, and anything that could not be matched to a field
                counts for nothing — so these figures understate rather than flatter.
              </p>
            </div>
            <div className="hr-soft" />
            <div className="grid gap-4 sm:grid-cols-2">
              <MeasureRow label="Pages opened" covered={structural.pages.covered} total={structural.pages.total} color="#1C9ED9" />
              <MeasureRow label="Forms submitted" covered={structural.forms.covered} total={structural.forms.total} color="#5C5FC8" />
              <MeasureRow label="Fields used" covered={structural.fields.covered} total={structural.fields.total} color="#E35C9A" />
              <MeasureRow label="Stated rules checked" covered={structural.rules.covered} total={structural.rules.total} color="#D97706" />
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <MissingList title="Pages no test has opened" items={structural.pages.missing} />
            <MissingList title="Forms no test has submitted" items={structural.forms.missing} />
            <MissingList title="Fields no test has used" items={structural.fields.missing} />
            <MissingList title="Rules the pages state but nothing checks" items={structural.rules.missing} />
          </div>
        </>
      )}
    </div>
  )
}

function MissingList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <Card>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <ul className="mt-2 space-y-1 text-[13px] text-ink2">
        {items.map((i) => (
          <li key={i} className="truncate" title={i}>
            {i}
          </li>
        ))}
      </ul>
    </Card>
  )
}
