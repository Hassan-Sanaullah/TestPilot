import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { IconAlert, IconCheck, IconClock, IconCross, IconSearch } from './icons'

// ---------------------------------------------------------------- badges
/**
 * Status colours.
 *
 * Every status also carries a word, and the ones that matter carry a shape too
 * (see `StatusBadge`). Colour alone excludes anyone who cannot distinguish red
 * from green — about one man in twelve — and these are exactly the two colours
 * a test result swings between.
 */
const BADGE: Record<string, string> = {
  passed: 'bg-data-green/15 text-data-green',
  covered: 'bg-data-green/15 text-data-green',
  feasible: 'bg-data-green/15 text-data-green',
  ok: 'bg-data-green/15 text-data-green',
  converted: 'bg-data-green/15 text-data-green',
  accepted: 'bg-data-green/15 text-data-green',
  failed: 'bg-bad/15 text-bad',
  violated: 'bg-bad/15 text-bad',
  uncovered: 'bg-bad/15 text-bad',
  infeasible: 'bg-bad/15 text-bad',
  high: 'bg-bad/15 text-bad',
  critical: 'bg-bad text-white',
  error: 'bg-data-amber/15 text-data-amber',
  flagged: 'bg-data-amber/15 text-data-amber',
  partial: 'bg-data-amber/15 text-data-amber',
  medium: 'bg-data-amber/15 text-data-amber',
  flaky: 'bg-data-amber/15 text-data-amber',
  quarantined: 'bg-data-amber/15 text-data-amber',
  running: 'bg-accent/15 text-accent',
  suggested: 'bg-accent/15 text-accent',
  open: 'bg-accent/15 text-accent',
  gap: 'bg-data-pink/15 text-data-pink',
  dom: 'bg-data-pink/15 text-data-pink',
  rule: 'bg-data-blue/15 text-data-blue',
  designed: 'bg-data-blue/15 text-data-blue',
  rejected: 'bg-raise text-ink2 line-through',
  queued: 'bg-raise text-ink2',
}
const BADGE_DEFAULT = 'bg-raise text-ink2'

export function Badge({ status, children, title }: { status: string; children?: ReactNode; title?: string }) {
  return (
    <span className={`badge ${BADGE[status] ?? BADGE_DEFAULT}`} title={title}>
      {children ?? status}
    </span>
  )
}

/**
 * The result of a run, said in words with an icon.
 *
 * It also makes the distinction the whole product rests on visible: a FAILURE
 * is the application misbehaving, while an error with `failureKind: 'tool'` is
 * TestPilot failing to drive the browser. Showing both as "failed" would
 * invite the user to go looking for a defect that is not there.
 */
export function StatusBadge({
  status,
  failureKind,
  expectation,
  quarantined,
  flaky,
}: {
  status: string
  failureKind?: 'app' | 'tool' | null
  expectation?: string | null
  quarantined?: boolean
  flaky?: boolean
}) {
  if (quarantined) {
    return (
      <span className="badge bg-data-amber/15 text-data-amber" title="This test has proven unreliable, so it does not decide the result. It still runs.">
        <IconAlert size={13} /> Quarantined
      </span>
    )
  }
  if (status === 'passed') {
    const fixed = expectation === 'known-failing'
    return (
      <span className="badge bg-data-green/15 text-data-green" title={fixed ? 'The recorded failure no longer happens — this looks fixed.' : undefined}>
        <IconCheck size={13} /> {fixed ? 'Fixed' : 'Passed'}
        {flaky ? ' (flaky)' : ''}
      </span>
    )
  }
  if (status === 'failed') {
    if (failureKind === 'tool') {
      return (
        <span className="badge bg-data-amber/15 text-data-amber" title="TestPilot could not drive the browser. This says nothing about the application.">
          <IconAlert size={13} /> Could not run
        </span>
      )
    }
    const known = expectation === 'known-failing'
    return (
      <span className="badge bg-bad/15 text-bad" title={known ? 'This test records a known defect on purpose. It will pass when the defect is fixed.' : undefined}>
        <IconCross size={13} /> {known ? 'Known failure' : 'Failed'}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="badge bg-data-amber/15 text-data-amber" title="TestPilot could not complete the run. This says nothing about the application.">
        <IconAlert size={13} /> Could not run
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="badge bg-accent/15 text-accent">
        <span className="h-2 w-2 animate-pulsedot rounded-full bg-accent" /> Running
      </span>
    )
  }
  if (status === 'queued') {
    return (
      <span className="badge bg-raise text-ink2">
        <IconClock size={13} /> Queued
      </span>
    )
  }
  return <Badge status={status} />
}

