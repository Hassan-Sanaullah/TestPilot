import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type AuthStatus, type Project } from '../../api'
import { Badge, Card, ErrorBox, Section, Toggle, fmtAgo, useToast } from '../../components/ui'

export default function SettingsTab({ project, onChange }: { project: Project; onChange: () => void }) {
  const nav = useNavigate()
  const toast = useToast()
  const [f, setF] = useState({
    name: project.name,
    baseUrl: project.baseUrl,
    description: project.description,
    resetUrl: project.resetUrl ?? '',
    testUser: project.testUser ?? '',
    testPassword: '',
    llmCallBudget: project.llmCallBudget,
    retryOnFail: project.retryOnFail,
    allowedDomains: project.allowedDomains.join(', '),
    viewportWidth: project.viewportWidth,
    viewportHeight: project.viewportHeight,
    maxSteps: project.maxSteps,
    dialogAction: project.dialogAction,
    parallel: project.parallel !== false,
  })
  // Test data is edited as rows, because a JSON textarea is a trap: one missing
  // comma and the whole thing is rejected.
  const [data, setData] = useState<{ key: string; value: string }[]>(() => Object.entries(project.testData ?? {}).map(([key, value]) => ({ key, value })))
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const body: Record<string, unknown> = {
        ...f,
        resetUrl: f.resetUrl || null,
        testUser: f.testUser || null,
        allowedDomains: f.allowedDomains.split(',').map((s) => s.trim()).filter(Boolean),
        llmCallBudget: Number(f.llmCallBudget),
        viewportWidth: Number(f.viewportWidth),
        viewportHeight: Number(f.viewportHeight),
        maxSteps: Number(f.maxSteps),
        testData: Object.fromEntries(data.filter((d) => d.key.trim()).map((d) => [d.key.trim(), d.value])),
      }
      // only send the password when the user actually typed a new one
      if (!f.testPassword) delete body.testPassword
      await api.put(`/api/projects/${project.id}`, body)
      setSaved(true)
      toast('Settings saved.', 'ok')
      onChange()
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Project settings">
        <form onSubmit={save} className="card max-w-3xl space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Base URL</label>
              <input className="input" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Reset URL — POSTed before every run to clear test data</label>
              <input className="input" value={f.resetUrl} onChange={(e) => setF({ ...f, resetUrl: e.target.value })} />
            </div>
            <div>
              <label className="label">Test account ({'{{test_user}}'})</label>
              <input className="input" value={f.testUser} onChange={(e) => setF({ ...f, testUser: e.target.value })} />
            </div>
            <div>
              <label className="label">Password {project.hasPassword && <span className="font-normal normal-case">— stored, leave blank to keep</span>}</label>
              <input className="input" type="password" value={f.testPassword} onChange={(e) => setF({ ...f, testPassword: e.target.value })} placeholder={project.hasPassword ? '••••••••' : ''} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description</label>
              <textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </div>
          </div>

          <hr className="border-line" />
          <p className="text-sm font-semibold">Browser &amp; execution</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label">Additional allowed domains — comma separated</label>
              <input className="input" value={f.allowedDomains} onChange={(e) => setF({ ...f, allowedDomains: e.target.value })} placeholder="accounts.google.com, checkout.stripe.com" />
              <p className="mt-1 text-[11px] text-ink2">
                Tests may always visit the base URL's own domain and its subdomains. Add anything else they legitimately need, such as an SSO or payment sandbox.
              </p>
            </div>
            <div>
              <label className="label">Viewport</label>
              <div className="flex items-center gap-2">
                <input className="input" type="number" value={f.viewportWidth} onChange={(e) => setF({ ...f, viewportWidth: Number(e.target.value) })} />
                <span className="text-ink2">×</span>
                <input className="input" type="number" value={f.viewportHeight} onChange={(e) => setF({ ...f, viewportHeight: Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <label className="label">Max actions per run</label>
              <input className="input" type="number" min={3} max={120} value={f.maxSteps} onChange={(e) => setF({ ...f, maxSteps: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">LLM call budget per run</label>
              <input className="input" type="number" min={5} max={200} value={f.llmCallBudget} onChange={(e) => setF({ ...f, llmCallBudget: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">Browser dialogs (alert / confirm)</label>
              <select className="input" value={f.dialogAction} onChange={(e) => setF({ ...f, dialogAction: e.target.value as 'accept' | 'dismiss' })}>
                <option value="accept">Accept automatically</option>
                <option value="dismiss">Dismiss automatically</option>
              </select>
            </div>
            <div className="sm:col-span-2 space-y-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={f.retryOnFail} onChange={(e) => setF({ ...f, retryOnFail: e.target.checked })} />
                Re-run a failed test once before filing a bug (so a flaky failure is never reported as a defect)
              </label>

              <div className="flex items-start gap-3">
                <Toggle checked={f.parallel} onChange={(v) => setF({ ...f, parallel: v })} label="Run this project's tests at the same time" />
                <span className="text-sm text-ink">
                  Run tests at the same time
                  <span className="mt-0.5 block text-[12px] text-ink2">
                    Much faster. Turn it off if the tests share data and trip over each other — a project with a reset hook always runs one test at a time regardless.
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="hr-soft" />

          <div>
            <p className="label">Test data</p>
            <p className="-mt-0.5 mb-2 text-[12px] text-ink2">
              Values this application will actually accept — a coupon code, a product name, a postcode. A test uses them by name, for example{' '}
              <code className="font-mono">{'{{data.coupon}}'}</code>. Never put a secret here: the only secret is the test password above, which is typed in the browser and never
              shown to the model.
            </p>
            <div className="space-y-2">
              {data.map((row, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <input
                    className="input max-w-[12rem] flex-1"
                    placeholder="coupon"
                    value={row.key}
                    onChange={(e) => setData(data.map((d, j) => (j === i ? { ...d, key: e.target.value } : d)))}
                    aria-label={`Name of value ${i + 1}`}
                  />
                  <input
                    className="input min-w-[10rem] flex-[2]"
                    placeholder="SAVE10"
                    value={row.value}
                    onChange={(e) => setData(data.map((d, j) => (j === i ? { ...d, value: e.target.value } : d)))}
                    aria-label={`Value ${i + 1}`}
                  />
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setData(data.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="btn-secondary btn-sm" onClick={() => setData([...data, { key: '', value: '' }])}>
                Add a value
              </button>
            </div>
          </div>

          <ErrorBox error={err} />
          <div className="flex items-center gap-2">
            <button className="btn-primary">Save settings</button>
            {saved && <span className="text-sm text-data-green">Saved.</span>}
          </div>
        </form>
      </Section>

      {project.hasAutoSession && (
        <Section title="Session captured while exploring">
          <Card>
            <p className="text-sm text-ink">
              TestPilot signed in with the test account while exploring and kept the session{project.autoSessionAt ? `, ${fmtAgo(project.autoSessionAt)}` : ''}. Tests that need
              to be signed in start from it, instead of spending their first steps logging in.
            </p>
            <p className="mt-1.5 text-[12px] text-ink2">
              A session you record by hand below always wins over this one. If a run finds the session has expired, it signs in once more and saves a fresh one.
            </p>
          </Card>
        </Section>
      )}

      <LoginRecorder project={project} onChange={onChange} />

      <Section title="Danger zone">
        <div className="card flex max-w-3xl items-center justify-between gap-4">
          <div className="text-sm">
            <div className="font-semibold">Delete this project</div>
            <div className="text-ink2">Removes its requirements, tests, runs, evidence, coverage, gaps and bug reports. This cannot be undone.</div>
          </div>
          <button
            className="btn-danger shrink-0"
            onClick={async () => {
              if (!confirm(`Delete project "${project.name}" and all of its data?`)) return
              await api.del(`/api/projects/${project.id}`)
              nav('/')
            }}
          >
            Delete project
          </button>
        </div>
      </Section>
    </div>
  )
}

/**
 * Sites behind a login (SSO, MFA, captcha) cannot be scripted reliably. Instead
 * the user signs in once by hand in a real browser window and the session is
 * saved and replayed by every run.
 */
function LoginRecorder({ project, onChange }: { project: Project; onChange: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toast = useToast()

  const refresh = () => api.get<AuthStatus>(`/api/projects/${project.id}/auth`).then(setStatus, () => undefined)
  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      if (msg) toast(msg, 'ok')
      await refresh()
      onChange()
    } catch (e) {
      setErr((e as Error).message)
      toast((e as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Saved login session" subtitle="For applications behind authentication. Sign in once by hand — including SSO or two-factor — and every run reuses that session.">
      <div className="card max-w-3xl space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {status?.saved ? <Badge status="ok">session saved</Badge> : <Badge status="unknown">no session saved</Badge>}
          {status?.active && <Badge status="running">browser open — sign in, then save</Badge>}
        </div>

        {status?.active ? (
          <>
            <p className="text-sm text-ink2">
              A browser window is open at <code className="text-xs">{status.url}</code>. Log in there, then come back and save the session.
            </p>
            <div className="flex gap-2">
              <button className="btn-primary" disabled={busy} onClick={() => run(() => api.post(`/api/projects/${project.id}/auth/save`), 'Login session saved.')}>
                ✓ I have logged in — save the session
              </button>
              <button className="btn-secondary" disabled={busy} onClick={() => run(() => api.post(`/api/projects/${project.id}/auth/cancel`))}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => run(() => api.post(`/api/projects/${project.id}/auth/start`), 'Browser opened — sign in there.')}>
              {status?.saved ? 'Record a new login session' : 'Record a login session'}
            </button>
            {status?.saved && (
              <button className="btn-danger" disabled={busy} onClick={() => confirm('Delete the saved login session?') && run(() => api.del(`/api/projects/${project.id}/auth`), 'Saved session deleted.')}>
                Delete saved session
              </button>
            )}
          </div>
        )}
        <ErrorBox error={err} />
      </div>
    </Section>
  )
}
