import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, evidenceUrl, type BugReport } from '../api'
import { Badge, ErrorBox, Lightbox, Skeleton, fmtDate, useAsync, useToast } from '../components/ui'

export default function BugPage() {
  const { id = '' } = useParams()
  const [tick, setTick] = useState(0)
  const { data: bug, error, loading, reload } = useAsync(() => api.get<BugReport>(`/api/bugs/${id}`), [id, tick])
  const [shot, setShot] = useState<string | null>(null)
  const toast = useToast()

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !bug) return <Skeleton rows={4} />
  const project = bug.run?.testCase?.project

  const update = async (body: Record<string, unknown>, msg: string) => {
    await api.put(`/api/bugs/${bug.id}`, body)
    toast(msg, 'ok')
    setTick((t) => t + 1)
  }

  return (
    <div className="space-y-5">
      <Lightbox src={shot} onClose={() => setShot(null)} caption="Failing step" />
      <div className="text-xs text-ink2">
        <Link to="/" className="hover:underline">
          Projects
        </Link>{' '}
        /{' '}
        {project && (
          <Link to={`/projects/${project.id}?tab=bugs`} className="hover:underline">
            {project.name}
          </Link>
        )}{' '}
        / bug
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge status={bug.severity} />
          <h1 className="text-xl font-bold">{bug.title}</h1>
          <Badge status={bug.status} />
          <span className="flex-1" />
          <select className="input w-auto" value={bug.severity} onChange={(e) => update({ severity: e.target.value }, 'Severity updated.')} aria-label="Severity">
            {['critical', 'high', 'medium', 'low'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <a className="btn-secondary" href={`/api/bugs/${bug.id}/markdown`}>
            ⬇ Markdown
          </a>
          <button className="btn-secondary" onClick={() => update({ status: bug.status === 'open' ? 'closed' : 'open' }, bug.status === 'open' ? 'Bug closed.' : 'Bug reopened.')}>
            {bug.status === 'open' ? 'Mark as closed' : 'Reopen'}
          </button>
        </div>

        <div className="text-xs text-ink2">
          reported {fmtDate(bug.createdAt)} · test “{bug.run?.testCase?.title}” ·{' '}
          <Link to={`/runs/${bug.runId}`} className="link">
            view the run
          </Link>
          {bug.run && bug.run.attempt > 1 ? ' · reproduced on the automatic re-run, so it is not flaky' : ''}
        </div>

        <div className="grid gap-5 md:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <div>
              <div className="label">Steps to reproduce</div>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm">
                {bug.stepsToReproduce.map((s, i) => (
                  <li key={i} className={s.includes('← FAILS') ? 'font-semibold text-bad' : ''}>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <div className="label">Expected</div>
              <p className="text-sm">{bug.expected}</p>
            </div>
            <div>
              <div className="label">Actual</div>
              <p className="text-sm text-bad">{bug.actual}</p>
            </div>
            {bug.notes && (
              <div>
                <div className="label">Notes for the developer</div>
                <p className="text-sm text-ink">{bug.notes}</p>
              </div>
            )}
          </div>
          {bug.screenshotPath && (
            <div>
              <div className="label">Failing step</div>
              <button onClick={() => setShot(evidenceUrl(bug.screenshotPath))}>
                <img src={evidenceUrl(bug.screenshotPath)} alt="failing step" className="rounded border border-line transition hover:border-accent" />
              </button>
            </div>
          )}
        </div>
      </div>

      {bug.markdown && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">Markdown preview</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-ink">{bug.markdown}</pre>
        </details>
      )}
    </div>
  )
}
