import { useState } from 'react'
import { api, type LlmStatus } from '../api'
import { Badge, ErrorBox, Section, Skeleton, Spinner, useAsync } from '../components/ui'

export default function SettingsPage() {
  const [refresh, setRefresh] = useState(0)
  const { data, error, loading, reload } = useAsync(() => api.get<LlmStatus>(`/api/llm/status${refresh ? '?refresh=1' : ''}`), [refresh])

  return (
    <div className="space-y-6">
      <Section
        title="AI providers"
        subtitle="Configured in the repo-root .env file. Each provider has a cheap model for the many per-step decisions and a stronger one for the few reasoning calls — coverage analysis, missing-test generation and bug reports."
        actions={
          <button className="btn-secondary" onClick={() => setRefresh((r) => r + 1)}>
            Re-check
          </button>
        }
      >
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data && <Skeleton rows={3} />}
        {loading && data && <Spinner label="Checking providers" />}
        {data && (
          <div className="space-y-3">
            <div className="card grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="label">Profile</div>
                <div className="font-semibold capitalize">{data.profile}</div>
              </div>
              <div>
                <div className="label">Per-step generation</div>
                <code className="text-xs">{data.step}</code>
              </div>
              <div>
                <div className="label">Reasoning</div>
                <code className="text-xs">{data.reason}</code>
              </div>
            </div>

            {data.providers.map((p) => (
              <div key={p.name} className="card">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold capitalize">{p.name}</span>
                  {!p.configured ? <Badge status="unknown">no API key</Badge> : p.reachable ? <Badge status="passed">reachable</Badge> : <Badge status="failed">unreachable</Badge>}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink2">
                  <span>
                    steps: <code className="rounded bg-raise px-1.5 py-0.5">{p.model || '—'}</code>
                    {p.reachable && p.modelAvailable === false && (
                      <span className="ml-1 font-semibold text-bad">not in the model list — check {p.name.toUpperCase()}_MODEL</span>
                    )}
                  </span>
                  <span>
                    reasoning: <code className="rounded bg-raise px-1.5 py-0.5">{p.reasonModel || p.model || '—'}</code>
                    {p.reachable && p.reasonModelAvailable === false && (
                      <span className="ml-1 font-semibold text-bad">not in the model list — check {p.name.toUpperCase()}_REASON_MODEL</span>
                    )}
                  </span>
                </div>
                {p.error && <div className="mt-1 text-xs text-bad">{p.error}</div>}
                {p.models.length > 0 && (
                  <details className="mt-2 text-xs text-ink2">
                    <summary className="cursor-pointer">{p.models.length} models available on this key</summary>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.models.map((m) => (
                        <code key={m} className={`rounded px-1 ${m === p.model || m === p.reasonModel ? 'bg-accent/15 text-accent' : 'bg-raise'}`}>
                          {m}
                        </code>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="How a test run works">
        <ol className="card list-decimal space-y-1.5 pl-6 text-sm text-ink">
          <li>
            <b>Input</b> — the base URL plus a plain-English instruction. Placeholders such as <code>{'{{unique_email}}'}</code> get fresh values each run; the password is never sent to the AI.
          </li>
          <li>
            <b>Observe</b> — the page becomes an indexed list of interactive elements, including those below the fold, inside iframes and inside open shadow roots.
          </li>
          <li>
            <b>Generate</b> — the AI returns exactly one structured action.
          </li>
          <li>
            <b>Validate</b> — a deterministic checker rejects anything unsupported, ungrounded, off-domain or repetitive. The AI retries up to three times, then the step is flagged.
          </li>
          <li>
            <b>Execute</b> — Playwright performs it, handling dialogs and new tabs; a screenshot is saved per step and a trace per run.
          </li>
          <li>
            <b>Profile</b> — requirements are mapped to the evidence; covered requires a passed assertion.
          </li>
          <li>
            <b>Find gaps</b> — tests are written for uncovered behaviours, then de-duplicated and checked for feasibility against the observed UI.
          </li>
          <li>
            <b>Report</b> — a failure is re-run once; if it reproduces, a bug report is filed with steps to reproduce and a screenshot.
          </li>
        </ol>
      </Section>
    </div>
  )
}
