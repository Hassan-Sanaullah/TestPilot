// ShopMax — the complex evaluation target for TestPilot.
//
// Deliberately exercises everything that breaks naive browser agents:
// a blocking cookie banner, a hover mega-menu, 120 products behind
// search/filter/sort/pagination/lazy-load, modals, toasts, a shadow-DOM
// component, an iframe, a native confirm(), a 3-step wizard, debounced async
// validation, a target=_blank link and a login-gated admin data grid.
//
// It also contains SEEDED BUGS — see README.md for the ground-truth list.
import express from 'express'
import crypto from 'node:crypto'
import { CATEGORIES, COUPONS, SEED_USERS, SHIPPING_FLAT, buildProducts } from './data.js'
import { esc, layout, money, pagination, productCard } from './views.js'

export { SEED_USERS }

/**
 * The shop, with its seeded defects individually switchable.
 *
 * The evaluation needs this. Measuring how many of five seeded bugs a suite
 * finds says nothing on its own: a tool that reports everything as broken
 * scores full marks. The same suite has to be run against a shop with NO bugs,
 * where the right answer is zero reports — and that requires being able to turn
 * them off without editing this file.
 *
 * `bugs` is a list or set of ids 1-5. Omit it and all five are on, so every
 * existing caller behaves exactly as before.
 */
