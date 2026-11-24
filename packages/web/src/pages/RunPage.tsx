import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { RunEvent, StepDTO } from '@testpilot/shared'
import { type Action, type ElementRef, describeAction, describeCandidate } from '@testpilot/shared'
import { api, evidenceUrl, type Run } from '../api'
import { IconAlert, IconDownload, IconReplay, IconSparkle } from '../components/icons'
import { Badge, Card, ErrorBox, Lightbox, Pill, Skeleton, Spinner, StatusBadge, Tabs, duration, fmtDate, useToast } from '../components/ui'

type Panel = 'screen' | 'saw' | 'locator' | 'log'

/**
 * One run, with the step list driving everything else.
 *
 * Selecting a step changes the screenshot, the error, what the AI saw at that
 * moment and the locator it used. Before this, those four things were scattered
 * down the page inside each step and you could not compare one step with the
 * next — which is exactly what you do when working out why a test failed.
 */
export default function RunPage() {
  const { id = '' } = useParams()
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>('screen')
  // Once the user picks a step, stop jumping to the newest one under them.
  const pinned = useRef(false)
  const toast = useToast()

  const load = useCallback(() => api.get<Run>(`/api/runs/${id}`).then(setRun, (e) => setError((e as Error).message)), [id])

  useEffect(() => {
    void load()
    const es = new EventSource(`/api/runs/${id}/events`)
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as RunEvent
      if (ev.type === 'run.step') {
        setRun((r) => (r ? { ...r, steps: [...(r.steps ?? []).filter((s) => s.id !== ev.step.id), ev.step].sort((a, b) => a.index - b.index) } : r))
        if (!pinned.current) setSelectedId(ev.step.id)
      } else if (ev.type === 'run.log') setLogs((l) => [...l.slice(-120), ev.message])
      else if (ev.type === 'run.status' || ev.type === 'run.done') void load()
    }
    return () => es.close()
  }, [id, load])

  const steps = useMemo(() => run?.steps ?? [], [run])
  const withShots = useMemo(() => steps.filter((s) => s.screenshotPath), [steps])
  const failing = useMemo(() => steps.find((s) => s.status !== 'ok'), [steps])

  // Default selection: the step that failed, or the last one.
  useEffect(() => {
    if (selectedId || steps.length === 0) return
    setSelectedId((failing ?? steps[steps.length - 1]).id)
  }, [steps, failing, selectedId])

  const selectedIdx = steps.findIndex((s) => s.id === selectedId)
  const step: StepDTO | undefined = steps[selectedIdx] ?? steps[steps.length - 1]

  const select = useCallback((s: StepDTO) => {
    pinned.current = true
    setSelectedId(s.id)
  }, [])

  // Arrow keys walk the timeline, which is what you want when comparing steps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const next = steps[Math.min(steps.length - 1, Math.max(0, selectedIdx + dir))]
      if (next) {
        e.preventDefault()
        select(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps, selectedIdx, select])

  if (error) return <ErrorBox error={error} onRetry={load} />
  if (!run) return <Skeleton rows={5} />

  const live = run.status === 'running' || run.status === 'queued'
  const project = run.testCase?.project
  const anomalies = run.anomalies ?? []
  const bug = run.bugReports?.[0]
  const locator = step?.locator ? (safeJson(step.locator) as ElementRef | null) : null
  const lightboxStep = lightbox === null ? null : withShots[lightbox]

  return (
    <div className="space-y-4">
      <Lightbox
        src={lightboxStep ? evidenceUrl(lightboxStep.screenshotPath) : null}
        caption={lightboxStep ? `Step ${lightboxStep.index} — ${describeSafe(lightboxStep.action)}` : ''}
        onClose={() => setLightbox(null)}
        onPrev={lightbox !== null && lightbox > 0 ? () => setLightbox((i) => (i ?? 0) - 1) : undefined}
        onNext={lightbox !== null && lightbox < withShots.length - 1 ? () => setLightbox((i) => (i ?? 0) + 1) : undefined}
      />

      <nav className="text-xs text-ink2">
        <Link to="/" className="hover:underline">
          Projects
        </Link>
        {' / '}
        {project && (
          <Link to={`/projects/${project.id}?tab=runs`} className="hover:underline">
            {project.name}
          </Link>
        )}
        {' / run'}
      </nav>

      {/* ------------------------------------------------------------ header */}
      <Card orb={run.status === 'failed' ? '#D1476A' : run.status === 'passed' ? '#0E9C63' : '#5C5FC8'}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-bold text-ink">{run.testCase?.title}</h1>
          <StatusBadge status={run.status} failureKind={run.failureKind} expectation={run.testCase?.expectation} quarantined={run.testCase?.quarantined} flaky={run.flaky} />
          <span className="flex-1" />
          {live && (
            <button
              className="btn-danger btn-sm"
              onClick={() => {
                void api.post(`/api/runs/${run.id}/cancel`)
                toast('Cancelling the run…')
              }}
            >
              Cancel
            </button>
          )}
          {run.tracePath && (
            <a className="btn-secondary btn-sm" href={`/api/runs/${run.id}/trace`}>
              <IconDownload size={14} /> Playwright trace
            </a>
          )}
          {bug && (
            <Link to={`/bugs/${bug.id}`} className="btn-danger btn-sm">
              Bug report
            </Link>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-2">
          <Pill tone="quiet">
            {run.mode === 'replay' ? <IconReplay size={14} /> : <IconSparkle size={14} />}
            {run.mode === 'replay' ? 'deterministic replay' : 'AI authoring'}
          </Pill>
          <Pill tone="quiet">{run.llmCalls} AI calls</Pill>
          <Pill tone="quiet">{duration(run.startedAt, run.finishedAt)}</Pill>
          <Pill tone="quiet">{steps.length} steps</Pill>
          {project && (
            <Pill tone="quiet">
              {project.viewportWidth}×{project.viewportHeight}
            </Pill>
          )}
          {run.failureKind && (
            <Pill tone="quiet" title={run.failureKind === 'app' ? 'The application misbehaved.' : 'TestPilot could not drive the browser; this says nothing about the application.'}>
              {run.failureKind === 'app' ? 'application failure' : 'tool failure'}
            </Pill>
          )}
          {run.oracle && <Pill tone="quiet" title="Where the expectation came from">{oracleWords(run.oracle)}</Pill>}
          {!!run.healedSteps && <Pill tone="quiet">{run.healedSteps} locator(s) repaired</Pill>}
          {run.attempt > 1 && <Pill tone="quiet">automatic re-run (attempt {run.attempt})</Pill>}
          {run.model && <Pill tone="quiet">{run.model}</Pill>}
        </div>

        <p className="mt-3 whitespace-pre-wrap text-sm text-ink2">{run.testCase?.instruction}</p>

        {run.reason && (
          <p
            className={`mt-3 rounded-ctl px-3.5 py-2.5 text-sm ${
              run.status === 'passed' ? 'bg-data-green/10 text-data-green' : run.status === 'failed' ? 'bg-bad/10 text-bad' : 'bg-raise text-ink2'
            }`}
          >
            {run.reason}
          </p>
        )}

        {run.testCase?.oracleText && (
          <p className="mt-2 text-[13px] text-ink2">
            Judged against: <span className="text-ink">{run.testCase.oracleText}</span>
          </p>
        )}

        {anomalies.length > 0 && (
          <div className="mt-3 rounded-ctl border border-data-amber/40 bg-data-amber/10 px-3.5 py-2.5">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <IconAlert size={15} /> Noticed while running
            </p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-ink2">
              {anomalies.map((a, i) => (
                <li key={i}>
                  {a.kind === 'http-5xx' ? (
                    <>
                      The server returned HTTP {a.status} for {a.url} at step {a.step}. Nothing in this test was checking that.
                    </>
                  ) : (
                    <>
                      The page threw an error at step {a.step}: {a.message}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {bug && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="card-raise">
              <p className="label">Expected</p>
              <p className="text-sm text-ink">{bug.expected || '—'}</p>
            </div>
            <div className="card-raise">
              <p className="label">Actual</p>
              <p className="text-sm text-ink">{bug.actual || failing?.error || '—'}</p>
            </div>
          </div>
        )}
        {!bug && failing?.error && (
          <div className="mt-3 card-raise">
            <p className="label">What went wrong</p>
            <p className="text-sm text-ink">{failing.error}</p>
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- filmstrip */}
      {withShots.length > 1 && (
        <Card className="!p-3">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {withShots.map((s, i) => (
              <button
                key={s.id}
                onClick={() => select(s)}
                onDoubleClick={() => setLightbox(i)}
                className="shrink-0"
                title={`Step ${s.index} — ${describeSafe(s.action)} (double-click to enlarge)`}
                aria-current={s.id === step?.id ? 'true' : undefined}
              >
                <img
                  src={evidenceUrl(s.screenshotPath)}
                  alt={`Step ${s.index}`}
                  loading="lazy"
                  className={`h-[68px] w-[108px] rounded-xl border-2 object-cover object-top transition
                              ${s.id === step?.id ? 'border-accent' : s.status === 'ok' ? 'border-transparent opacity-80 hover:opacity-100' : 'border-bad'}`}
                />
                <div className={`mt-1 text-center text-[10px] ${s.status === 'ok' ? 'text-ink2' : 'font-semibold text-bad'}`}>{s.index}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* ------------------------------------------------- steps + the viewer */}
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="!p-2">
          <ol className="max-h-[620px] space-y-1 overflow-y-auto pr-1">
            {steps.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => select(s)}
                  className={`flex w-full gap-2.5 rounded-ctl px-2.5 py-2 text-left transition
                              ${s.id === step?.id ? 'bg-accent/12 ring-1 ring-accent' : 'hover:bg-raise'}`}
                  aria-current={s.id === step?.id ? 'true' : undefined}
                >
                  <span
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold
                                ${s.status === 'ok' ? 'bg-raise text-ink2' : s.status === 'flagged' ? 'bg-data-amber/20 text-data-amber' : 'bg-bad/20 text-bad'}`}
                  >
                    {s.index}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] text-ink">{describeSafe(s.action)}</span>
                    {s.error && <span className="mt-0.5 block text-[11px] text-bad">{s.error.slice(0, 90)}</span>}
                    <span className="mt-0.5 block text-[10px] text-ink2">{s.durationMs} ms</span>
                  </span>
                </button>
              </li>
            ))}
            {live && (
              <li className="px-2.5 py-2">
                <Spinner label={run.status === 'queued' ? 'Queued' : 'Observing the page…'} />
              </li>
            )}
          </ol>
        </Card>

        <Card className="min-w-0">
          {!step ? (
            <p className="text-sm text-ink2">No steps yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-ink">
                  {step.index}. {describeSafe(step.action)}
                </span>
                <Badge status={step.status} />
                {step.validationAttempts > 1 && <Badge status="partial">{step.validationAttempts - 1} rejected by the validator</Badge>}
              </div>
              {step.thought && <p className="mt-1.5 text-sm italic text-ink2">&ldquo;{step.thought}&rdquo;</p>}
              {step.error && <p className="mt-1.5 rounded-ctl bg-bad/10 px-3 py-2 text-sm text-bad">{step.error}</p>}
              <p className="mt-1.5 truncate text-[11px] text-ink2" title={step.url}>
                {step.url}
              </p>

              {step.rejections.length > 0 && (
                <details className="mt-2 text-xs text-data-amber">
                  <summary className="cursor-pointer">Why the validator pushed back ({step.rejections.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {step.rejections.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="hr-soft" />

              <Tabs
                options={[
                  { key: 'screen' as const, label: 'Screenshot' },
                  { key: 'saw' as const, label: 'What the AI saw' },
                  { key: 'locator' as const, label: 'Locator' },
                  { key: 'log' as const, label: 'Log' },
                ]}
                value={panel}
                onChange={setPanel}
              />

              <div className="mt-3">
                {panel === 'screen' &&
                  (step.screenshotPath ? (
                    <button className="block w-full" onClick={() => setLightbox(withShots.findIndex((x) => x.id === step.id))}>
                      <img
                        src={evidenceUrl(step.screenshotPath)}
                        alt={`The page at step ${step.index}`}
                        className="w-full rounded-inner border border-line object-top"
                      />
                    </button>
                  ) : (
                    <p className="text-sm text-ink2">No screenshot for this step.</p>
                  ))}

                {panel === 'saw' &&
                  (step.observation ? (
                    <pre className="max-h-[480px] overflow-auto rounded-inner bg-raise p-3 font-mono text-[11px] leading-relaxed text-ink">{step.observation}</pre>
                  ) : (
                    <p className="text-sm text-ink2">
                      Not recorded for this step. A replay consults no model, and in a plan of several actions only the first records what the model was looking at.
                    </p>
                  ))}

                {panel === 'locator' &&
                  (locator ? (
                    <div className="space-y-2 text-sm">
                      <p className="text-ink2">
                        Recorded as: <span className="text-ink">{locator.description}</span>
                      </p>
                      <pre className="overflow-auto rounded-inner bg-raise p-3 font-mono text-[12px] text-ink">{describeCandidate(locator.candidate)}</pre>
                      {locator.alternates && locator.alternates.length > 0 && (
                        <>
                          <p className="text-[12px] text-ink2">
                            Spare locators verified against the same element, used to repair this step without a model call if the first one stops matching:
                          </p>
                          <ul className="space-y-1">
                            {locator.alternates.map((a, i) => (
                              <li key={i} className="rounded-ctl bg-raise px-2.5 py-1.5 font-mono text-[11px] text-ink2">
                                {describeCandidate(a.candidate)}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-ink2">This step did not target an element.</p>
                  ))}

                {panel === 'log' &&
                  (logs.length > 0 ? (
                    <pre className="max-h-[480px] overflow-auto rounded-inner bg-raise p-3 font-mono text-[11px] leading-relaxed text-ink2">{logs.join('\n')}</pre>
                  ) : (
                    <p className="text-sm text-ink2">The live log is only kept while a run is in progress.</p>
                  ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <p className="text-center text-[11px] text-ink2">Use the arrow keys to step through.</p>
    </div>
  )
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function describeSafe(action: unknown): string {
  const a = action as Action | { type: string } | null
  if (!a || typeof a !== 'object') return 'unknown action'
  if (a.type === 'invalid') return 'invalid action (flagged)'
  try {
    return describeAction(a as Action)
  } catch {
    return a.type
  }
}

function oracleWords(oracle: string): string {
  if (oracle === 'specified') return 'the test said so'
  if (oracle === 'stated-rule') return 'the page states this rule'
  if (oracle === 'implicit') return 'wrong on any site'
  return 'inferred by the AI'
}
