/**
 * Wait for the page to stop changing, instead of sleeping for a fixed time.
 *
 * The old executor slept 400 ms after every click and 200 ms after everything
 * else. On a static page that is 400 ms of nothing; on a slow single-page app
 * it is not enough and the next observation reads a half-rendered screen.
 *
 * Watching the DOM answers the real question, but only if the watching starts
 * BEFORE the action: a change that begins 300 ms after a click is invisible to
 * an observer installed afterwards, which would simply see a quiet page and
 * return. So the executor arms a watcher first (`armSettle`), acts, and then
 * waits (`settlePage`). Three outcomes end the wait:
 *
 *   quiet      — the page changed and has now been still for `quiet` ms
 *   no-change  — nothing changed within `grace`, so the action did nothing visible
 *   max        — the page never stops (an animation, a clock); the cap ends it
 */
import type { Page } from 'playwright'

const ARM_JS = `
() => {
  const w = window;
  if (w.__tpSettle && w.__tpSettle.obs) { try { w.__tpSettle.obs.disconnect(); } catch (e) {} }
  const state = { last: 0, seen: 0, armedAt: performance.now(), obs: null };
  state.obs = new MutationObserver(() => { state.seen++; state.last = performance.now(); });
  state.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  w.__tpSettle = state;
  return true;
}`

const WAIT_JS = `
(opts) => new Promise((resolve) => {
  const w = window;
  const start = performance.now();
  // Prefer the watcher armed before the action; it saw changes this one missed.
  const armed = w.__tpSettle && !w.__tpSettle.closed && (start - w.__tpSettle.armedAt) < 60000 ? w.__tpSettle : null;
  const local = armed || { last: 0, seen: 0, obs: null };
  if (!armed) {
    local.obs = new MutationObserver(() => { local.seen++; local.last = performance.now(); });
    local.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const done = (why) => {
    try { if (local.obs) local.obs.disconnect(); } catch (e) {}
    if (armed) armed.closed = true;
    resolve({ why: why, ms: Math.round(performance.now() - start), changes: local.seen });
  };
  const tick = () => {
    const now = performance.now();
    if (now - start >= opts.max) return done('max');
    if (local.seen === 0) {
      // Nothing has happened yet. Give the page a short grace period to start
      // reacting before concluding that it is not going to.
      if (now - start >= opts.grace) return done('no-change');
    } else if (now - local.last >= opts.quiet) {
      return done('quiet');
    }
    setTimeout(tick, 25);
  };
  setTimeout(tick, 25);
})`

// A bare string is not called with arguments by evaluate in Node, so the
// source has to become a real function first.
const armFn = new Function('return (' + ARM_JS + ')')() as () => boolean
const waitFn = new Function('return (' + WAIT_JS + ')')() as (o: { quiet: number; max: number; grace: number }) => Promise<SettleResult>

export interface SettleResult {
  why: 'quiet' | 'no-change' | 'max'
  ms: number
  changes: number
}

export interface SettleOptions {
  /** how long the DOM must be still, once it has moved at all */
  quiet?: number
  /** hard cap, for pages that animate or tick forever */
  max?: number
  /** how long to wait for the page to react before deciding it will not */
  grace?: number
}

/**
 * Start watching the page for changes. Call this immediately before an action
 * so that `settlePage` can see what the action set off.
 */
export async function armSettle(page: Page): Promise<void> {
  try {
    if (page.isClosed()) return
    await page.evaluate(armFn)
  } catch {
    /* mid-navigation or closed: settlePage falls back to watching from after */
  }
}

/** Wait for the page to go quiet. See the module comment for the three exits. */
export async function settlePage(page: Page, opts: SettleOptions = {}): Promise<SettleResult> {
  const args = { quiet: opts.quiet ?? 120, max: opts.max ?? 1500, grace: opts.grace ?? 300 }
  const fallback: SettleResult = { why: 'no-change', ms: 0, changes: 0 }
  try {
    if (page.isClosed()) return fallback
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => undefined)
    return await page.evaluate(waitFn, args)
  } catch {
    // A navigation destroyed the execution context mid-wait: wait for the new
    // document, then one shorter quiet window on it.
    try {
      if (page.isClosed()) return fallback
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 })
      return await page.evaluate(waitFn, { ...args, max: Math.min(args.max, 800) })
    } catch {
      return fallback // closed or still navigating — the next step has its own waits
    }
  }
}
