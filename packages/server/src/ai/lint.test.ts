import { describe, expect, it } from 'vitest'
import { isContentAssertion, lintBlocks, lintInstruction } from '@testpilot/shared'

describe('instruction linter', () => {
  const codes = (s: string) => lintInstruction(s).map((i) => i.code)

  it('rejects the fragment that caused a meaningless run', () => {
    // The real instruction a user wrote; it produced a bogus "pass".
    const issues = lintInstruction('Test the length and type of passwords accepted')
    expect(lintBlocks(issues)).toBe(true)
    expect(issues.map((i) => i.code)).toContain('vague-goal')
  })

  it('rejects instructions that are too short to execute', () => {
    expect(codes('Password type')).toEqual(['too-short'])
    expect(codes('login')).toEqual(['too-short'])
  })

  it('rejects an instruction with no expected outcome', () => {
    const c = codes('Open the registration page and fill in the form with a new email address and a password')
    expect(c).toContain('no-expectation')
    expect(lintBlocks(lintInstruction('Open the registration page and fill in the form with a new email address'))).toBe(true)
  })

  it('accepts a well-formed instruction', () => {
    const good =
      'Open the registration page and register with the name "Ada", the email {{unique_email}} and the password "123". Verify that the error "Password must be at least 8 characters." is shown and that no account is created.'
    const issues = lintInstruction(good)
    expect(lintBlocks(issues)).toBe(false)
    expect(issues).toEqual([])
  })

  it('warns when the expectation is unquoted and vague', () => {
    const c = codes('Go to the cart and check that applying a coupon works correctly for the user')
    expect(c).toContain('no-literals')
  })

  it('warns about multi-scenario instructions', () => {
    const c = codes(
      'Register with the password "123" and verify the error message is shown, then try a password of "1234567" and verify the error, then try "abcdefgh1" and verify that the account is created successfully.',
    )
    expect(c).toContain('multi-scenario')
  })
})

describe('assertion strength', () => {
  it('treats content checks as substantive and a bare visibility check as not', () => {
    expect(isContentAssertion({ type: 'assertText', text: 'Welcome' })).toBe(true)
    expect(isContentAssertion({ type: 'assertUrl', contains: '/orders' })).toBe(true)
    expect(isContentAssertion({ type: 'assertValue', index: 3, text: 'Audio' })).toBe(true)
    expect(isContentAssertion({ type: 'assertVisible', text: 'Order confirmed' })).toBe(true)
    expect(isContentAssertion({ type: 'assertVisible', index: 5 })).toBe(false)
    expect(isContentAssertion({ type: 'click', index: 1 })).toBe(false)
  })
})
