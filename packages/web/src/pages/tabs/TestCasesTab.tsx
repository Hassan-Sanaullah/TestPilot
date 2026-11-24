import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { lintBlocks, lintInstruction } from '@testpilot/shared'
import { api, type LintResult, type Project, type Run, type TestCase } from '../../api'
import QuickTest from '../../components/QuickTest'
import { IconDownload, IconPlay, IconReplay, IconShield, KindIcon } from '../../components/icons'
import {
  Badge,
  Card,
  CircleBadge,
  Empty,
  ErrorBox,
  Modal,
  Pill,
  SearchInput,
  Section,
  Skeleton,
  Spinner,
  StatusBadge,
  fmtAgo,
  useAsync,
  useDebounced,
  useToast,
} from '../../components/ui'

/** Plain words for a technique. "BVA min−1" means nothing to most people. */
const TECHNIQUE_LABEL: Record<string, string> = {
  boundary: 'boundary: the value at the edge of the rule',
  required: 'a required field left empty',
  format: 'a value of the wrong kind',
  equivalence: 'two values that must agree',
  uniqueness: 'a value that is already taken',
  selection: 'one of the options the page offers',
  flow: 'a sequence a user would perform',
}

export default function TestCasesTab({ project, onChange }: { project: Project; onChange: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.get<TestCase[]>(`/api/projects/${project.id}/testcases`), [project.id])
  const [form, setForm] = useState({ title: '', instruction: '' })
  const [editing, setEditing] = useState<TestCase | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const q = useDebounced(query).toLowerCase()
  const toast = useToast()

  const rows = useMemo(() => (data ?? []).filter((t) => !q || t.title.toLowerCase().includes(q) || t.instruction.toLowerCase().includes(q)), [data, q])

  async function act(fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      if (okMsg) toast(okMsg, 'ok')
      reload()
      onChange()
    } catch (e) {
      setErr((e as Error).message)
      toast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const runSelected = () =>
    act(async () => {
      for (const id of selected) await api.post(`/api/testcases/${id}/run`)
      setSelected(new Set())
    }, `Queued ${selected.size} run(s).`)

  return (
    <Section
      title="Test cases"
      subtitle="Plain English. Say what to do and what must be true afterwards — the assertion is what makes it a test."
      actions={
        <>
          {selected.size > 0 && (
            <>
              <button className="btn-secondary" disabled={busy} onClick={() => setSelected(new Set())}>
                Clear ({selected.size})
              </button>
              <button className="btn-primary" disabled={busy} onClick={runSelected}>
                <IconPlay size={15} /> Run selected ({selected.size})
              </button>
            </>
          )}
          <button
            className="btn-secondary"
            disabled={busy || !data?.length}
            onClick={() => act(() => api.post(`/api/projects/${project.id}/suite-runs`, {}), 'The suite is running.')}
          >
            <IconPlay size={15} /> Run all
          </button>
          <a className="btn-ghost btn-sm" href={`/api/projects/${project.id}/spec`} title="Every authored test as one ordinary Playwright file">
            <IconDownload size={15} /> Export
          </a>
          <button
            className="btn-secondary"
            onClick={() => {
              setEditing(null)
              setForm({ title: '', instruction: '' })
              setOpen(true)
            }}
          >
            Write one myself
          </button>
        </>
      }
    >
      <QuickTest
        project={project}
        onCreated={() => {
          reload()
          onChange()
        }}
      />

      <ErrorBox error={error ?? err} onRetry={reload} />
      {(data?.length ?? 0) > 0 && (
        <div className="w-full sm:w-72">
          <SearchInput value={query} onChange={setQuery} placeholder="Search test cases…" />
        </div>
      )}
      {loading && !data && <Skeleton rows={3} />}
      {data && rows.length === 0 && data.length > 0 && <Empty title="No test matches your search">Try clearing the search.</Empty>}

      <div className="space-y-2">
        {rows.map((tc) => {
          const last: Run | undefined = tc.runs?.[0]
          return (
            <Card key={tc.id} className="flex gap-3 !p-4">
              <input type="checkbox" className="mt-2 h-4 w-4 accent-[#5C5FC8]" checked={selected.has(tc.id)} onChange={() => toggle(tc.id)} aria-label={`Select ${tc.title}`} />

              {last ? <CircleBadge status={last.status} failureKind={last.failureKind} /> : <CircleBadge status="queued" />}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ink2">
                    <KindIcon kind={tc.kind} />
                  </span>
                  <span className="font-semibold text-ink">{tc.title}</span>

                  {tc.hasScript ? (
                    <Badge
                      status={tc.scriptVerifiedAt ? 'passed' : 'rule'}
                      title={
                        tc.scriptVerifiedAt
                          ? 'Compiled and checked by a replay: these steps reproduce. Every run from now on is deterministic, free and fast.'
                          : 'Compiled from a run. A verification replay will confirm the steps reproduce.'
                      }
                    >
                      {tc.scriptVerifiedAt ? <IconShield size={13} /> : null}
                      deterministic
                    </Badge>
                  ) : (
                    <Badge status="unknown" title="Not compiled yet. The AI drives the browser on each run. Run it once successfully and TestPilot records a replayable script.">
                      AI-driven
                    </Badge>
                  )}

                  {tc.expectation === 'known-failing' && (
                    <Badge status="failed" title="This test records a defect on purpose. Replay it after a fix and it should turn green.">
                      known failure
                    </Badge>
                  )}
                  {tc.quarantined && (
                    <Badge status="quarantined" title="This test has proven unreliable, so it does not decide the suite result. It still runs.">
                      quarantined
                    </Badge>
                  )}
                  {tc.designKey && (
                    <Badge status="designed" title="Computed from a rule the application states about itself, rather than written by the AI.">
                      designed
                    </Badge>
                  )}
                  {lintBlocks(lintInstruction(tc.instruction)) && (
                    <Badge status="flagged" title="This instruction states no expected outcome, so a run cannot judge pass or fail reliably. Edit it to add one.">
                      unclear instruction
                    </Badge>
                  )}
                  {tc.origin === 'gap' && <Badge status="gap">from missing-test discovery</Badge>}
                  {last && (
                    <Link to={`/runs/${last.id}`}>
                      <StatusBadge status={last.status} failureKind={last.failureKind} expectation={tc.expectation} flaky={last.flaky} />
                    </Link>
                  )}
                </div>

                {tc.technique && TECHNIQUE_LABEL[tc.technique] && <p className="mt-1 text-[12px] text-ink2">{TECHNIQUE_LABEL[tc.technique]}</p>}
                {tc.oracleText && (
                  <p className="mt-0.5 text-[12px] text-ink2">
                    Checks the rule: <span className="text-ink">{tc.oracleText}</span>
                  </p>
                )}

                <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink2">{tc.instruction}</p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink2">
                  <span>
                    {tc._count?.runs ?? 0} run(s) · last {fmtAgo(last?.createdAt)}
                  </span>
                  {tc.requirements?.filter((r) => r.confirmed).map((r) => (
                    <Pill key={r.key} tone="quiet">
                      {r.key}
                    </Pill>
                  ))}
                  {tc.auth === 'signed-in' && <Pill tone="quiet">signed in</Pill>}
                </div>
                {last?.reason && <p className="mt-1 text-[12px] text-ink2">{last.reason.slice(0, 160)}</p>}
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                <button
                  className="btn-primary btn-xs"
                  disabled={busy}
                  onClick={() => act(() => api.post(`/api/testcases/${tc.id}/run`), tc.hasScript ? 'Replaying.' : 'Run queued.')}
                >
                  {tc.hasScript ? <IconReplay size={13} /> : <IconPlay size={13} />}
                  {tc.hasScript ? 'Replay' : 'Run'}
                </button>
                {tc.hasScript && (
                  <button
                    className="btn-secondary btn-xs"
                    disabled={busy}
                    title="Let the AI drive the browser again and record a fresh script. Use this after the application has genuinely changed."
                    onClick={() => act(() => api.post(`/api/testcases/${tc.id}/run`, { mode: 'ai' }), 'Re-authoring with AI.')}
                  >
                    Re-author
                  </button>
                )}
                {tc.hasScript && (
                  <a className="btn-ghost btn-xs" href={`/api/testcases/${tc.id}/spec`} title="Download as an ordinary Playwright spec you can run in CI">
                    <IconDownload size={13} /> .spec.ts
                  </a>
                )}
                <button
                  className="btn-ghost btn-xs"
                  onClick={() => {
                    setEditing(tc)
                    setForm({ title: tc.title, instruction: tc.instruction })
                    setOpen(true)
                  }}
                >
                  Edit
                </button>
                <button
                  className="btn-danger btn-xs"
                  disabled={busy}
                  onClick={() => confirm(`Delete "${tc.title}" and all its runs?`) && act(() => api.del(`/api/testcases/${tc.id}`), 'Test deleted.')}
                >
                  Delete
                </button>
              </div>
            </Card>
          )
        })}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit test case' : 'New test case'} wide>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const save = editing ? () => api.put(`/api/testcases/${editing.id}`, form) : () => api.post(`/api/projects/${project.id}/testcases`, form)
            act(save, editing ? 'Test updated.' : 'Test created.').then(() => setOpen(false))
          }}
        >
          <div>
            <label className="label" htmlFor="tc-title">
              Title
            </label>
            <input id="tc-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="tc-instr">
              Instruction — say what to do <em>and</em> what must be true afterwards
            </label>
            <textarea id="tc-instr" className="input font-mono text-xs" rows={6} value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} required />
            <p className="mt-1 text-[11px] text-ink2">
              Placeholders: <code>{'{{unique_email}}'}</code> <code>{'{{unique_id}}'}</code> <code>{'{{test_user}}'}</code> <code>{'{{test_password}}'}</code> (the password is never sent to the AI).
            </p>
          </div>

          <InstructionReview
            projectId={project.id}
            instruction={form.instruction}
            onUse={(text) => setForm((f) => ({ ...f, instruction: text }))}
            onUseAlternative={(title, instruction) => setForm({ title, instruction })}
          />
          <ErrorBox error={err} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy}>
              {editing ? 'Save changes' : 'Create test case'}
            </button>
          </div>
        </form>
      </Modal>
    </Section>
  )
}

