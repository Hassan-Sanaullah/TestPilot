import { SEED_USERS, createShopApp } from './app.js'

const PORT = Number(process.env.SHOP_PORT || 4100)

/**
 * SHOP_BUGS picks which seeded defects are live: "1,3,5", or "none" for a shop
 * that behaves correctly. Unset means all five, which is the default the
 * evaluation and the demo both expect.
 */
function wantedBugs() {
  const raw = (process.env.SHOP_BUGS || '').trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'none' || raw === '0') return []
  if (raw === 'all') return [1, 2, 3, 4, 5]
  return raw
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => n >= 1 && n <= 5)
}

const bugs = wantedBugs()
createShopApp(bugs === undefined ? {} : { bugs }).listen(PORT, () => {
  console.log(`ShopMax → http://localhost:${PORT}`)
  for (const u of SEED_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email} / ${u.password}`)
  console.log(`  seeded bugs: ${bugs === undefined ? 'all five (default)' : bugs.length ? bugs.join(', ') : 'none — the shop behaves correctly'}`)
  console.log('  POST /__reset restores all seed data')
})
