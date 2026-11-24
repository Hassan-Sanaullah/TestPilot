/**
 * Central configuration. Values come from the repo-root .env (see .env.example).
 */
import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_ROOT = path.resolve(here, '..')
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..')

loadEnv({ path: path.join(REPO_ROOT, '.env') })
loadEnv() // also honour a local .env in cwd, without overriding

// Default database: SQLite file under packages/server/data (no setup needed).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:' + path.join(SERVER_ROOT, 'data', 'testpilot.db').replace(/\\/g, '/')
}

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim()
const int = (k: string, d: number): number => {
  const n = Number.parseInt(env(k, ''), 10)
  return Number.isFinite(n) ? n : d
}

export type ProviderName = 'gemini' | 'groq' | 'openai' | 'mock'

export interface ProviderConfig {
  name: ProviderName
  baseUrl: string
  apiKey: string
  /** default model — used for the high-volume per-step generation */
  model: string
  /** optional stronger model for the few reasoning calls (coverage, gaps, bugs) */
  reasonModel: string
  minIntervalMs: number
}

const profile = env('LLM_PROFILE', 'free') === 'openai' ? 'openai' : 'free'
const asProvider = (v: string, d: ProviderName): ProviderName =>
  (['gemini', 'groq', 'openai', 'mock'] as const).includes(v as ProviderName) ? (v as ProviderName) : d

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const traceModes = ['always', 'on-failure', 'off'] as const
export type TraceMode = (typeof traceModes)[number]

export const config = {
  port: int('PORT', 4000),
  headless: env('HEADLESS', '0') === '1',
  maxSteps: int('MAX_STEPS', 30),
  evidenceDir: env('EVIDENCE_DIR') || path.join(SERVER_ROOT, 'evidence'),
  /** how many runs may execute at once across all projects */
  runConcurrency: clamp(int('RUN_CONCURRENCY', 4), 1, 8),
  /** of those, how many may be AI-authoring runs (they share an LLM quota) */
  aiConcurrency: clamp(int('AI_CONCURRENCY', 2), 1, 8),
  /**
   * Playwright traces are large and slow to write. A passing run is rarely
   * opened, so by default only failures keep theirs.
   */
  traceMode: (traceModes as readonly string[]).includes(env('TRACE', 'on-failure')) ? (env('TRACE', 'on-failure') as TraceMode) : ('on-failure' as TraceMode),
  /** delete screenshots and traces older than this; 0 keeps everything */
  evidenceKeepDays: int('EVIDENCE_KEEP_DAYS', 30),
  llm: {
    profile,
    stepProvider: asProvider(env('LLM_STEP_PROVIDER'), profile === 'openai' ? 'openai' : 'gemini'),
    reasonProvider: asProvider(env('LLM_REASON_PROVIDER'), profile === 'openai' ? 'openai' : 'groq'),
    /** thinking budget for per-step calls; '' disables the parameter entirely */
    stepEffort: (['minimal', 'low', 'medium', 'high'] as const).includes(env('LLM_STEP_EFFORT', 'minimal') as 'minimal')
      ? (env('LLM_STEP_EFFORT', 'minimal') as 'minimal' | 'low' | 'medium' | 'high')
      : undefined,
    cacheFirst: env('LLM_CACHE_FIRST', '0') === '1',
    providers: {
      gemini: {
        name: 'gemini',
        baseUrl: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
        apiKey: env('GEMINI_API_KEY'),
        model: env('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
        reasonModel: env('GEMINI_REASON_MODEL', 'gemini-3.5-flash'),
        // 0 = no artificial delay; the provider backs off by itself on a 429.
        minIntervalMs: int('LLM_MIN_INTERVAL_GEMINI_MS', 0),
      },
      groq: {
        name: 'groq',
        baseUrl: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
        apiKey: env('GROQ_API_KEY'),
        model: env('GROQ_MODEL', 'openai/gpt-oss-120b'),
        reasonModel: env('GROQ_REASON_MODEL'),
        minIntervalMs: int('LLM_MIN_INTERVAL_GROQ_MS', 0),
      },
      openai: {
        name: 'openai',
        baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        apiKey: env('OPENAI_API_KEY'),
        model: env('OPENAI_MODEL', 'gpt-5-mini'),
        reasonModel: env('OPENAI_REASON_MODEL'),
        minIntervalMs: int('LLM_MIN_INTERVAL_OPENAI_MS', 0),
      },
    } satisfies Record<Exclude<ProviderName, 'mock'>, ProviderConfig>,
  },
}
