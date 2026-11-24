import { useMemo, useState } from 'react'
import { api, type GapScenario, type Project } from '../../api'
import { Badge, Empty, ErrorBox, FilterChips, Section, Skeleton, Spinner, useAsync, useToast } from '../../components/ui'

const STATUSES = ['suggested', 'converted', 'rejected'] as const

export default function GapsTab({ project, onChange }: { project: Project; onChange: () => void }) {
  const [tick, setTick] = useState(0)
  const { data, error, loading, reload } = useAsync(() => api.get<GapScenario[]>(`/api/projects/${project.id}/gaps`), [project.id, tick])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<(typeof STATUSES)[number] | 'all'>('suggested')
  const toast = useToast()

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 }
    for (const s of STATUSES) c[s] = (data ?? []).filter((g) => g.status === s).length
    return c
  }, [data])

  const rows = useMemo(() => (data ?? []).filter((g) => status === 'all' || g.status === status), [data, status])

  async function act(label: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(label)
    setErr(null)
    try {
      const r = (await fn()) as { message?: string }
      toast(r?.message ?? okMsg ?? 'Done.', 'ok')
      setTick((t) => t + 1)
      onChange()
    } catch (e) {
      setErr((e as Error).message)
      toast((e as Error).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section
      title="Missing-test discovery"
      subtitle="For every requirement that is uncovered or only partly covered, TestPilot writes a new test, then filters out near-duplicates, semantic duplicates, and tests that need UI the application does not have."
      actions={
        <button className="btn-primary" disabled={!!busy} onClick={() => act('gen', () => api.post(`/api/projects/${project.id}/gaps/generate`))}>
          {busy === 'gen' ? <Spinner label="Generating and filtering…" /> : '✨ Find missing tests'}
        </button>
      }
    >
      <FilterChips options={STATUSES} value={status} onChange={setStatus} counts={counts} />
      <ErrorBox error={error ?? err} onRetry={reload} />
      {loading && !data && <Skeleton rows={3} />}
      {data && rows.length === 0 && (
        <Empty title={data.length === 0 ? 'No suggestions yet' : `No ${status} suggestions`}>
          Click “Find missing tests”. It profiles coverage first if needed, so you can run it as soon as you have requirements and at least one run.
        </Empty>
      )}
      <div className="space-y-2">
        {rows.map((g) => (
          <div key={g.id} className={`card ${g.status === 'rejected' ? 'opacity-70' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{g.title}</span>
              <Badge status={g.status} />
              <Badge status={g.feasibility} title="Whether the UI this test needs was actually observed in the application" />
              {g.requirement && (
                <span className="text-xs text-ink2">
                  → {g.requirement.key} {g.requirement.text}
                </span>
              )}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{g.instruction}</p>
            {g.rationale && <div className="mt-1 text-xs text-ink2">{g.rationale}</div>}
            {g.neededUi.length > 0 && <div className="mt-1 text-[11px] text-ink2">needs: {g.neededUi.join(' · ')}</div>}
            {g.status === 'suggested' && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn-primary btn-xs" disabled={!!busy} onClick={() => act(g.id, () => api.post(`/api/gaps/${g.id}/accept`, { run: true }), 'Added as a test case and queued.')}>
                  ✓ Accept &amp; run
                </button>
                <button className="btn-secondary btn-xs" disabled={!!busy} onClick={() => act(g.id, () => api.post(`/api/gaps/${g.id}/accept`, { run: false }), 'Added as a test case.')}>
                  Accept
                </button>
                <button className="btn-danger btn-xs" disabled={!!busy} onClick={() => act(g.id, () => api.post(`/api/gaps/${g.id}/reject`), 'Suggestion rejected.')}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}
