/**
 * Charts, written by hand in SVG.
 *
 * No charting library: the three shapes this product needs are a line, a ring
 * and a bar, and a library would add a few hundred kilobytes, its own theming
 * system and its own accessibility gaps to draw them. Written directly, each
 * one inherits the design tokens, works in both themes, and can carry a real
 * table fallback for a screen reader.
 *
 * Every chart here also states its numbers in text, because a chart nobody can
 * read is decoration.
 */
import { useMemo, useState } from 'react'

// ---------------------------------------------------------------- line chart

export interface LinePoint {
  label: string
  value: number
  /** optional breakdown shown in the tooltip */
  detail?: string
}

/**
 * A smooth line through the points, as a Catmull-Rom spline converted to cubic
 * Béziers — the usual "smooth" curve, which passes exactly through every data
 * point instead of near it. A curve that misses its own data is a lie.
 */
function smoothPath(points: { x: number; y: number }[], tension = 0.5): string {
  if (points.length === 0) return ''
  if (points.length < 3) return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
  const d: string[] = [`M${points[0].x} ${points[0].y}`]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension
    d.push(`C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`)
  }
  return d.join(' ')
}

export function LineChart({
  points,
  height = 150,
  label = 'Runs over time',
}: {
  points: LinePoint[]
  height?: number
  label?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 100 // a viewBox in percent, so the chart scales with its container
  const H = 100
  const pad = { top: 8, bottom: 8, left: 2, right: 2 }

  const geom = useMemo(() => {
    if (points.length === 0) return null
    const max = Math.max(1, ...points.map((p) => p.value))
    const span = points.length > 1 ? points.length - 1 : 1
    const xy = points.map((p, i) => ({
      x: pad.left + (i / span) * (W - pad.left - pad.right),
      y: pad.top + (1 - p.value / max) * (H - pad.top - pad.bottom),
    }))
    return { max, xy, line: smoothPath(xy), area: `${smoothPath(xy)} L${xy[xy.length - 1].x} ${H} L${xy[0].x} ${H} Z` }
  }, [points])

  if (!geom) {
    return <p className="py-6 text-center text-sm text-ink2">No runs yet.</p>
  }

  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0)
  const shown = hover ?? peak

  return (
    <figure className="relative m-0">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label={label}>
        <defs>
          <linearGradient id="tp-line-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5C5FC8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#5C5FC8" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geom.area} fill="url(#tp-line-fill)" />
        {/* non-scaling-stroke keeps the line 2.4px however the box is stretched */}
        <path d={geom.line} fill="none" stroke="#5C5FC8" strokeWidth={2.4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {geom.xy.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === shown ? 3.2 : 0}
            fill={i === shown ? '#D97706' : 'transparent'}
            stroke="rgb(var(--card))"
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* One wide invisible band per point: a 2px line is impossible to hit. */}
        {geom.xy.map((p, i) => (
          <rect
            key={`hit-${i}`}
            x={p.x - (W / Math.max(1, points.length)) / 2}
            y={0}
            width={W / Math.max(1, points.length)}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {points[shown] && (
        <div className="glass pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 px-3 py-1.5 text-center text-xs">
          <span className="font-semibold text-ink">{points[shown].label}</span>
          <span className="ml-2 text-ink2">{points[shown].detail ?? `${points[shown].value}`}</span>
        </div>
      )}

      <div className="mt-2 flex justify-between text-[11px] text-ink2">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </figure>
  )
}

// ---------------------------------------------------------------- donut

export interface Segment {
  label: string
  value: number
  color: string
}

export function Donut({
  segments,
  centre,
  caption,
  size = 180,
}: {
  segments: Segment[]
  centre?: { value: string; label?: string }
  caption?: string
  size?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const total = segments.reduce((a, s) => a + s.value, 0)

  if (total === 0) {
    return <p className="py-6 text-center text-sm text-ink2">{caption ?? 'Nothing to show yet.'}</p>
  }

  const stroke = 20
  const r = 50 - stroke / 2
  const circumference = 2 * Math.PI * r
  // A 2px visual gap between segments, expressed in path length.
  const gap = total > 1 ? 2 : 0
  let offset = 0

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={caption ?? 'Breakdown'}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} opacity={0.5} />
        {segments.map((s, i) => {
          const len = (s.value / total) * circumference
          const dash = Math.max(0, len - gap)
          const el = (
            <circle
              key={s.label}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === i ? stroke + 3 : stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ transition: 'stroke-width .15s' }}
            />
          )
          offset += len
          return el
        })}
        {centre && (
          <>
            <text x="50" y={centre.label ? 48 : 54} textAnchor="middle" className="fill-ink" style={{ fontSize: 19, fontWeight: 700 }}>
              {centre.value}
            </text>
            {centre.label && (
              <text x="50" y="61" textAnchor="middle" className="fill-ink2" style={{ fontSize: 8 }}>
                {centre.label}
              </text>
            )}
          </>
        )}
      </svg>

      <ul className="min-w-[160px] flex-1 space-y-1.5">
        {segments.map((s, i) => (
          <li
            key={s.label}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1 text-sm transition ${hover === i ? 'bg-raise' : ''}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
            <span className="flex-1 truncate text-ink2">{s.label}</span>
            <span className="font-semibold text-ink">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- bars

export function TrendBars({ data, height = 80 }: { data: { date: string; passed: number; failed: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.passed + d.failed))
  return (
    <div className="flex items-end gap-1" style={{ height }} role="img" aria-label="Passed and failed runs per day">
      {data.map((d) => {
        const total = d.passed + d.failed
        const h = total === 0 ? 2 : Math.round((total / max) * height)
        const passShare = total === 0 ? 0 : d.passed / total
        return (
          <div
            key={d.date}
            className="flex-1 overflow-hidden rounded-t-md bg-line"
            style={{ height: h }}
            title={`${d.date}: ${d.passed} passed, ${d.failed} failed`}
          >
            <div style={{ height: `${(1 - passShare) * 100}%`, background: '#D1476A' }} />
            <div style={{ height: `${passShare * 100}%`, background: '#0E9C63' }} />
          </div>
        )
      })}
    </div>
  )
}

export function MiniBar({ value, total, color = '#0E9C63' }: { value: number; total: number; color?: string }) {
  const pct = total === 0 ? 0 : Math.round((100 * value) / total)
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-line" role="img" aria-label={`${value} of ${total}`}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** A labelled progress row: name, the two numbers, and a bar. */
export function MeasureRow({ label, covered, total, hint, color = '#5C5FC8' }: { label: string; covered: number; total: number; hint?: string; color?: string }) {
  const pct = total === 0 ? null : Math.round((100 * covered) / total)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-ink2">
          {covered} of {total}
          {pct === null ? '' : ` · ${pct}%`}
        </span>
      </div>
      <div className="mt-1.5">
        <MiniBar value={covered} total={total} color={color} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-ink2">{hint}</p>}
    </div>
  )
}

/** A small ring with a percentage in it, for an area summary. */
export function Ring({ pct, size = 46, color = '#5C5FC8', label }: { pct: number | null; size?: number; color?: string; label?: string }) {
  const r = 16
  const c = 2 * Math.PI * r
  const filled = pct === null ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * c
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={label ?? (pct === null ? 'not measured' : `${pct}%`)}>
      <circle cx="20" cy="20" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="5" />
      {pct !== null && (
        <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${filled} ${c - filled}`} transform="rotate(-90 20 20)" />
      )}
      <text x="20" y="24" textAnchor="middle" className="fill-ink" style={{ fontSize: 11, fontWeight: 700 }}>
        {pct === null ? '–' : pct}
      </text>
    </svg>
  )
}
