import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type BugReport, type Project } from '../../api'
import { IconCheck } from '../../components/icons'
import { Badge, Card, Empty, ErrorBox, FilterChips, Pill, SearchInput, Section, Skeleton, fmtAgo, useAsync, useDebounced, useToast } from '../../components/ui'

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

export default function BugsTab({ project, tick }: { project: Project; tick: number }) {
  const { data, error, loading, reload } = useAsync(() => api.get<BugReport[]>(`/api/projects/${project.id}/bugs`), [project.id, tick])
  const toast = useToast()
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number] | 'all'>('all')
  const [openOnly, setOpenOnly] = useState(true)
  const [query, setQuery] = useState('')
  const q = useDebounced(query).toLowerCase()

  const rows = useMemo(() => {
    let list = data ?? []
    if (severity !== 'all') list = list.filter((b) => b.severity === severity)
    if (openOnly) list = list.filter((b) => b.status === 'open')
    if (q) list = list.filter((b) => b.title.toLowerCase().includes(q) || b.actual.toLowerCase().includes(q))
    return list
  }, [data, severity, openOnly, q])

  const counts = useMemo(() => {
    const base = openOnly ? (data ?? []).filter((b) => b.status === 'open') : (data ?? [])
    const c: Record<string, number> = { all: base.length }
    for (const s of SEVERITIES) c[s] = base.filter((b) => b.severity === s).length
    return c
  }, [data, openOnly])

  return (
    <Section
      title="Bug reports"
      subtitle="Filed when a test fails and the automatic re-run fails again, so a flaky failure is never reported as a defect. Seeing the same defect a second time raises its count rather than filing another report."
    >
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips options={SEVERITIES} value={severity} onChange={setSeverity} counts={counts} />
        <label className="flex items-center gap-1.5 text-xs text-ink2">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> open only
        </label>
        <div className="ml-auto w-60">
          <SearchInput value={query} onChange={setQuery} placeholder="Search bugs…" />
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Skeleton rows={3} />}
      {data && rows.length === 0 && (
        <Empty title={data.length === 0 ? 'No bugs reported' : 'No bugs match these filters'}>
          {data.length === 0 ? 'Either the application behaves correctly, or the tests have not found anything yet.' : 'Try clearing the filters.'}
        </Empty>
      )}
      <div className="space-y-2">
        {rows.map((b) => (
          <Card key={b.id} className="!p-4">
            <div className="flex items-start gap-3">
              <Badge status={b.severity} />
              <div className="min-w-0 flex-1">
                <Link to={`/bugs/${b.id}`} className="font-semibold text-ink hover:underline">
                  {b.title}
                </Link>
                <div className="mt-0.5 truncate text-xs text-ink2">
                  {b.run?.testCase?.title} · {fmtAgo(b.createdAt)}
                  {b.run && b.run.attempt > 1 ? ' · reproduced on the automatic re-run' : ''}
                </div>
                <div className="mt-1 line-clamp-1 text-xs text-ink2">{b.actual}</div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(b.occurrences ?? 1) > 1 && (
                    <Pill tone="quiet" title={`Last seen ${fmtAgo(b.lastSeenAt)}`}>
                      seen {b.occurrences} times
                    </Pill>
                  )}
                  {b.oracle && (
                    <Pill tone="quiet" title={b.oracleText ?? undefined}>
                      {b.oracle === 'stated-rule' ? 'the page states this rule' : b.oracle === 'specified' ? 'the test said so' : b.oracle === 'implicit' ? 'wrong on any site' : 'inferred by the AI'}
                    </Pill>
                  )}
                </div>

                {b.passingSince && b.status === 'open' && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-ctl bg-data-green/10 px-3 py-2 text-[13px] text-data-green">
                    <IconCheck size={15} />
                    <span>The test that found this has been passing since {fmtAgo(b.passingSince)}.</span>
                    <button
                      className="btn-xs btn-secondary"
                      onClick={async (e) => {
                        e.preventDefault()
                        try {
                          await api.put(`/api/bugs/${b.id}`, { status: 'closed' })
                          toast('Bug closed.', 'ok')
                          reload()
                        } catch (err) {
                          toast((err as Error).message, 'err')
                        }
                      }}
                    >
                      Close it
                    </button>
                  </div>
                )}
              </div>
              <Badge status={b.status} />
            </div>
          </Card>
        ))}
      </div>
    </Section>
  )
}
