import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Project } from '../api'
import { Empty, ErrorBox, Modal, Section, Skeleton, fmtAgo, useAsync, useToast } from '../components/ui'

const DEMO = {
  name: 'ShopMax',
  baseUrl: 'http://localhost:4100',
  resetUrl: 'http://localhost:4100/__reset',
  testUser: 'test@example.com',
  testPassword: 'Password123!',
  description: 'Demo e-commerce app: catalogue with search/filter/sort/pagination, cart, coupons, 3-step checkout, registration and an admin area.',
}
const BLANK = { name: '', baseUrl: '', resetUrl: '', testUser: '', testPassword: '', description: '' }

export default function ProjectsPage() {
  const { data, error, loading, reload } = useAsync(() => api.get<Project[]>('/api/projects'), [])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toast = useToast()

  async function create(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      const p = await api.post<Project>('/api/projects', {
        ...form,
        resetUrl: form.resetUrl || null,
        testUser: form.testUser || null,
        testPassword: form.testPassword || null,
      })
      toast(`Project "${p.name}" created.`, 'ok')
      setOpen(false)
      setForm(BLANK)
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <Section
        title="Projects"
        subtitle="Each project is one web application under test: its requirements checklist, test cases, runs, coverage and bug reports."
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            + New project
          </button>
        }
      >
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data && <Skeleton rows={2} />}
        {data && data.length === 0 && (
          <Empty
            title="No projects yet"
            action={
              <button
                className="btn-primary"
                onClick={() => {
                  setForm(DEMO)
                  setOpen(true)
                }}
              >
                Create the ShopMax demo project
              </button>
            }
          >
            Point TestPilot at a web application in a test environment, write a test in plain English, and it will drive a real browser to run it.
          </Empty>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card transition hover:border-accent hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold">{p.name}</div>
                  <div className="truncate text-xs text-ink2">{p.baseUrl}</div>
                </div>
                {p.hasSavedLogin && <span title="A login session is saved for this project">🔑</span>}
              </div>
              {p.description && <p className="mt-2 line-clamp-2 text-xs text-ink2">{p.description}</p>}
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink2">
                <span>
                  <b>{p._count?.requirements ?? 0}</b> requirements
                </span>
                <span>
                  <b>{p._count?.testCases ?? 0}</b> tests
                </span>
                <span className={p._count?.bugReports ? 'font-semibold text-bad' : ''}>
                  <b>{p._count?.bugReports ?? 0}</b> bugs
                </span>
              </div>
              <div className="mt-1 text-[11px] text-ink2">created {fmtAgo(p.createdAt)}</div>
            </Link>
          ))}
        </div>
      </Section>

      <Modal open={open} onClose={() => setOpen(false)} title="New project">
        <form onSubmit={create} className="space-y-3">
          <div className="flex justify-end">
            <button type="button" className="btn-secondary btn-xs" onClick={() => setForm(DEMO)}>
              Fill in the ShopMax demo
            </button>
          </div>
          <div>
            <label className="label" htmlFor="np-name">
              Name
            </label>
            <input id="np-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="np-url">
              Base URL — a test environment, never production
            </label>
            <input id="np-url" className="input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://localhost:4100" required />
          </div>
          <div>
            <label className="label" htmlFor="np-reset">
              Reset URL (optional) — POSTed before every run to clear test data
            </label>
            <input id="np-reset" className="input" value={form.resetUrl} onChange={(e) => setForm({ ...form, resetUrl: e.target.value })} placeholder="http://localhost:4100/__reset" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label" htmlFor="np-user">
                Test account
              </label>
              <input id="np-user" className="input" value={form.testUser} onChange={(e) => setForm({ ...form, testUser: e.target.value })} placeholder="{{test_user}}" />
            </div>
            <div>
              <label className="label" htmlFor="np-pass">
                Password
              </label>
              <input id="np-pass" className="input" type="password" value={form.testPassword} onChange={(e) => setForm({ ...form, testPassword: e.target.value })} placeholder="{{test_password}}" />
            </div>
          </div>
          <p className="text-[11px] text-ink2">The password is never sent to the AI — tests type a placeholder and the browser substitutes it.</p>
          <div>
            <label className="label" htmlFor="np-desc">
              Description (helps the AI draft requirements)
            </label>
            <textarea id="np-desc" className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <ErrorBox error={err} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
