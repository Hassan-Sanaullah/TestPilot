/**
 * A tiny measurement hook. The benchmark script (`scripts/bench.mts`) needs to
 * know where a run spends its time without the engine growing timing logic of
 * its own: every phase calls `mark(...)` and the default is a no-op, so nothing
 * is measured unless somebody asks.
 */

export type TimingSink = (name: string, ms: number) => void

/** Time an async phase and report it. Returns whatever the phase returned. */
export async function timed<T>(sink: TimingSink | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  if (!sink) return fn()
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    sink(name, performance.now() - t0)
  }
}

/** Report an already-measured duration. */
export function mark(sink: TimingSink | undefined, name: string, ms: number): void {
  sink?.(name, ms)
}

/** Collects marks into totals and counts; used by the benchmark. */
export class TimingCollector {
  readonly total = new Map<string, number>()
  readonly count = new Map<string, number>()

  readonly sink: TimingSink = (name, ms) => {
    this.total.set(name, (this.total.get(name) ?? 0) + ms)
    this.count.set(name, (this.count.get(name) ?? 0) + 1)
  }

  /** Totals in milliseconds, rounded, sorted by cost. */
  summary(): Record<string, { ms: number; calls: number }> {
    const out: Record<string, { ms: number; calls: number }> = {}
    for (const [name, ms] of [...this.total.entries()].sort((a, b) => b[1] - a[1])) {
      out[name] = { ms: Math.round(ms), calls: this.count.get(name) ?? 0 }
    }
    return out
  }
}
