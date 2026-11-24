/** Health + LLM status (which providers/models are reachable). */
import { Router } from 'express'
import { llm } from '../ai/router'
import { config } from '../config'
import { h } from '../http'

export const system = Router()

system.get('/health', (_req, res) => {
  res.json({ ok: true, headless: config.headless, maxSteps: config.maxSteps })
})

let cache: { at: number; data: unknown } | null = null

system.get(
  '/llm/status',
  h(async (req, res) => {
    const force = req.query.refresh === '1'
    if (!force && cache && Date.now() - cache.at < 5 * 60_000) {
      res.json(cache.data)
      return
    }
    const desc = llm.describe()
    const providers = await Promise.all(
      desc.providers.map(async (p) => {
        if (!p.configured) return { ...p, reachable: false, models: [] as string[], error: 'no API key' }
        try {
          const models = await llm.providers[p.name].listModels()
          const has = (m: string) => (models.length === 0 || !m ? null : models.includes(m))
          return { ...p, reachable: true, models, modelAvailable: has(p.model), reasonModelAvailable: has(p.reasonModel) }
        } catch (e) {
          return { ...p, reachable: false, models: [] as string[], error: (e as Error).message }
        }
      }),
    )
    const data = { ...desc, providers }
    cache = { at: Date.now(), data }
    res.json(data)
  }),
)
