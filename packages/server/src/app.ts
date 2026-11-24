import cors from 'cors'
import express from 'express'
import { config } from './config'
import { errorMiddleware } from './http'
import { analysis } from './routes/analysis'
import { projects } from './routes/projects'
import { runs } from './routes/runs'
import { suites } from './routes/suites'
import { system } from './routes/system'
import { testcases } from './routes/testcases'

export function createApp() {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.use('/api', system)
  app.use('/api', projects)
  app.use('/api', testcases)
  app.use('/api', runs)
  app.use('/api', suites)
  app.use('/api', analysis)

  // Screenshots + traces
  app.use('/evidence', express.static(config.evidenceDir, { fallthrough: true, maxAge: '1h' }))

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))
  app.use(errorMiddleware)
  return app
}
