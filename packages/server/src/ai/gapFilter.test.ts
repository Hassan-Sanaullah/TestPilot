import { describe, expect, it } from 'vitest'
import { checkFeasibility, jaccard, nearest, tokens } from './gapFilter'

describe('gap filter (M5)', () => {
  it('tokenises without stop words and placeholders', () => {
    const t = tokens('Register with {{unique_email}} and verify the welcome message')
    expect(t.has('register')).toBe(true)
    expect(t.has('welcome')).toBe(true)
    expect(t.has('the')).toBe(false)
    expect(t.has('unique_email')).toBe(false)
  })

  it('scores near-duplicates high and unrelated tests low', () => {
    const a = 'Register a new user with a valid email and verify the welcome message is shown'
    const b = 'Register a new user with valid email; verify welcome message shown'
    const c = 'Apply coupon SAVE10 in the cart and verify the total is reduced by 10%'
    expect(jaccard(a, b)).toBeGreaterThan(0.7)
    expect(jaccard(a, c)).toBeLessThan(0.2)
  })

  it('finds the nearest existing test', () => {
    const n = nearest('Log in with a wrong password and verify the error', ['Register a user', 'Log in with wrong password shows error', 'Checkout'])
    expect(n?.index).toBe(1)
  })

  it('judges feasibility against the observed UI inventory', () => {
    const inventory = ['Email address', 'Password', 'Log in', 'Add Laptop Pro 14 to cart', 'Coupon code', 'Apply coupon']
    expect(checkFeasibility(['Coupon code field', 'Apply coupon button'], inventory).feasibility).toBe('feasible')
    const r = checkFeasibility(['Wishlist button'], inventory)
    expect(r.feasibility).toBe('infeasible')
    expect(r.missing).toEqual(['Wishlist button'])
    expect(checkFeasibility(['Anything'], []).feasibility).toBe('unknown')
    expect(checkFeasibility([], inventory).feasibility).toBe('feasible')
  })
})