/** A round pass/fail mark for a list, readable without colour. */
export function CircleBadge({ status, failureKind, size = 34 }: { status: string; failureKind?: 'app' | 'tool' | null; size?: number }) {
  const look =
    status === 'passed'
      ? { bg: 'bg-data-green/15', fg: 'text-data-green', icon: <IconCheck size={size * 0.5} /> }
      : status === 'failed' && failureKind !== 'tool'
        ? { bg: 'bg-bad/15', fg: 'text-bad', icon: <IconCross size={size * 0.5} /> }
        : status === 'running'
          ? { bg: 'bg-accent/15', fg: 'text-accent', icon: <span className="h-2 w-2 animate-pulsedot rounded-full bg-accent" /> }
          : status === 'queued'
            ? { bg: 'bg-raise', fg: 'text-ink2', icon: <IconClock size={size * 0.5} /> }
            : { bg: 'bg-data-amber/15', fg: 'text-data-amber', icon: <IconAlert size={size * 0.5} /> }
  return (
    <span className={`grid shrink-0 place-items-center rounded-full ${look.bg} ${look.fg}`} style={{ width: size, height: size }} aria-hidden="true">
      {look.icon}
    </span>
  )
}

// ---------------------------------------------------------------- primitives
// ---------------------------------------------------------------- primitives
export function Empty({ title, children, action }: { title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line p-10 text-center">
      {title && <p className="font-semibold text-ink">{title}</p>}
      <div className="mx-auto mt-1 max-w-md text-sm text-ink2">{children}</div>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/** A panel. Named so pages do not have to remember the class. */
export function Card({ children, className = '', orb }: { children: ReactNode; className?: string; orb?: string }) {
  return (
    <div className={`card relative overflow-hidden ${className}`}>
      {orb && <span className="orb -right-10 -top-12 h-40 w-40" style={{ background: orb }} />}
      <div className="relative">{children}</div>
    </div>
  )
}

export function Pill({ children, tone = 'quiet', title }: { children: ReactNode; tone?: 'quiet' | 'accent' | 'glass'; title?: string }) {
  const cls = tone === 'accent' ? 'pill bg-accent text-white' : tone === 'glass' ? 'pill glass text-ink' : 'pill-quiet'
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  )
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className="btn-ghost btn-sm" onClick={onClick} aria-label={label} title={label} disabled={disabled}>
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-line'}`}
    >
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-6' : 'left-1'}`} />
    </button>
  )
}

