/**
 * "Record login session" — opens a real, visible browser at the application's
 * base URL so the user can sign in by hand (SSO, MFA, captcha, anything), then
 * saves Playwright's storageState. Every later run reuses it, so tests on
 * sites behind authentication never have to log in again.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright'
import { config } from '../config'
import { prisma } from '../db'
import { HttpError } from '../http'

interface CaptureSession {
  projectId: string
  browser: Browser
  context: BrowserContext
  page: Page
  startedAt: number
}

const sessions = new Map<string, CaptureSession>()
const TIMEOUT_MS = 15 * 60_000

export function authStateDir(): string {
  return path.join(config.evidenceDir, '..', 'auth')
}

export async function startCapture(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  await cancelCapture(projectId) // only one at a time

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ viewport: { width: project.viewportWidth, height: project.viewportHeight } })
  const page = await context.newPage()
  await page.goto(project.baseUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => undefined)

  const session: CaptureSession = { projectId, browser, context, page, startedAt: Date.now() }
  sessions.set(projectId, session)

  // Never leave a stray browser running.
  setTimeout(() => {
    if (sessions.get(projectId) === session) void cancelCapture(projectId)
  }, TIMEOUT_MS).unref?.()

  return { started: true, url: page.url() }
}

export async function captureStatus(projectId: string) {
  const s = sessions.get(projectId)
  if (!s) return { active: false as const }
  let url = ''
  try {
    url = s.page.isClosed() ? '' : s.page.url()
  } catch {
    /* closed */
  }
  if (!url) {
    await cancelCapture(projectId)
    return { active: false as const }
  }
  return { active: true as const, url, elapsedMs: Date.now() - s.startedAt }
}

export async function saveCapture(projectId: string) {
  const s = sessions.get(projectId)
  if (!s) throw new HttpError(400, 'No login recording is in progress. Start one first.')
  const dir = authStateDir()
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${projectId}.json`)
  const state = await s.context.storageState({ path: file })
  await cancelCapture(projectId)
  await prisma.project.update({ where: { id: projectId }, data: { storageState: file } })
  return { saved: true, cookies: state.cookies.length, origins: state.origins.length, path: file }
}

export async function cancelCapture(projectId: string): Promise<void> {
  const s = sessions.get(projectId)
  if (!s) return
  sessions.delete(projectId)
  await s.browser.close().catch(() => undefined)
}

export async function clearSavedAuth(projectId: string): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  if (project.storageState) await fs.unlink(project.storageState).catch(() => undefined)
  await prisma.project.update({ where: { id: projectId }, data: { storageState: null } })
}
