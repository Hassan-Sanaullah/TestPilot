import { type FormEvent, useState } from 'react'
import { api, type AppMap, type DraftTest, type Project, type SuiteResult } from '../api'
import { IconPlay, IconSparkle, KindIcon } from './icons'
import { Badge, Card, ErrorBox, Pill, Spinner, useAsync, useToast } from './ui'

const KIND_LABEL: Record<DraftTest['kind'], string> = {
  'happy-path': 'main path',
  negative: 'negative case',
  edge: 'edge case',
  flow: 'a sequence of steps',
}

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

/**
 * The zero-experience entry point: a few words in, a set of real test cases
 * out. Writing a full instruction by hand is still possible, but it is no
 * longer what the tool asks of you first.
 *
 * Two kinds of draft come back and the difference is worth showing. A DESIGNED
 * test was computed from a rule the application states about itself, so it is
 * repeatable and it can quote that rule. An AI-written one is a suggestion for
 * something no rule can express, such as what a successful checkout means.
 */
export default function QuickTest({ project, onCreated }: { project: Project; onCreated: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<'' | 'generate' | 'save'>('')
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<SuiteResult | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toast = useToast()
  // Suggestions describe THIS application, derived from what the explorer saw.
  const { data: map } = useAsync(() => api.get<AppMap>(`/api/projects/${project.id}/map`), [project.id])
  const suggestions = map?.topics ?? []

  async function generate(e?: FormEvent, opts: { wholeApp?: boolean; explore?: boolean } = {}) {
    e?.preventDefault()
    setBusy('generate')
    setErr(null)
    setResult(null)
    try {
      const r = await api.post<SuiteResult>(`/api/projects/${project.id}/testcases/generate`, {
        prompt: opts.wholeApp ? '' : prompt,
        explore: opts.explore ?? false,
      })
      setResult(r)
      // Pre-select everything that is not already covered.
      setChosen(new Set(r.drafts.map((d, i) => (d.duplicateOf ? -1 : i)).filter((i) => i >= 0)))
      if (r.drafts.length === 0) setErr('No tests came back. Try naming a feature, for example "the login", or explore the app first.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function save(run: boolean) {
    if (!result) return
    // Everything the designer worked out travels with the test: the rule it
    // checks, the form and field it targets, its design key. Dropping it here
    // would make the test unexplainable and uncountable later.
    const tests = [...chosen]
      .sort((a, b) => a - b)
      .map((i) => {
        const d = result.drafts[i]
        return {
          title: d.title,
          instruction: d.instruction,
          kind: d.kind,
          technique: d.technique,
          area: d.area,
          targetUrl: d.targetUrl,
          targetForm: d.targetForm,
          targetField: d.targetField,
          designKey: d.designKey,
          oracle: d.oracle,
          oracleText: d.oracleText,
          auth: d.auth,
          priority: d.priority,
          requirementKeys: d.requirementKeys,
        }
      })
    if (!tests.length) return
    setBusy('save')
    setErr(null)
    try {
      const saved = await api.post<{ created: unknown[]; skipped: string[] }>(`/api/projects/${project.id}/testcases/bulk`, { tests, run })
      const n = saved.created.length
      toast(
        `${n} test${n === 1 ? '' : 's'} added${run ? ' and running' : ''}${saved.skipped?.length ? ` · ${saved.skipped.length} already existed` : ''}`,
        'ok',
      )
      setResult(null)
      setPrompt('')
      onCreated()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const toggle = (i: number) =>
    setChosen((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  const designed = result?.drafts.filter((d) => d.source === 'designed').length ?? 0

  return (
    <Card orb="#E35C9A">
      <h3 className="text-[19px] font-bold text-ink">No test-writing needed</h3>
      <p className="mt-1 max-w-2xl text-sm text-ink2">
        TestPilot walks your application, reads its forms and the rules they state, then works out the tests a professional would write — including the boundary cases people
        forget. Review them and run.
      </p>

      <div className="mt-4">
        <button type="button" className="btn-primary" disabled={busy !== ''} onClick={() => generate(undefined, { wholeApp: true, explore: true })}>
          {busy === 'generate' && !prompt ? <Spinner label="Exploring your app…" /> : <IconSparkle size={16} />}
          {busy === 'generate' && !prompt ? '' : 'Explore my app and write tests'}
        </button>
      </div>

      <div className="my-4 flex items-center gap-3 text-xs text-ink2">
        <span className="h-px flex-1 bg-line" />
        or test one thing
        <span className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={generate} className="flex flex-wrap gap-2">
        <input
          className="input min-w-[16rem] flex-1"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. password rules"
          aria-label="What do you want to test?"
        />
        <button className="btn-secondary" disabled={busy !== '' || !prompt.trim()}>
          {busy === 'generate' && prompt ? <Spinner label="Writing…" /> : 'Write the tests'}
        </button>
      </form>

      {!result && suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink2">
          <span>Found in your app:</span>
          {suggestions.map((s) => (
            <button key={s} type="button" className="rounded-full bg-raise px-2.5 py-1 text-ink2 transition hover:text-ink" onClick={() => setPrompt(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {busy === 'generate' && result === null && <p className="mt-3 text-xs text-ink2">Walking the application and reading its forms — around 20 seconds the first time.</p>}

      <div className="mt-3">
        <ErrorBox error={err} />
      </div>

      {result && result.drafts.length > 0 && (
        <div className="mt-5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{result.message}</span>
            {result.crawled.length > 0 && <span className="text-xs text-ink2">· read {result.crawled.length} page(s) first</span>}
            <span className="flex-1" />
            <button type="button" className="btn-secondary btn-xs" onClick={() => setChosen(new Set(result.drafts.map((_, i) => i)))}>
              Select all
            </button>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setChosen(new Set())}>
              Clear
            </button>
          </div>

          {designed > 0 && (
            <p className="text-[12px] text-ink2">
              {designed} of these were <strong className="text-ink">designed</strong> from rules the application states about itself, so they are repeatable and each one quotes
              its rule. The rest were written by the AI for things no rule can express.
            </p>
          )}

          {result.notes?.map((n) => (
            <p key={n} className="rounded-ctl bg-raise px-3 py-2 text-[12px] text-ink2">
              {n}
            </p>
          ))}

          {result.drafts.map((d, i) => (
            <div key={i} className={`card-raise flex gap-3 ${d.duplicateOf ? 'opacity-60' : ''}`}>
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[#5C5FC8]" checked={chosen.has(i)} onChange={() => toggle(i)} aria-label={`Select ${d.title}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ink2">
                    <KindIcon kind={d.kind} />
                  </span>
                  <span className="font-semibold text-ink">{d.title}</span>
                  <Badge status={d.source === 'designed' ? 'designed' : 'suggested'}>{d.source === 'designed' ? 'designed' : 'written by AI'}</Badge>
                  <Badge status={d.kind === 'happy-path' ? 'passed' : d.kind === 'negative' ? 'partial' : 'open'}>{KIND_LABEL[d.kind]}</Badge>
                  {d.duplicateOf && <Badge status="rejected">already covered by &ldquo;{d.duplicateOf}&rdquo;</Badge>}
                  {d.warnings.length > 0 && <Badge status="flagged">needs a clearer outcome</Badge>}
                </div>

                {d.technique && TECHNIQUE_LABEL[d.technique] && <p className="mt-1 text-[12px] text-ink2">{TECHNIQUE_LABEL[d.technique]}</p>}
                {d.oracleText && (
                  <p className="mt-1 text-[12px] text-ink2">
                    The page states: <span className="text-ink">{d.oracleText}</span>
                  </p>
                )}
                {!d.oracleText && d.why && <p className="mt-1 text-[12px] text-ink2">{d.why}</p>}

                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-accent hover:underline"
                    onClick={() => setExpanded((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))}
                  >
                    {expanded.has(i) ? 'Hide' : 'Show'} the test
                  </button>
                  {d.targetUrl && <Pill tone="quiet">{d.targetUrl.replace(/^https?:\/\/[^/]+/, '') || '/'}</Pill>}
                  {d.auth === 'signed-in' && <Pill tone="quiet">runs signed in</Pill>}
                </div>
                {expanded.has(i) && <p className="mt-2 whitespace-pre-wrap rounded-ctl bg-card p-3 font-mono text-xs text-ink">{d.instruction}</p>}
                {d.warnings.length > 0 && expanded.has(i) && (
                  <ul className="mt-1 list-inside list-disc text-[12px] text-data-amber">
                    {d.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn-primary" disabled={busy !== '' || chosen.size === 0} onClick={() => save(true)}>
              <IconPlay size={15} />
              {busy === 'save' ? 'Saving…' : `Add and run ${chosen.size} test${chosen.size === 1 ? '' : 's'}`}
            </button>
            <button className="btn-secondary" disabled={busy !== '' || chosen.size === 0} onClick={() => save(false)}>
              Add without running
            </button>
            <button className="btn-ghost" disabled={busy !== ''} onClick={() => setResult(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}
