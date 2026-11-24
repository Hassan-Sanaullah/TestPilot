import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Project, type Run } from '../../api'
import { Badge, Empty, ErrorBox, FilterChips, SearchInput, Section, Skeleton, SortHeader, duration, fmtAgo, useAsync, useDebounced, useSort } from '../../components/ui'

const STATUSES = ['passed', 'failed', 'error', 'running', 'cancelled'] as const

export default function RunsTab({ project, tick }: { project: Project; tick: number }) {
  const { data, error, loading, reload } = useAsync(() => api.get<Run[]>(`/api/projects/${project.id}/runs`), [project.id, tick])
  const [status, setStatus] = useState<(typeof STATUSES)[number] | 'all'>('all')
  const [query, setQuery] = useState('')
  const q = useDebounced(query).toLowerCase()

  const rows = useMemo(() => {
    let list = data ?? []
    if (status !== 'all') list = list.filter((r) => (status === 'running' ? r.status === 'running' || r.status === 'queued' : r.status === status))
    if (q) list = list.filter((r) => (r.testCase?.title ?? '').toLowerCase().includes(q) || (r.reason ?? '').toLowerCase().includes(q))
    return list
  }, [data, status, q])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 }
    for (const s of STATUSES) c[s] = (data ?? []).filter((r) => (s === 'running' ? r.status === 'running' || r.status === 'queued' : r.status === s)).length
    return c
  }, [data])

  const sort = useSort<Run>(rows, 'createdAt', {
    createdAt: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    llmCalls: (a, b) => a.llmCalls - b.llmCalls,
  })

  return (
    <Section title="Run history" subtitle="Every execution, with its steps, evidence and the Playwright trace.">
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips options={STATUSES} value={status} onChange={setStatus} counts={counts} />
        <div className="ml-auto w-64">
          <SearchInput value={query} onChange={setQuery} placeholder="Search test or result…" />
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Skeleton rows={4} />}
      {data && rows.length === 0 && <Empty>{data.length === 0 ? 'No runs yet — run a test case to see it here.' : 'No runs match these filters.'}</Empty>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Status</th>
                <th>Result</th>
                <th className="hidden sm:table-cell">Steps</th>
                <SortHeader<Run> label="LLM calls" k="llmCalls" state={sort} />
                <th className="hidden sm:table-cell">Duration</th>
                <SortHeader<Run> label="Started" k="createdAt" state={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/runs/${r.id}`} className="link font-medium">
                      {r.testCase?.title}
                    </Link>
                    {r.attempt > 1 && <span className="ml-2 text-xs text-ink2">re-run</span>}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <Badge status={r.status} />
                      {r.flaky && <Badge status="flaky">flaky</Badge>}
                    </div>
                  </td>
                  <td className="max-w-md truncate text-ink2" title={r.reason ?? ''}>
                    {r.reason ?? '—'}
                    {r._count?.bugReports ? <span className="ml-2 text-xs font-semibold text-bad">bug filed</span> : null}
                  </td>
                  <td className="hidden sm:table-cell">{r._count?.steps ?? 0}</td>
                  <td>{r.llmCalls}</td>
                  <td className="hidden sm:table-cell">{duration(r.startedAt, r.finishedAt)}</td>
                  <td className="whitespace-nowrap text-ink2">{fmtAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
