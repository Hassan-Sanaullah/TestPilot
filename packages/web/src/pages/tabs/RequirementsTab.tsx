import { useState } from 'react'
import { api, type Project, type Requirement } from '../../api'
import { Badge, Empty, ErrorBox, Modal, Section, Spinner, useToast } from '../../components/ui'

export default function RequirementsTab({ project, onChange }: { project: Project; onChange: () => void }) {
  const reqs = project.requirements ?? []
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<Requirement | null>(null)
  const toast = useToast()

  async function run(label: string, fn: () => Promise<unknown>, msg?: string) {
    setBusy(label)
    setErr(null)
    try {
      await fn()
      if (msg) toast(msg, 'ok')
      onChange()
    } catch (e) {
      setErr((e as Error).message)
      toast((e as Error).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  const add = () => {
    const items = text
      .split('\n')
      .map((l) => l.replace(/^\s*R?\d+\s*[.:)-]\s*/i, '').trim())
      .filter((l) => l.length >= 3)
    if (!items.length) return
    run('add', () => api.post(`/api/projects/${project.id}/requirements`, { items }), `${items.length} requirement(s) added.`).then(() => {
      setText('')
      setOpen(false)
    })
  }

  return (
    <Section
      title="Behaviour requirements"
      subtitle="The checklist the coverage checker measures your tests against. Write them yourself, paste a list, or let TestPilot draft them from the application's pages — using the DOM only, never your source code."
      actions={
        <>
          <button className="btn-secondary" disabled={!!busy} onClick={() => run('propose', () => api.post(`/api/projects/${project.id}/requirements/propose`), 'Requirements drafted from the pages.')}>
            {busy === 'propose' ? <Spinner label="Crawling pages…" /> : '✨ Propose from the pages'}
          </button>
          <button className="btn-primary" onClick={() => setOpen(true)}>
            + Add requirements
          </button>
        </>
      }
    >
      <ErrorBox error={err} />
      {reqs.length === 0 && (
        <Empty
          title="No requirements yet"
          action={
            <button className="btn-secondary" disabled={!!busy} onClick={() => run('propose', () => api.post(`/api/projects/${project.id}/requirements/propose`), 'Requirements drafted.')}>
              ✨ Propose them from the pages
            </button>
          }
        >
          A requirement is one sentence describing a behaviour users rely on, for example “Registration rejects an email that is already registered”.
        </Empty>
      )}

      {reqs.length > 0 && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-line bg-white dark:divide-slate-800 dark:bg-raise">
          {reqs.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2 text-sm">
              <code className="mt-0.5 w-9 shrink-0 text-xs font-bold text-ink2">{r.key}</code>
              {editing?.id === r.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    run('edit', () => api.put(`/api/requirements/${r.id}`, { text: editing.text }), 'Requirement updated.').then(() => setEditing(null))
                  }}
                >
                  <input className="input" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} autoFocus />
                  <button className="btn-primary btn-xs">Save</button>
                  <button type="button" className="btn-secondary btn-xs" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="flex-1">{r.text}</span>
                  <Badge status={r.source} title={r.source === 'dom' ? 'Drafted by TestPilot from the page structure' : 'Written by you'} />
                  <button className="text-xs text-ink2 hover:text-accent dark:hover:text-indigo-400" onClick={() => setEditing(r)}>
                    edit
                  </button>
                  <button className="text-xs text-ink2 hover:text-bad dark:hover:text-red-400" onClick={() => run('del', () => api.del(`/api/requirements/${r.id}`), 'Requirement deleted.')}>
                    delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Add requirements" wide>
        <div className="space-y-3">
          <p className="text-sm text-ink2">One requirement per line. Numbering like “R1.” or “1)” is stripped automatically.</p>
          <textarea
            className="input font-mono text-xs"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Users can register with a valid email and a password of at least 8 characters\nRegistration rejects an email that is already registered\nApplying coupon SAVE10 reduces the subtotal by 10%'}
          />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!!busy || !text.trim()} onClick={add}>
              {busy === 'add' ? 'Adding…' : 'Add to checklist'}
            </button>
          </div>
        </div>
      </Modal>
    </Section>
  )
}