/**
 * Quality feedback on the instruction. The deterministic checks run as you
 * type; the AI rewrite is on demand, because it costs a call.
 */
function InstructionReview({
  projectId,
  instruction,
  onUse,
  onUseAlternative,
}: {
  projectId: string
  instruction: string
  onUse: (text: string) => void
  onUseAlternative: (title: string, instruction: string) => void
}) {
  const debounced = useDebounced(instruction, 400)
  const issues = useMemo(() => (debounced.trim() ? lintInstruction(debounced) : []), [debounced])
  const [ai, setAi] = useState<LintResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // A rewrite is about the old text once the instruction changes.
  useEffect(() => setAi(null), [debounced])

  const review = async () => {
    setBusy(true)
    setErr(null)
    try {
      setAi(await api.post<LintResult>(`/api/projects/${projectId}/testcases/review`, { instruction: debounced, ai: true }))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!debounced.trim()) return null
  const blocking = lintBlocks(issues)

  return (
    <div className={`rounded-md border p-3 text-sm ${blocking ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {issues.length === 0 ? (
          <span className="font-medium text-data-green">✓ This instruction states a clear, checkable outcome.</span>
        ) : (
          <span className="font-medium">{blocking ? '⚠ This instruction will not test anything reliably' : 'Suggestions'}</span>
        )}
        <span className="flex-1" />
        <button type="button" className="btn-secondary btn-xs" disabled={busy} onClick={review}>
          {busy ? <Spinner label="Reviewing…" /> : '✨ Improve with AI'}
        </button>
      </div>

      {issues.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {issues.map((i) => (
            <li key={i.code} className="text-xs">
              <span className={i.severity === 'error' ? 'font-semibold text-data-amber' : 'font-semibold text-ink2'}>{i.message}</span>{' '}
              <span className="text-ink2">{i.hint}</span>
            </li>
          ))}
        </ul>
      )}

      {err && <p className="mt-2 text-xs text-bad">{err}</p>}

      {ai?.problems && ai.problems.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink2">
          {ai.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}

      {ai?.improved && (
        <div className="mt-3 rounded border border-accent bg-white p-2 dark:bg-raise">
          <div className="label">Suggested rewrite</div>
          <p className="font-mono text-xs">{ai.improved}</p>
          <button type="button" className="btn-primary btn-xs mt-2" onClick={() => onUse(ai.improved!)}>
            Use this
          </button>
        </div>
      )}

      {ai?.alternatives && ai.alternatives.length > 0 && (
        <div className="mt-2">
          <div className="label">Other cases worth testing separately</div>
          <div className="space-y-1">
            {ai.alternatives.map((a) => (
              <button
                key={a.title}
                type="button"
                className="block w-full rounded border border-line px-2 py-1 text-left text-xs hover:border-accent"
                onClick={() => onUseAlternative(a.title, a.instruction)}
              >
                <span className="font-semibold">{a.title}</span>
                <span className="block text-ink2">{a.instruction}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
