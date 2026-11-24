import { describe, expect, it } from 'vitest'
import { shapeOf } from './explorer'

describe('URL shapes (crawl budget)', () => {
  it('collapses identifiers so a crawl does not spend itself on one template', () => {
    expect(shapeOf('https://x.test/products/p43')).toBe(shapeOf('https://x.test/products/p7'))
    expect(shapeOf('https://x.test/orders/1021')).toBe('/orders/:id')
    expect(shapeOf('https://x.test/u/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('/u/:id')
  })

  it('keeps genuinely different pages apart', () => {
    expect(shapeOf('https://x.test/cart')).not.toBe(shapeOf('https://x.test/checkout'))
    expect(shapeOf('https://x.test/products/p1')).not.toBe(shapeOf('https://x.test/orders/1'))
  })

  it('treats the query parameter NAMES as part of the shape, not their values', () => {
    // ?id=4 and ?id=9 are the same template; ?page= is a different one.
    expect(shapeOf('https://x.test/item.html?id=4')).toBe(shapeOf('https://x.test/item.html?id=9'))
    expect(shapeOf('https://x.test/list?page=2')).not.toBe(shapeOf('https://x.test/list?category=audio'))
  })

  it('survives a malformed URL', () => {
    expect(shapeOf('not a url')).toBe('not a url')
  })
})
