/**
 * Explore any website from the command line and print the map.
 *
 *   npm run explore -- https://example.com
 *   npm run explore -- https://example.com user@example.com 'password'
 *
 * Useful for checking how TestPilot sees a site before creating a project for
 * it. Creates a temporary project and removes it afterwards.
 */
import { appMapSummary, exploreApp } from '../src/engine/explorer'
import { prisma } from '../src/db'

const [url, user, password] = process.argv.slice(2)
if (!url) {
  console.error('usage: npm run explore -- <url> [username] [password]')
  process.exit(1)
}

const project = await prisma.project.create({
  data: {
    name: `__explore ${new URL(url).hostname} ${Date.now()}`,
    baseUrl: url,
    testUser: user ?? null,
    testPassword: password ?? null,
  },
})

try {
  const t0 = Date.now()
  const result = await exploreApp(project.id, { maxPages: Number(process.env.MAX_PAGES ?? 8) })
  console.log(`\n${new URL(url).hostname}: ${result.visited} page(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (result.loggedIn ? ' · signed in' : ''))
  for (const p of result.pages) {
    const forms = p.forms.reduce((n, f) => n + f.fields.length, 0)
    console.log(`  [${p.kind.padEnd(8)}]${p.requiresAuth ? '🔒' : '  '} ${p.url}`)
    if (forms) console.log(`             ${p.forms.length} form(s), ${forms} field(s): ${p.forms.flatMap((f) => f.fields.map((x) => x.label)).slice(0, 8).join(', ')}`)
    if (p.rules.length) console.log(`             rules: ${p.rules.slice(0, 3).map((r) => `"${r}"`).join(' · ')}`)
  }
  if (process.env.SHOW_MAP) console.log('\n--- map as the generator sees it ---\n' + (await appMapSummary(project.id)))
} finally {
  await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined)
  await prisma.$disconnect()
}
