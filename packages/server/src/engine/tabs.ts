/**
 * The list of open tabs and which one is being driven.
 *
 * Real sites open popups: a payment window, a "terms" link with
 * `target="_blank"`, an OAuth dialog. Playwright hands those to the context as
 * new pages and leaves it to us to decide which one is current. A popup takes
 * focus, the way it would for a person.
 *
 * Shared by the AI runner and by replay, so a recorded `switchTab` step can be
 * replayed at all. The positions must match what the model saw when the test
 * was authored, which is why adding the same page twice has to be impossible:
 * a duplicate shifts every later index and `switchTab 1` silently drives the
 * wrong tab.
 */
import type { BrowserContext, Page } from 'playwright'

export class TabSet {
  pages: Page[] = []
  active = 0

  constructor(
    context: BrowserContext,
    private readonly onNew: (p: Page, isFirst: boolean) => void,
  ) {
    context.on('page', (p) => this.add(p))
  }

  get current(): Page {
    return this.pages[this.active]
  }

  /**
   * Include a page explicitly. Needed because `context.newPage()` may return
   * before the context has delivered its `page` event, so the caller cannot
   * tell whether the list already has it.
   */
  adopt(page: Page): void {
    this.add(page)
  }

  private add(p: Page): void {
    if (this.pages.includes(p)) return
    const isFirst = this.pages.length === 0
    this.pages.push(p)
    this.active = this.pages.length - 1 // a popup takes focus, like a real browser
    p.on('close', () => {
      const i = this.pages.indexOf(p)
      if (i >= 0) {
        this.pages.splice(i, 1)
        if (this.active >= this.pages.length) this.active = Math.max(0, this.pages.length - 1)
      }
    })
    this.onNew(p, isFirst)
  }

  /** Drop closed tabs and make sure `active` points at a live page. */
  prune(): void {
    this.pages = this.pages.filter((p) => !p.isClosed())
    if (this.active >= this.pages.length) this.active = Math.max(0, this.pages.length - 1)
  }
}