export function createShopApp(options = {}) {
  const bugs = new Set(options.bugs === undefined ? [1, 2, 3, 4, 5] : [...options.bugs].map(Number))
  const buggy = (n) => bugs.has(n)
  const app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())

  const PRODUCTS = buildProducts()
  const byId = new Map(PRODUCTS.map((p) => [p.id, p]))
  let users, sessions, orders, orderSeq

  function reset() {
    users = new Map(SEED_USERS.map((u) => [u.email, { ...u }]))
    sessions = new Map()
    orders = []
    orderSeq = 1000
    // a few historical orders so the admin grid has data to sort and page
    const samples = [
      ['test@example.com', 2, 149.5, 'shipped'],
      ['test@example.com', 1, 1299.0, 'delivered'],
      ['admin@example.com', 5, 89.99, 'pending'],
      ['test@example.com', 3, 452.25, 'pending'],
      ['admin@example.com', 1, 25.0, 'cancelled'],
      ['test@example.com', 7, 1020.4, 'shipped'],
    ]
    for (const [email, items, total, status] of samples) {
      orders.push({
        id: `ORD-${++orderSeq}`,
        user: email,
        lines: [{ name: 'Historical item', qty: items, price: total / items }],
        total,
        status,
        address: '1 Example Street',
        at: new Date(Date.now() - orderSeq * 3600_000).toISOString(),
      })
    }
  }
  reset()

  // ---------------------------------------------------------------- session
  app.use((req, res, next) => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]),
    )
    let sid = cookies.shop_sid
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomUUID()
      sessions.set(sid, { userEmail: null, cart: [], coupon: null, flash: null, checkout: {} })
      res.setHeader('Set-Cookie', `shop_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`)
    }
    req.session = sessions.get(sid)
    req.user = req.session.userEmail ? users.get(req.session.userEmail) : null
    next()
  })

  const requireLogin = (req, res, next) => {
    if (!req.user) {
      req.session.flash = { type: 'error', text: 'Please log in to continue.' }
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl))
    }
    next()
  }

  function cartTotals(session) {
    const lines = session.cart.map((l) => ({ ...l, product: byId.get(l.id) })).filter((l) => l.product)
    const subtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0)
    const coupon = session.coupon ? COUPONS[session.coupon] : null
    let rate = coupon ? coupon.rate : 0
    // ── SEEDED BUG #1: SAVE10 is advertised as 10% but applies 20%.
    if (buggy(1) && session.coupon === 'SAVE10') rate = 0.2
    const discount = Math.round(subtotal * rate * 100) / 100
    const shipping = lines.length === 0 || coupon?.freeShipping ? 0 : SHIPPING_FLAT
    return { lines, subtotal, discount, shipping, total: Math.round((subtotal - discount + shipping) * 100) / 100 }
  }

  // ---------------------------------------------------------------- catalogue
  function filterProducts(q) {
    const search = (q.q || '').toString()
    const category = (q.category || '').toString()
    const sort = (q.sort || 'name').toString()
    const maxPrice = parseFloat(q.maxPrice)

    let list = PRODUCTS.slice()
    // ── SEEDED BUG #2: search is case-sensitive, so "laptop" finds nothing.
    if (search) {
      if (buggy(2)) list = list.filter((p) => p.name.includes(search) || p.sku.includes(search))
      else {
        const needle = search.toLowerCase()
        list = list.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle))
      }
    }
    if (category) list = list.filter((p) => p.category === category)
    if (Number.isFinite(maxPrice)) list = list.filter((p) => p.price <= maxPrice)

    if (sort === 'price-asc') list.sort((a, b) => a.price - b.price)
    else if (sort === 'price-desc') list.sort((a, b) => b.price - a.price)
    else if (sort === 'rating') list.sort((a, b) => b.rating - a.rating)
    else list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }

  app.get('/', (req, res) => {
    const list = filterProducts(req.query)
    const perPage = 12
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1)
    const pages = Math.max(1, Math.ceil(list.length / perPage))
    const slice = list.slice((page - 1) * perPage, page * perPage)
    const q = (req.query.q || '').toString()
    const category = (req.query.category || '').toString()
    const sort = (req.query.sort || 'name').toString()

    // ── SEEDED BUG #3: pagination links drop the category filter, so moving to
    // page 2 silently shows unfiltered results.
    const queryFor = (p) =>
      `page=${p}` +
      (q ? `&q=${encodeURIComponent(q)}` : '') +
      (!buggy(3) && category ? `&category=${encodeURIComponent(category)}` : '') +
      (sort !== 'name' ? `&sort=${sort}` : '')

    const nextQuery = page < pages ? `page=${page + 1}&q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&sort=${sort}` : ''

    res.send(
      layout(
        req,
        'Products',
        `<h1>Products</h1>
<form class="toolbar" method="get" action="/">
  <div><label for="q">Search products</label><input id="q" name="q" value="${esc(q)}" placeholder="e.g. Keyboard"></div>
  <div><label for="category">Category</label>
    <select id="category" name="category"><option value="">All categories</option>
      ${CATEGORIES.map((c) => `<option value="${esc(c)}"${c === category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
    </select></div>
  <div><label for="sort">Sort by</label>
    <select id="sort" name="sort">
      <option value="name"${sort === 'name' ? ' selected' : ''}>Name</option>
      <option value="price-asc"${sort === 'price-asc' ? ' selected' : ''}>Price: low to high</option>
      <option value="price-desc"${sort === 'price-desc' ? ' selected' : ''}>Price: high to low</option>
      <option value="rating"${sort === 'rating' ? ' selected' : ''}>Rating</option>
    </select></div>
  <div><label for="maxPrice">Max price</label><input id="maxPrice" name="maxPrice" type="number" value="${esc(req.query.maxPrice || '')}" placeholder="Any"></div>
  <div><button type="submit">Apply filters</button></div>
</form>
<p class="muted">${list.length} product(s) found${q ? ` for "${esc(q)}"` : ''} — page ${page} of ${pages}</p>
${list.length === 0 ? '<p class="alert error">No products match your search.</p>' : ''}
<div class="grid" id="product-grid">${slice.map(productCard).join('')}</div>
${nextQuery ? `<p style="margin-top:18px"><button id="load-more" data-next="${esc(nextQuery)}">Load more products</button></p>` : ''}
${pagination(page, pages, queryFor)}`,
      ),
    )
  })

  app.get('/api/products', (req, res) => {
    const list = filterProducts(req.query)
    const perPage = 12
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1)
    const pages = Math.max(1, Math.ceil(list.length / perPage))
    res.json({
      items: list.slice((page - 1) * perPage, page * perPage),
      nextQuery:
        page < pages
          ? `page=${page + 1}&q=${encodeURIComponent(req.query.q || '')}&category=${encodeURIComponent(req.query.category || '')}&sort=${req.query.sort || 'name'}`
          : '',
    })
  })

  app.get('/products/:id', (req, res) => {
    const p = byId.get(req.params.id)
    if (!p) return res.status(404).send(layout(req, 'Not found', '<h1>Product not found</h1>'))
    const related = PRODUCTS.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 4)
    res.send(
      layout(
        req,
        p.name,
        `<nav class="muted"><a href="/">Products</a> / <a href="/?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a> / ${esc(p.name)}</nav>
<div class="card" style="margin-top:14px">
  <h1>${esc(p.name)}</h1>
  <p>${esc(p.desc)}</p>
  <p class="price">${money(p.price)}</p>
  <p class="muted">SKU ${esc(p.sku)} · ${p.stock > 0 ? `${p.stock} in stock` : '<strong>Out of stock</strong>'}</p>
  <product-rating value="${p.rating}"></product-rating>
  <form method="post" action="/cart/add" style="margin-top:14px">
    <input type="hidden" name="id" value="${p.id}">
    <label for="qty">Quantity</label>
    <input id="qty" name="qty" type="number" min="1" max="10" value="1" style="max-width:120px">
    <br><br><button type="submit" ${p.stock === 0 ? 'disabled' : ''}>Add to cart</button>
  </form>
</div>
<h2>Customer reviews</h2>
<iframe src="/reviews/${p.id}" title="Customer reviews" style="width:100%;height:220px;border:1px solid #e5e7eb;border-radius:8px;background:#fff"></iframe>
<h2>Related products</h2>
<div class="grid">${related.map(productCard).join('')}</div>`,
      ),
    )
  })

  app.get('/reviews/:id', (req, res) => {
    const p = byId.get(req.params.id)
    res.send(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:system-ui,sans-serif;margin:12px;color:#1f2937}
      .r{border-bottom:1px solid #e5e7eb;padding:8px 0}</style></head><body>
      <div class="r"><strong>Great value</strong> — ★ 5 — "Exactly what I needed for ${esc(p ? p.category : 'this')}."</div>
      <div class="r"><strong>Does the job</strong> — ★ 4 — "Solid build, quick delivery."</div>
      <div class="r"><strong>Average</strong> — ★ 3 — "Works, but I expected more at this price."</div>
      <button onclick="document.getElementById('more').style.display='block'">Show more reviews</button>
      <div id="more" style="display:none" class="r">Hidden review: "Reviews live inside an iframe."</div>
      </body></html>`)
  })

  // ---------------------------------------------------------------- cart
  app.post('/cart/add', (req, res) => {
    const p = byId.get(req.body.id)
    const qty = Math.max(1, parseInt(req.body.qty || '1', 10) || 1)
    if (p) {
      const line = req.session.cart.find((l) => l.id === p.id)
      if (line) line.qty += qty
      else req.session.cart.push({ id: p.id, qty })
      req.session.flash = { type: 'success', text: `${p.name} added to your cart.` }
    }
    res.redirect('/cart')
  })

  app.get('/cart', (req, res) => {
    const t = cartTotals(req.session)
    res.send(
      layout(
        req,
        'Cart',
        `<h1>Your cart</h1>
${
  t.lines.length === 0
    ? '<p>Your cart is empty.</p><a class="btn" href="/">Continue shopping</a>'
    : `<table><thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Line total</th><th></th></tr></thead><tbody>
${t.lines
  .map(
    (l) => `<tr><td>${esc(l.product.name)}</td><td>${money(l.product.price)}</td>
<td><form class="inline" method="post" action="/cart/update"><input type="hidden" name="id" value="${l.id}">
  <input name="qty" type="number" min="1" value="${l.qty}" aria-label="Quantity for ${esc(l.product.name)}" style="width:80px">
  <button type="submit">Update</button></form></td>
<td>${money(l.product.price * l.qty)}</td>
<td><form class="inline" method="post" action="/cart/remove" onsubmit="return confirm('Remove ${esc(l.product.name)} from your cart?')">
  <input type="hidden" name="id" value="${l.id}">
  <button class="danger" type="submit" aria-label="Remove ${esc(l.product.name)}">Remove</button></form></td></tr>`,
  )
  .join('')}
</tbody></table>
<div class="card" style="margin-top:16px;max-width:460px">
  <form method="post" action="/cart/coupon">
    <label for="coupon">Coupon code</label>
    <input id="coupon" name="coupon" value="${esc(req.session.coupon || '')}" placeholder="SAVE10 = 10% off">
    <button type="submit" style="margin-top:8px">Apply coupon</button>
  </form>
  <p>Subtotal: <strong id="subtotal">${money(t.subtotal)}</strong></p>
  ${t.discount ? `<p>Discount (${esc(req.session.coupon)}): <strong id="discount">-${money(t.discount)}</strong></p>` : ''}
  <p>Shipping: <strong id="shipping">${t.shipping ? money(t.shipping) : 'Free'}</strong></p>
  <p style="font-size:18px">Total: <strong id="total">${money(t.total)}</strong></p>
  <a class="btn" href="/checkout">Proceed to checkout</a>
</div>`
}`,
      ),
    )
  })

  app.post('/cart/update', (req, res) => {
    const line = req.session.cart.find((l) => l.id === req.body.id)
    const qty = parseInt(req.body.qty, 10)
    if (line && qty >= 1) line.qty = qty
    req.session.flash = { type: 'success', text: 'Cart updated.' }
    res.redirect('/cart')
  })

  app.post('/cart/remove', (req, res) => {
    req.session.cart = req.session.cart.filter((l) => l.id !== req.body.id)
    req.session.flash = { type: 'success', text: 'Item removed from your cart.' }
    res.redirect('/cart')
  })

  app.post('/cart/coupon', (req, res) => {
    const code = (req.body.coupon || '').trim().toUpperCase()
    if (!code) {
      req.session.coupon = null
      req.session.flash = { type: 'success', text: 'Coupon removed.' }
    } else if (COUPONS[code]) {
      req.session.coupon = code
      req.session.flash = { type: 'success', text: `Coupon ${code} applied: ${COUPONS[code].label}.` }
    } else {
      req.session.flash = { type: 'error', text: 'Invalid coupon code.' }
    }
    res.redirect('/cart')
  })

  // ---------------------------------------------------------------- checkout wizard
  const STEP_NAMES = ['Shipping', 'Payment', 'Review']
  const stepBar = (n) => `<div class="steps">${STEP_NAMES.map((s, i) => `<div class="${i + 1 === n ? 'active' : ''}">${i + 1}. ${s}</div>`).join('')}</div>`

  app.get('/checkout', requireLogin, (req, res) => {
    const t = cartTotals(req.session)
    if (t.lines.length === 0) {
      req.session.flash = { type: 'error', text: 'Your cart is empty.' }
      return res.redirect('/cart')
    }
    res.redirect('/checkout/shipping')
  })

  app.get('/checkout/shipping', requireLogin, (req, res) => {
    const c = req.session.checkout
    res.send(
      layout(
        req,
        'Checkout — Shipping',
        `<h1>Checkout</h1>${stepBar(1)}
<div class="card" style="max-width:520px"><form method="post" action="/checkout/shipping">
  <label for="fullname">Full name</label><input id="fullname" name="fullname" value="${esc(c.fullname || '')}" required>
  <label for="address">Shipping address</label><input id="address" name="address" value="${esc(c.address || '')}" required>
  <label for="city">City</label><input id="city" name="city" value="${esc(c.city || '')}" required>
  <label for="country">Country</label>
  <select id="country" name="country">
    <option value="">Select a country</option>
    ${['Pakistan', 'United Kingdom', 'United States', 'Germany'].map((x) => `<option value="${x}"${c.country === x ? ' selected' : ''}>${x}</option>`).join('')}
  </select>
  <br><br><button type="submit">Continue to payment</button>
</form></div>`,
      ),
    )
  })

  app.post('/checkout/shipping', requireLogin, (req, res) => {
    const { fullname = '', address = '', city = '', country = '' } = req.body
    if (!fullname.trim() || !address.trim() || !city.trim() || !country) {
      req.session.flash = { type: 'error', text: 'All shipping fields are required, including the country.' }
      Object.assign(req.session.checkout, { fullname, address, city, country })
      return res.redirect('/checkout/shipping')
    }
    Object.assign(req.session.checkout, { fullname, address, city, country })
    res.redirect('/checkout/payment')
  })

  app.get('/checkout/payment', requireLogin, (req, res) => {
    if (!req.session.checkout.address) return res.redirect('/checkout/shipping')
    res.send(
      layout(
        req,
        'Checkout — Payment',
        `<h1>Checkout</h1>${stepBar(2)}
<div class="card" style="max-width:520px"><form method="post" action="/checkout/payment">
  <label for="method">Payment method</label>
  <select id="method" name="method">
    <option value="card">Credit card</option>
    <option value="cod">Cash on delivery</option>
    <option value="transfer">Bank transfer</option>
  </select>
  <label for="cardname">Name on card</label><input id="cardname" name="cardname" placeholder="Required for card payments">
  <br><br><button type="submit">Continue to review</button>
  <a class="btn secondary" href="/checkout/shipping">Back</a>
</form></div>`,
      ),
    )
  })

  app.post('/checkout/payment', requireLogin, (req, res) => {
    const { method = 'card', cardname = '' } = req.body
    if (method === 'card' && !cardname.trim()) {
      req.session.flash = { type: 'error', text: 'Name on card is required for card payments.' }
      return res.redirect('/checkout/payment')
    }
    Object.assign(req.session.checkout, { method, cardname })
    res.redirect('/checkout/review')
  })

  app.get('/checkout/review', requireLogin, (req, res) => {
    const c = req.session.checkout
    if (!c.method) return res.redirect('/checkout/payment')
    const t = cartTotals(req.session)
    res.send(
      layout(
        req,
        'Checkout — Review',
        `<h1>Checkout</h1>${stepBar(3)}
<div class="card" style="max-width:620px">
  <h2>Review your order</h2>
  <p><strong>Ship to:</strong> ${esc(c.fullname)}, ${esc(c.address)}, ${esc(c.city)}, ${esc(c.country)}</p>
  <p><strong>Payment:</strong> ${esc(c.method)}</p>
  <table><tbody>
    ${t.lines.map((l) => `<tr><td>${esc(l.product.name)}</td><td>× ${l.qty}</td><td>${money(l.product.price * l.qty)}</td></tr>`).join('')}
    <tr><td colspan="2">Subtotal</td><td>${money(t.subtotal)}</td></tr>
    ${t.discount ? `<tr><td colspan="2">Discount</td><td>-${money(t.discount)}</td></tr>` : ''}
    <tr><td colspan="2">Shipping</td><td>${t.shipping ? money(t.shipping) : 'Free'}</td></tr>
    <tr><td colspan="2"><strong>Total</strong></td><td><strong>${money(t.total)}</strong></td></tr>
  </tbody></table>
  <form method="post" action="/checkout/place"><button type="submit">Place order</button></form>
  <a class="btn secondary" href="/checkout/payment">Back</a>
</div>`,
      ),
    )
  })

  app.post('/checkout/place', requireLogin, (req, res) => {
    const t = cartTotals(req.session)
    const c = req.session.checkout
    if (t.lines.length === 0 || !c.address) return res.redirect('/cart')
    const order = {
      id: `ORD-${++orderSeq}`,
      user: req.user.email,
      lines: t.lines.map((l) => ({ name: l.product.name, qty: l.qty, price: l.product.price })),
      total: t.total,
      status: 'pending',
      address: `${c.address}, ${c.city}, ${c.country}`,
      at: new Date().toISOString(),
    }
    orders.push(order)
    req.session.cart = []
    req.session.coupon = null
    req.session.checkout = {}
    res.redirect(`/orders/${order.id}`)
  })

  // ---------------------------------------------------------------- orders
  app.get('/orders', requireLogin, (req, res) => {
    const mine = orders.filter((o) => o.user === req.user.email)
    res.send(
      layout(
        req,
        'My orders',
        `<h1>My orders</h1>${
          mine.length === 0
            ? '<p>You have no orders yet.</p>'
            : `<table><thead><tr><th>Order</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>
${mine.map((o) => `<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${o.lines.reduce((n, l) => n + l.qty, 0)}</td><td>${money(o.total)}</td><td>${esc(o.status)}</td></tr>`).join('')}
</tbody></table>`
        }`,
      ),
    )
  })

  app.get('/orders/:id', requireLogin, (req, res) => {
    const o = orders.find((x) => x.id === req.params.id && x.user === req.user.email)
    if (!o) return res.status(404).send(layout(req, 'Not found', '<h1>Order not found</h1>'))
    res.send(
      layout(
        req,
        o.id,
        `<div class="alert success">Order confirmed! Thank you for your purchase.</div>
<h1>Order ${o.id}</h1><p>Shipping to: ${esc(o.address)}</p><p>Status: ${esc(o.status)}</p>
<table><tbody>${o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>× ${l.qty}</td><td>${money(l.price * l.qty)}</td></tr>`).join('')}
<tr><td colspan="2"><strong>Total</strong></td><td><strong>${money(o.total)}</strong></td></tr></tbody></table>`,
      ),
    )
  })

  // ---------------------------------------------------------------- admin
  app.get('/admin', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).send(layout(req, 'Forbidden', '<h1>403 — Admins only</h1><p>You do not have access to this area.</p>'))
    }
    const status = (req.query.status || '').toString()
    const sort = (req.query.sort || 'id').toString()
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1)
    const perPage = 5

    let list = orders.slice()
    if (status) list = list.filter((o) => o.status === status)
    list.sort((a, b) => {
      let va = a[sort]
      let vb = b[sort]
      // ── SEEDED BUG #4: the "total" column is sorted as text, so $9.99 sorts
      // after $1020.40.
      if (sort === 'total' && buggy(4)) {
        va = String(a.total)
        vb = String(b.total)
      }
      const r = String(va).localeCompare(String(vb), undefined, { numeric: sort !== 'total' })
      return dir === 'asc' ? r : -r
    })
    const pages = Math.max(1, Math.ceil(list.length / perPage))
    const slice = list.slice((page - 1) * perPage, page * perPage)
    const sortLink = (col) => `?sort=${col}&dir=${sort === col && dir === 'asc' ? 'desc' : 'asc'}&status=${encodeURIComponent(status)}`

    res.send(
      layout(
        req,
        'Admin — Orders',
        `<h1>Admin · Orders</h1>
<form class="toolbar" method="get" action="/admin">
  <div><label for="status">Filter by status</label>
  <select id="status" name="status"><option value="">All statuses</option>
    ${['pending', 'shipped', 'delivered', 'cancelled'].map((s) => `<option value="${s}"${s === status ? ' selected' : ''}>${s}</option>`).join('')}
  </select></div>
  <div><button type="submit">Apply</button></div>
</form>
<p class="muted">${list.length} order(s) · page ${page} of ${pages}</p>
<form method="post" action="/admin/bulk-delete" onsubmit="return confirm('Delete the selected orders? This cannot be undone.')">
<table><thead><tr>
  <th><input type="checkbox" id="select-all" aria-label="Select all orders" onclick="document.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)" style="width:auto"></th>
  <th><a href="${sortLink('id')}">Order ID</a></th>
  <th><a href="${sortLink('user')}">Customer</a></th>
  <th><a href="${sortLink('total')}">Total</a></th>
  <th><a href="${sortLink('status')}">Status</a></th>
  <th>Action</th>
</tr></thead><tbody>
${slice
  .map(
    (o) => `<tr><td><input type="checkbox" name="ids" value="${o.id}" aria-label="Select ${o.id}" style="width:auto"></td>
  <td>${o.id}</td><td>${esc(o.user)}</td><td>${money(o.total)}</td><td>${esc(o.status)}</td>
  <td><a href="/admin/orders/${o.id}">View</a></td></tr>`,
  )
  .join('')}
</tbody></table>
<button class="danger" type="submit" style="margin-top:12px">Delete selected</button>
</form>
${pagination(page, pages, (p) => `page=${p}&sort=${sort}&dir=${dir}&status=${encodeURIComponent(status)}`)}`,
      ),
    )
  })

  app.get('/admin/orders/:id', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).send(layout(req, 'Forbidden', '<h1>403 — Admins only</h1>'))
    const o = orders.find((x) => x.id === req.params.id)
    if (!o) return res.status(404).send(layout(req, 'Not found', '<h1>Order not found</h1>'))
    res.send(
      layout(
        req,
        o.id,
        `<h1>${o.id}</h1><p>Customer: ${esc(o.user)}</p><p>Total: ${money(o.total)}</p>
<form method="post" action="/admin/orders/${o.id}/status">
  <label for="status">Status</label>
  <select id="status" name="status">${['pending', 'shipped', 'delivered', 'cancelled'].map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
  <br><br><button type="submit">Update status</button>
</form>`,
      ),
    )
  })

  app.post('/admin/orders/:id/status', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403)
    const o = orders.find((x) => x.id === req.params.id)
    if (o) o.status = req.body.status
    req.session.flash = { type: 'success', text: `Order ${req.params.id} updated to ${req.body.status}.` }
    res.redirect('/admin')
  })

  app.post('/admin/bulk-delete', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403)
    const ids = [].concat(req.body.ids || [])
    orders = orders.filter((o) => !ids.includes(o.id))
    req.session.flash = { type: 'success', text: `${ids.length} order(s) deleted.` }
    res.redirect('/admin')
  })

  // ---------------------------------------------------------------- auth
  const registerForm = (v = {}) => `<h1>Create an account</h1>
<div class="card" style="max-width:520px"><form method="post" action="/register">
  <label for="name">Full name</label><input id="name" name="name" value="${esc(v.name)}" required>
  <label for="email">Email address</label><input id="email" name="email" type="email" value="${esc(v.email)}" required>
  <div id="email-note" class="field-note"></div>
  <label for="password">Password</label><input id="password" name="password" type="password" required>
  <div class="muted">At least 8 characters.</div>
  <label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required>
  <br><br><button type="submit">Register</button>
</form><p class="muted">Already have an account? <a href="/login">Log in</a></p></div>`

  app.get('/register', (req, res) => res.send(layout(req, 'Register', registerForm())))

  app.get('/api/check-email', (req, res) => {
    const email = (req.query.email || '').toString().trim().toLowerCase()
    // artificial latency so the agent must wait for debounced validation
    setTimeout(() => res.json({ available: !users.has(email) }), 350)
  })

  app.post('/register', (req, res) => {
    const { name = '', email = '', password = '', confirm = '' } = req.body
    const em = email.trim().toLowerCase()
    let error = null
    if (!name.trim() || !em || !password) error = 'All fields are required.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) error = 'Please enter a valid email address.'
    // ── SEEDED BUG #5: the 8-character minimum is skipped when the password
    // contains a digit, so "Ab1" is accepted.
    else if (password.length < 8 && (!buggy(5) || !/\d/.test(password))) error = 'Password must be at least 8 characters.'
    else if (password !== confirm) error = 'Passwords do not match.'
    else if (users.has(em)) error = 'An account with this email already exists.'
    if (error) {
      req.session.flash = { type: 'error', text: error }
      return res.status(400).send(layout(req, 'Register', registerForm({ name, email })))
    }
    users.set(em, { id: `u${users.size + 1}`, name: name.trim(), email: em, password, role: 'customer' })
    req.session.userEmail = em
    req.session.flash = { type: 'success', text: `Welcome, ${name.trim()}! Your account has been created.` }
    res.redirect('/')
  })

  const loginForm = (next = '/') => `<h1>Log in</h1>
<div class="card" style="max-width:460px"><form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="email">Email address</label><input id="email" name="email" type="email" required>
  <label for="password">Password</label><input id="password" name="password" type="password" required>
  <br><br><button type="submit">Log in</button>
</form><p class="muted">No account? <a href="/register">Register</a></p></div>`

  app.get('/login', (req, res) => res.send(layout(req, 'Log in', loginForm(req.query.next || '/'))))

  app.post('/login', (req, res) => {
    const em = (req.body.email || '').trim().toLowerCase()
    const u = users.get(em)
    if (!u || u.password !== req.body.password) {
      req.session.flash = { type: 'error', text: 'Invalid email or password.' }
      return res.status(401).send(layout(req, 'Log in', loginForm(req.body.next || '/')))
    }
    req.session.userEmail = em
    req.session.flash = { type: 'success', text: `Welcome back, ${u.name}!` }
    const next = (req.body.next || '/').toString()
    res.redirect(next.startsWith('/') ? next : '/')
  })

  app.post('/logout', (req, res) => {
    req.session.userEmail = null
    req.session.flash = { type: 'success', text: 'You have been logged out.' }
    res.redirect('/')
  })

  app.get('/help', (req, res) =>
    res.send(layout(req, 'Help centre', '<h1>Help centre</h1><p>This page opens in a new browser tab.</p><p>Contact support@shopmax.example for assistance.</p>')),
  )

  // A deliberately slow page: the button appears 1.5 seconds after load. It is
  // a fixture for TestPilot's own tests (replay must wait for a late element
  // instead of declaring it missing), not a feature of the shop.
  app.get('/slow', (req, res) =>
    res.send(
      layout(
        req,
        'Slow page',
        '<h1>Slow page</h1><p id="slow-status">Loading the control...</p>' +
          '<div id="slow-host"></div>' +
          '<script>setTimeout(function () {' +
          ' var b = document.createElement("button");' +
          ' b.type = "button";' +
          ' b.id = "late";' +
          ' b.setAttribute("data-testid", "late-button");' +
          ' b.textContent = "Late button";' +
          ' b.addEventListener("click", function () { document.getElementById("slow-status").textContent = "Late button was clicked"; });' +
          ' document.getElementById("slow-host").appendChild(b);' +
          ' document.getElementById("slow-status").textContent = "The control is ready";' +
          '}, 1500);</script>',
      ),
    ),
  )

  // ---------------------------------------------------------------- test hooks
  app.post('/__reset', (_req, res) => {
    reset()
    res.json({ ok: true, users: users.size, orders: orders.length, products: PRODUCTS.length })
  })
  // Which defects are live, so an evaluation run can record what it was
  // actually testing against rather than what it believed it had configured.
  app.get('/__health', (_req, res) => res.json({ ok: true, products: PRODUCTS.length, bugs: [...bugs].sort((a, b) => a - b) }))

  return app
}
