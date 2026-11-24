/**
 * Evidence storage: screenshots per step and the Playwright trace per run.
 * Files live under <evidenceDir>/<runId>/ and are served at /evidence/...
 * Only the relative path is stored in the database.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { config } from '../config'

export class EvidenceStore {
  readonly dir: string

  constructor(readonly runId: string) {
    this.dir = path.join(config.evidenceDir, runId)
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
  }

  /** Absolute path for a file in this run's folder. */
  abs(name: string): string {
    return path.join(this.dir, name)
  }

  /** Relative path (URL-safe) stored in the DB and used by the dashboard. */
  rel(name: string): string {
    return `${this.runId}/${name}`
  }

  /**
   * One screenshot per step, as JPEG: a ShopMax page is ~180 KB as PNG and
   * ~25 KB at quality 70, and the encode is several times cheaper. Evidence is
   * looked at, not pixel-compared, so the loss does not matter. `scale: 'css'`
   * keeps a high-DPI display from writing images twice the size.
   */
  async screenshot(page: Page, index: number): Promise<string | null> {
    const name = `step-${String(index).padStart(3, '0')}.jpg`
    try {
      await page.screenshot({ path: this.abs(name), type: 'jpeg', quality: 70, scale: 'css', fullPage: false, timeout: 5000 })
      return this.rel(name)
    } catch {
      return null
    }
  }
}

/**
 * Stop tracing according to `TRACE`, and say where the trace landed.
 *
 * A trace of a passing run is almost never opened but costs time to write and
 * tens of megabytes to keep, so `on-failure` (the default) stops the recording
 * without a path, which discards it.
 */
export async function stopTracing(
  context: BrowserContext | undefined,
  evidence: EvidenceStore,
  status: string,
  opts: { alwaysKeep?: boolean } = {},
): Promise<string | null> {
  if (!context || config.traceMode === 'off') return null
  // An AI authoring run is the one a person actually opens a trace for: it is
  // where you go to see what the model did and why. A replay that passed is
  // not, and there are far more of those.
  const keep = opts.alwaysKeep || config.traceMode === 'always' || status !== 'passed'
  try {
    if (!keep) {
      await context.tracing.stop()
      return null
    }
    await context.tracing.stop({ path: evidence.abs('trace.zip') })
    return evidence.rel('trace.zip')
  } catch {
    return null // browser already gone
  }
}
