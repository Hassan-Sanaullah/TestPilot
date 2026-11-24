/**
 * Which login session a run should start from, and where it should start.
 *
 * Every test used to begin signed out at the home page. A checkout test then
 * spent its first five steps — and five model calls — signing in and
 * navigating, every single time, before it could test anything. Those steps
 * were never what the test was about, and each one was a chance to fail for an
 * unrelated reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import { SERVER_ROOT } from '../config'
import { prisma } from '../db'

export type AuthMode = 'auto' | 'anonymous' | 'signed-in'

/** Where automatically captured sessions live. */
export function authStateDir(): string {
  const dir = path.join(SERVER_ROOT, 'data', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const autoSessionPath = (projectId: string): string => path.join(authStateDir(), `${projectId}-auto.json`)

export interface SessionChoice {
  /** path to a storageState file, or undefined to start signed out */
  storageState?: string
  /** how the decision was made, for the run log */
  why: string
  /** true when the run expects to be signed in, so expiry is worth checking */
  expectsSignIn: boolean
}

/**
 * Resolve the session for a run.
 *
 * A session the user recorded by hand always wins: they chose those
 * credentials deliberately, and the automatic one is a convenience.
 */
export function chooseSession(
  project: { storageState?: string | null; autoSession?: string | null },
  testCase: { auth?: string | null; targetUrl?: string | null },
  pages: { url: string; requiresAuth: boolean }[],
): SessionChoice {
  const mode = (testCase.auth ?? 'auto') as AuthMode
  const exists = (p?: string | null): string | undefined => (p && fs.existsSync(p) ? p : undefined)
  const recorded = exists(project.storageState)
  const automatic = exists(project.autoSession)

  if (mode === 'anonymous') {
    return { why: 'this test is about signing in or must run signed out', expectsSignIn: false }
  }

  if (mode === 'signed-in') {
    const picked = recorded ?? automatic
    if (!picked) return { why: 'this test wants to be signed in, but no session has been captured yet', expectsSignIn: true }
    return { storageState: picked, why: recorded ? 'using the session you recorded' : 'using the session captured while exploring', expectsSignIn: true }
  }

  // auto: sign in when the page under test needs it.
  const target = testCase.targetUrl
  const needsAuth = target ? pages.some((p) => sameUrl(p.url, target) && p.requiresAuth) : false
  if (!needsAuth) return { why: target ? 'the page under test is reachable without signing in' : 'no page was named, so starting signed out', expectsSignIn: false }
  const picked = recorded ?? automatic
  if (!picked) return { why: 'the page under test needs a sign-in, but no session has been captured yet', expectsSignIn: true }
  return { storageState: picked, why: 'the page under test needs a sign-in', expectsSignIn: true }
}

const sameUrl = (a: string, b: string): boolean => {
  const trim = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
  return trim(a) === trim(b)
}

/** Save this context's cookies and storage as the project's automatic session. */
export async function captureAutoSession(context: BrowserContext, projectId: string): Promise<string> {
  const file = autoSessionPath(projectId)
  await context.storageState({ path: file })
  await prisma.project.update({ where: { id: projectId }, data: { autoSession: file, autoSessionAt: new Date() } }).catch(() => undefined)
  return file
}

/**
 * Does this page look like we have been bounced to a sign-in screen?
 *
 * Two signals, because either alone is wrong often enough: the URL matches a
 * page the explorer classified as `auth`, or there is a visible password field.
 */
export function looksSignedOut(url: string, hasVisiblePasswordField: boolean, authPages: string[]): boolean {
  if (hasVisiblePasswordField) return true
  return authPages.some((a) => sameUrl(a, url))
}
