/**
 * The pool exists to stop paying for a Chromium launch on every run. What it
 * must never do is let two runs see each other, so the isolation check matters
 * as much as the reuse one.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { closeSharedBrowser, pooledBrowserCount, sharedBrowser } from './browserPool'

afterAll(closeSharedBrowser)

describe('shared browser pool', () => {
  it('hands out the same browser twice', async () => {
    const a = await sharedBrowser(true)
    const b = await sharedBrowser(true)
    expect(b).toBe(a)
    expect(a.isConnected()).toBe(true)
  })

  it('serves concurrent callers from one launch', async () => {
    await closeSharedBrowser()
    const [a, b, c] = await Promise.all([sharedBrowser(true), sharedBrowser(true), sharedBrowser(true)])
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(pooledBrowserCount()).toBe(1)
  })

  it('launches a fresh browser after the pool is closed', async () => {
    const a = await sharedBrowser(true)
    await closeSharedBrowser()
    expect(a.isConnected()).toBe(false)
    const b = await sharedBrowser(true)
    expect(b).not.toBe(a)
    expect(b.isConnected()).toBe(true)
  })

  it('keeps two contexts from sharing cookies', async () => {
    const browser = await sharedBrowser(true)
    const one = await browser.newContext()
    const two = await browser.newContext()
    try {
      await one.addCookies([{ name: 'tp', value: 'one', url: 'https://example.com' }])
      expect((await one.cookies('https://example.com')).map((c) => c.value)).toEqual(['one'])
      expect(await two.cookies('https://example.com')).toEqual([])
    } finally {
      await one.close()
      await two.close()
    }
  })
})
