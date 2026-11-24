/**
 * One Chromium per headless mode for the whole server, instead of one per run.
 *
 * Launching a browser costs roughly a second and a half; a ShopMax replay is
 * only a few seconds long, so the launch used to be a large share of every
 * run. Browser contexts are already fully isolated from each other (separate
 * cookies, storage and cache), which is the only isolation a test run needs, so
 * sharing the process is safe.
 */
import { type Browser, chromium } from 'playwright'
import { config } from '../config'

const browsers = new Map<boolean, Browser>()
const launching = new Map<boolean, Promise<Browser>>()

/**
 * The shared browser for a headless mode. Every run must still create its own
 * context — never share one.
 */
export async function sharedBrowser(headless: boolean = config.headless): Promise<Browser> {
  const existing = browsers.get(headless)
  if (existing?.isConnected()) return existing

  const pending = launching.get(headless)
  if (pending) return pending

  const p = chromium.launch({ headless }).then(
    (b) => {
      browsers.set(headless, b)
      launching.delete(headless)
      b.on('disconnected', () => {
        if (browsers.get(headless) === b) browsers.delete(headless)
      })
      return b
    },
    (e) => {
      launching.delete(headless)
      throw e
    },
  )
  launching.set(headless, p)
  return p
}

/** Close every pooled browser. Called on shutdown and by tests. */
export async function closeSharedBrowser(): Promise<void> {
  const open = [...browsers.values()]
  browsers.clear()
  const pendings = [...launching.values()]
  launching.clear()
  // A launch in flight would otherwise leave an orphan process behind.
  for (const p of pendings) {
    await p.then((b) => b.close().catch(() => undefined)).catch(() => undefined)
  }
  await Promise.all(open.map((b) => b.close().catch(() => undefined)))
}

/** How many browsers the pool currently holds (diagnostics and tests). */
export function pooledBrowserCount(): number {
  return browsers.size
}
