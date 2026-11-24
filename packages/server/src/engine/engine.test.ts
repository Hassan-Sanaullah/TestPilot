import { describe, expect, it } from 'vitest'
import { renderObservation } from './perception'
import { applyPlaceholders, applyPublicPlaceholders, applySecretPlaceholders, makePlaceholderValues, redact } from './placeholders'
import { nextKeyNumber } from '../ai/requirements'
import { parseJsonObject } from '../ai/router'

describe('perception rendering (M1)', () => {
  it('lists indexed elements, scroll position and element totals', () => {
    const text = renderObservation({
      url: 'https://example.com',
      title: 'Example',
      scrollY: 600,
      scrollHeight: 2000,
      viewportHeight: 800,
      totalFound: 2,
      elements: [
        { index: 0, role: 'link', label: 'Home', value: '', disabled: false, editable: false, inViewport: true },
        { index: 1, role: 'text', label: 'Search', value: 'hello', disabled: true, editable: true, inViewport: true },
      ],
    })
    expect(text).toContain('URL: https://example.com')
    expect(text).toContain('[0] link "Home"')
    expect(text).toContain('[1] text "Search"  (value="hello", disabled)')
    expect(text).toContain('Scroll: 50% down a page 2000px tall')
    expect(text).toContain('Interactive elements: 2 on the page, 2 listed below')
  })

  it('puts in-viewport elements first and says how many were omitted', () => {
    const elements = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      role: 'button',
      label: `b${i}`,
      value: '',
      disabled: false,
      editable: false,
      inViewport: i >= 190, // only the last ten are on screen
      ...(i < 190 ? { off: 'below' as const } : {}),
    }))
    const text = renderObservation({ url: 'u', title: 't', scrollY: 0, scrollHeight: 100, viewportHeight: 100, totalFound: 200, elements }, 50)
    const listed = text.split('\n').filter((l) => l.startsWith('  ['))
    expect(listed).toHaveLength(50)
    expect(listed[0]).toContain('b190') // visible ones first
    expect(text).toContain('150 more element(s) not listed')
  })

  it('announces extra tabs', () => {
    const text = renderObservation({ url: 'u', title: 't', scrollY: 0, scrollHeight: 0, viewportHeight: 800, totalFound: 0, elements: [], tabCount: 2, activeTab: 1 })
    expect(text).toContain('Tabs: 2 open, you are on tab 1')
  })
})

describe('placeholders', () => {
  const v = makePlaceholderValues({ baseUrl: 'http://localhost:4100', testUser: 'test@example.com', testPassword: 'hunter2secret', seed: 'run_1' })

  it('resolves every placeholder when asked for all of them', () => {
    const out = applyPlaceholders('Register {{unique_email}} as {{test_user}} / {{ test_password }} at {{base_url}}; id {{unique_id}}; keep {{unknown}}', v)
    expect(out).toContain(v.unique_email)
    expect(out).toContain('test@example.com / hunter2secret at http://localhost:4100')
    expect(out).toContain(`id ${v.unique_id}`)
    expect(out).toContain('{{unknown}}')
    expect(v.unique_email).toMatch(/^tp\.[a-z0-9]+@example\.com$/)
  })

  it('NEVER expands the password into text destined for the LLM', () => {
    const forPrompt = applyPublicPlaceholders('Log in as {{test_user}} with {{test_password}} and check {{unique_email}}', v)
    expect(forPrompt).toContain('test@example.com')
    expect(forPrompt).toContain(v.unique_email)
    expect(forPrompt).toContain('{{test_password}}') // left literal
    expect(forPrompt).not.toContain('hunter2secret')
  })

  it('expands the password only at browser-typing time', () => {
    expect(applySecretPlaceholders('{{test_password}}', v)).toBe('hunter2secret')
    // and leaves public ones alone, since they are already resolved
    expect(applySecretPlaceholders('{{test_user}}', v)).toBe('{{test_user}}')
  })

  it('redacts a secret that leaked into a log line', () => {
    expect(redact('login failed for pw hunter2secret', v)).toBe('login failed for pw {{test_password}}')
  })
})

describe('helpers', () => {
  it('computes the next requirement key', () => {
    expect(nextKeyNumber([])).toBe(1)
    expect(nextKeyNumber(['R1', 'R7', 'r3', 'X'])).toBe(8)
  })

  it('parses JSON from fenced or noisy model output', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonObject('Sure! {"thought":"x","action":{"type":"click","index":1}} hope this helps')).toEqual({ thought: 'x', action: { type: 'click', index: 1 } })
    expect(() => parseJsonObject('no json here')).toThrow()
  })
})
