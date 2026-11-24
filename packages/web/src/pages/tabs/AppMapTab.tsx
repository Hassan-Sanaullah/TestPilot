import { useMemo, useState } from 'react'
import { api, type AppMap, type InventoryItem, type Project } from '../../api'
import { Badge, Empty, ErrorBox, SearchInput, Section, Skeleton, Spinner, fmtAgo, useAsync, useDebounced, useToast } from '../../components/ui'

/**
 * What TestPilot knows about the application — discovered by walking it, from
 * the DOM alone. This is what the test generator reads, so being able to look
 * at it explains why it proposed what it proposed.
 */
export default function AppMapTab({ project }: { project: Project }) {
  const [tick, setTick] = useState(0)
  const { data, error, loading, reload } = useAsync(() => api.get<AppMap>(`/api/projects/${project.id}/map`), [project.id, tick])
  const inventory = useAsync(() => api.get<InventoryItem[]>(`/api/projects/${project.id}/inventory`), [project.id, tick])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const q = useDebounced(query).toLowerCase()
  const toast = useToast()

  const pages = useMemo(
    () => (data?.pages ?? []).filter((p) => !q || p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.kind.includes(q)),
    [data, q],
  )

  async function explore() {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.post<{ visited: number; loggedIn: boolean }>(`/api/projects/${project.id}/explore`)
      toast(`Mapped ${r.visited} page(s)${r.loggedIn ? ', signed in' : ''}.`, 'ok')
      setTick((t) => t + 1)
    } catch (e) {
      setErr((e as Error).message)
      toast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Application map"
      subtitle="Built by walking your application and reading its HTML — no source code, no instrumentation. TestPilot signs in with the test account where it can, so pages that only exist behind a login are mapped too."
      actions={
        <button className="btn-primary" disabled={busy} onClick={explore}>
          {busy ? <Spinner label="Exploring…" /> : '🔍 Explore again'}
        </button>
      }
    >
      <ErrorBox error={error ?? err} onRetry={reload} />
      {loading && !data && <Skeleton rows={3} />}
      {data && data.pages.length === 0 && (
        <Empty title="Not explored yet" action={<button className="btn-primary" onClick={explore}>🔍 Explore my app</button>}>
          TestPilot will walk the application, record its pages and forms, and use that to write tests.
        </Empty>
      )}

      {data && data.pages.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-full sm:w-72">
              <SearchInput value={query} onChange={setQuery} placeholder="Search pages…" />
            </div>
            <span className="text-sm text-ink2">
              {data.pages.length} page(s) · {data.pages.filter((p) => p.requiresAuth).length} behind a login
            </span>
          </div>

          <div className="space-y-2">
            {pages.map((p) => (
              <details key={p.id} className="card" open={p.forms.length > 0 || p.rules.length > 0}>
                <summary className="cursor-pointer">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Badge status={p.kind === 'auth' ? 'partial' : p.kind === 'admin' ? 'gap' : 'unknown'}>{p.kind}</Badge>
                    <span className="font-mono text-xs">{p.url}</span>
                    {p.requiresAuth && <Badge status="flagged">needs login</Badge>}
                    {p.forms.length > 0 && <span className="text-xs text-ink2">{p.forms.length} form(s)</span>}
                  </span>
                </summary>

                {p.rules.length > 0 && (
                  <div className="mt-2">
                    <div className="label">Rules this page states</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm">
                      {p.rules.map((r, i) => (
                        <li key={i}>“{r}”</li>
                      ))}
                    </ul>
                    <p className="mt-1 text-[11px] text-ink2">Generated tests judge the application against these.</p>
                  </div>
                )}

                {p.forms.map((f, i) => (
                  <div key={i} className="mt-2">
                    <div className="label">Form{f.submitLabel ? ` — submitted by “${f.submitLabel}”` : ''}</div>
                    <div className="overflow-x-auto">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Type</th>
                            <th>Required</th>
                            <th>Rule / options</th>
                          </tr>
                        </thead>
                        <tbody>
                          {f.fields.map((x, j) => (
                            <tr key={j}>
                              <td>{x.label}</td>
                              <td className="font-mono text-xs">{x.type}</td>
                              <td>{x.required ? 'yes' : '—'}</td>
                              <td className="text-ink2">{x.options?.length ? x.options.join(' / ') : x.hint || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {p.actions.length > 0 && (
                  <p className="mt-2 text-[11px] text-ink2">actions: {p.actions.slice(0, 18).join(' · ')}</p>
                )}
                <p className="mt-1 text-[11px] text-ink2">seen {fmtAgo(p.discoveredAt)}</p>
              </details>
            ))}
          </div>

          <details className="card">
            <summary className="cursor-pointer text-sm font-semibold">
              Raw element inventory{inventory.data ? ` (${inventory.data.length})` : ''}
            </summary>
            <p className="mt-1 text-xs text-ink2">Every interactive element ever observed, including during test runs. The missing-test filter uses this to reject tests that need UI the app does not have.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(inventory.data ?? []).slice(0, 400).map((i) => (
                <span key={i.id} className="rounded border border-line px-1.5 py-0.5 text-[11px]" title={i.url}>
                  {i.role}: {i.label}
                </span>
              ))}
            </div>
          </details>
        </>
      )}
    </Section>
  )
}
