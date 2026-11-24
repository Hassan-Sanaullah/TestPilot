/**
 * Pages that cannot be driven, and saying so plainly.
 *
 * A CAPTCHA, a bot wall or a page that rendered nothing are all situations
 * where no amount of retrying helps. Without this check the run wanders until
 * it runs out of steps and then reports something that sounds like a defect in
 * the application — which buries real bugs and wastes the user's time. These
 * are tool failures, never bug reports, and each one comes with the sentence
 * that tells the user what to do about it.
 */
import type { Page } from 'playwright'
import { settlePage } from './settle'

export type BlockerKind = 'captcha' | 'bot-wall' | 'empty'

export interface Blocker {
  kind: BlockerKind
  /** what was seen, for the log */
  detail: string
  /** what the user should do, in plain words */
  advice: string
}

const CAPTCHA_FRAME = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest/i
const BOT_WALL_TEXT = /just a moment|attention required|access denied|verify you are human|are you a robot|unusual traffic|enable javascript and cookies|checking your browser/i

const PROBE_JS = `
() => {
  const q = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[onclick]';
  const captchaish = document.querySelector('.g-recaptcha,.h-captcha,[data-sitekey],#challenge-form,iframe[title*="recaptcha" i]');
  return {
    interactive: document.querySelectorAll(q).length,
    title: (document.title || '').slice(0, 200),
    body: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
    captchaish: captchaish ? (captchaish.className || captchaish.id || captchaish.tagName) : '',
  };
}`
const probeFn = new Function('return (' + PROBE_JS + ')')() as () => { interactive: number; title: string; body: string; captchaish: string }

/**
 * Is this page undrivable? Called when an observation looks too sparse to be
 * real, and by the explorer on every page.
 */
export async function detectBlocker(page: Page): Promise<Blocker | null> {
  if (page.isClosed()) return null

  // A CAPTCHA usually lives in a third-party iframe.
  for (const frame of page.frames()) {
    const url = frame.url()
    if (url && CAPTCHA_FRAME.test(url)) {
      return {
        kind: 'captcha',
        detail: `a CAPTCHA widget is embedded from ${new URL(url).hostname}`,
        advice: 'This page shows a CAPTCHA. Automated browsers cannot pass it. Use a test environment with CAPTCHA disabled, or record a login session in Settings.',
      }
    }
  }

  let probe: ReturnType<typeof probeFn>
  try {
    probe = await page.evaluate(probeFn)
  } catch {
    return null // navigating; the next observation will tell us
  }

  if (probe.captchaish) {
    return {
      kind: 'captcha',
      detail: `the page contains a CAPTCHA element (${probe.captchaish})`,
      advice: 'This page shows a CAPTCHA. Automated browsers cannot pass it. Use a test environment with CAPTCHA disabled, or record a login session in Settings.',
    }
  }

  // A bot wall says so in words and offers almost nothing to click. Either
  // signal alone is too weak: plenty of real pages are sparse, and plenty of
  // real pages contain the word "denied".
  if (probe.interactive < 5 && (BOT_WALL_TEXT.test(probe.title) || BOT_WALL_TEXT.test(probe.body))) {
    return {
      kind: 'bot-wall',
      detail: `the page says "${(BOT_WALL_TEXT.exec(probe.title) ?? BOT_WALL_TEXT.exec(probe.body))?.[0]}" and offers ${probe.interactive} interactive element(s)`,
      advice: 'The site is blocking automated browsers. Test against a staging environment, or ask whoever runs the site to allow your test traffic.',
    }
  }

  if (probe.interactive === 0) {
    // Give it one more chance: a single-page app can be a blank document for a
    // moment after the first paint.
    await settlePage(page, { quiet: 150, max: 2000, grace: 2000 })
    const again = await page.evaluate(probeFn).catch(() => probe)
    if (again.interactive === 0) {
      return {
        kind: 'empty',
        detail: `no interactive elements after waiting (title "${again.title || 'untitled'}")`,
        advice: 'The page rendered nothing a test could use. Check the URL, whether the app needs a sign-in, and whether it requires a browser feature that is off in automation.',
      }
    }
  }

  return null
}