/** Pill tabs, for switching a panel's contents. */
export function Tabs<T extends string>({ options, value, onChange }: { options: readonly { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex gap-1 rounded-full p-1" style={{ background: 'var(--raise-grad)' }}>
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-current={value === o.key ? 'true' : undefined}
          className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${value === o.key ? 'bg-accent text-white' : 'text-ink2 hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink2">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </span>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-inner bg-raise" />
      ))}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div className="flex items-start gap-3 rounded-ctl border border-bad-soft bg-bad/10 px-3.5 py-2.5 text-sm text-bad">
      <IconAlert size={16} />
      <span className="flex-1">{error}</span>
      {onRetry && (
        <button className="btn-xs btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function Section({ title, subtitle, actions, children }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 max-w-3xl text-sm text-ink2">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const toneCls = tone === 'good' ? 'text-data-green' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-data-amber' : 'text-ink'
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`text-[26px] font-bold leading-tight ${toneCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink2">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- modal
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'rgba(8,10,16,.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className={`card animate-risein w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} my-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button className="btn-ghost btn-xs" onClick={onClose} aria-label="Close">
            <IconCross size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Lightbox({ src, caption, onClose, onPrev, onNext }: { src: string | null; caption?: ReactNode; onClose: () => void; onPrev?: () => void; onNext?: () => void }) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrev?.()
      if (e.key === 'ArrowRight') onNext?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, onClose, onPrev, onNext])
  if (!src) return null
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="mb-2 flex items-center gap-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
        {onPrev && (
          <button className="rounded bg-white/15 px-3 py-1 hover:bg-white/25" onClick={onPrev}>
            ← Previous
          </button>
        )}
        <span>{caption}</span>
        {onNext && (
          <button className="rounded bg-white/15 px-3 py-1 hover:bg-white/25" onClick={onNext}>
            Next →
          </button>
        )}
      </div>
      <img src={src} alt="step screenshot" className="max-h-[85vh] max-w-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; text: string; tone: 'ok' | 'err' | 'info' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, text, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`rounded-lg px-4 py-2.5 text-sm shadow-lg ${
              t.tone === 'ok' ? 'bg-data-green text-white' : t.tone === 'err' ? 'bg-bad text-white' : 'bg-accent text-white'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---------------------------------------------------------------- filters
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink2">
        <IconSearch size={16} />
      </span>
      <input className="input pl-7" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'} />
      {value && (
        <button className="absolute right-3 top-1/2 -translate-y-1/2 text-ink2 hover:text-ink" onClick={() => onChange('')} aria-label="Clear search">
          ✕
        </button>
      )}
    </div>
  )
}

export function FilterChips<T extends string>({ options, value, onChange, counts }: { options: readonly T[]; value: T | 'all'; onChange: (v: T | 'all') => void; counts?: Record<string, number> }) {
  const all = ['all', ...options] as (T | 'all')[]
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize transition ${
            value === o ? 'bg-accent text-white' : 'bg-raise text-ink2 hover:text-ink'
          }`}
        >
          {o}
          {counts && counts[o] !== undefined ? ` (${counts[o]})` : ''}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- formatting
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function fmtAgo(s: string | null | undefined): string {
  if (!s) return 'never'
  const ms = Date.now() - new Date(s).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export function duration(a: string | null, b: string | null): string {
  if (!a) return '—'
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

// ---------------------------------------------------------------- hooks
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let alive = true
    setLoading(true)
    fnRef.current().then(
      (d) => {
        if (!alive) return
        setData(d)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (!alive) return
        setError((e as Error).message)
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) }
}

/** Subscribe to the global run event stream; calls cb on status changes. */
export function useRunEvents(cb: () => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onmessage = () => ref.current()
    return () => es.close()
  }, [])
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('tp.theme')
    if (saved) return saved === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('tp.theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, useCallback(() => setDark((d) => !d), [])]
}

/** Client-side sort state for a table. */
export function useSort<T>(rows: T[], initial: keyof T | null, compare?: Partial<Record<keyof T, (a: T, b: T) => number>>) {
  const [key, setKey] = useState<keyof T | null>(initial)
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const sorted = useMemo(() => {
    if (!key) return rows
    const cmp = compare?.[key] ?? ((a: T, b: T) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }))
    return [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : -cmp(a, b)))
  }, [rows, key, dir, compare])
  const toggle = (k: keyof T) => {
    if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setKey(k)
      setDir('asc')
    }
  }
  return { sorted, sortKey: key, sortDir: dir, toggle }
}

export function SortHeader<T>({ label, k, state }: { label: string; k: keyof T; state: ReturnType<typeof useSort<T>> }) {
  const active = state.sortKey === k
  return (
    <th>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => state.toggle(k)}>
        {label}
        <span className={active ? '' : 'opacity-20'}>{active && state.sortDir === 'asc' ? '▲' : '▼'}</span>
      </button>
    </th>
  )
}
