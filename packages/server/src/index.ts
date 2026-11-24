import fs from 'node:fs'
import { llm } from './ai/router'
import { createApp } from './app'
import { config } from './config'
import { prisma } from './db'
import { closeSharedBrowser } from './engine/browserPool'
import { sweepEvidence } from './services/housekeeping'

async function main() {
  fs.mkdirSync(config.evidenceDir, { recursive: true })
  await prisma.$connect()

  // Any run left "running" by a previous process crash is an error now.
  await prisma.run.updateMany({ where: { status: { in: ['running', 'queued'] } }, data: { status: 'error', reason: 'server restarted during run', finishedAt: new Date() } })

  // The browser is shared by every run, so it outlives them and has to be
  // closed deliberately or Chromium is left behind as an orphan process.
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return
      closing = true
      void closeSharedBrowser()
        .catch(() => undefined)
        .then(() => prisma.$disconnect().catch(() => undefined))
        .then(() => process.exit(0))
    })
  }

  void sweepEvidence().catch((e) => console.warn('[housekeeping] evidence sweep failed:', (e as Error).message))

  const app = createApp()
  app.listen(config.port, () => {
    const d = llm.describe()
    console.log(`TestPilot API  → http://localhost:${config.port}/api`)
    console.log(`Evidence dir   → ${config.evidenceDir}`)
    console.log(`Browser        → ${config.headless ? 'headless' : 'headed (set HEADLESS=1 to hide)'}`)
    console.log(`LLM profile    → ${d.profile}: steps via ${d.step}, reasoning via ${d.reason}`)
    const none = d.providers.every((p) => !p.configured)
    if (none) console.warn('WARNING: no LLM API key configured — runs will use the mock provider. See .env.example')
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
