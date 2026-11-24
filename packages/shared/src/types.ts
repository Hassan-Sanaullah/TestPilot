/** Types shared by server and dashboard. */

export interface ObservedElement {
  index: number
  role: string
  label: string
  value: string
  disabled: boolean
  /** true for inputs/textareas/contenteditable — the only targets `type` accepts */
  editable: boolean
  /** currently inside the visible viewport */
  inViewport: boolean
  /** 'above' | 'below' when off-screen vertically */
  off?: 'above' | 'below'
  /** options of a <select>, so the model does not guess values */
  options?: string[]
  /** checkbox / radio state */
  checked?: boolean
  /** anchors only — used by the crawler to discover same-origin pages */
  href?: string
  /** element lives inside an open shadow root */
  shadow?: boolean
  /** index of the frame it belongs to (0 = main document) */
  frame?: number
}

export interface ObservationData {
  url: string
  title: string
  scrollY: number
  scrollHeight: number
  viewportHeight: number
  elements: ObservedElement[]
  /** total interactive elements found before capping */
  totalFound: number
  /** number of open tabs, and which one is active */
  tabCount?: number
  activeTab?: number
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled'
export type StepStatus = 'ok' | 'failed' | 'flagged'
export type CoverageStatus = 'covered' | 'partial' | 'uncovered'
export type GapStatus = 'suggested' | 'accepted' | 'rejected' | 'converted'
export type Feasibility = 'feasible' | 'infeasible' | 'unknown'

export interface StepDTO {
  id: string
  runId: string
  index: number
  action: unknown
  thought: string
  status: StepStatus
  validationAttempts: number
  rejections: string[]
  error: string | null
  screenshotPath: string | null
  url: string
  durationMs: number
  /** the rendered observation the model saw before choosing this action */
  observation?: string | null
  /** JSON ElementRef verified at the time of the action, used for replay */
  locator?: string | null
  createdAt: string
}

export type RunEvent =
  | { type: 'run.status'; runId: string; status: RunStatus; reason?: string | null }
  | { type: 'run.step'; runId: string; step: StepDTO }
  | { type: 'run.log'; runId: string; message: string }
  | { type: 'run.done'; runId: string; status: RunStatus }
  // A suite is the unit a person actually watches: twenty runs finishing one by
  // one is not something to follow, but "14 of 20, 2 failed" is.
  | { type: 'suite.started'; suiteRunId: string; projectId: string; total: number }
  | { type: 'suite.progress'; suiteRunId: string; passed: number; failed: number; errored: number; total: number }
  | { type: 'suite.done'; suiteRunId: string; status: string; passed: number; failed: number; errored: number; total: number }

/** Placeholders a test instruction may contain; resolved per run. */
export const PLACEHOLDERS = [
  '{{unique_email}}',
  '{{unique_id}}',
  '{{unique_name}}',
  '{{phone}}',
  '{{today}}',
  '{{tomorrow}}',
  '{{future_date}}',
  '{{past_date}}',
  '{{adult_birth_date}}',
  '{{test_card}}',
  '{{test_user}}',
  '{{test_password}}',
  '{{base_url}}',
] as const

/** What each placeholder is for, shown to the user and to the model. */
export const PLACEHOLDER_HELP: Record<string, string> = {
  '{{unique_email}}': 'an email address no earlier run has used',
  '{{unique_id}}': 'a short unique string, for names and references',
  '{{unique_name}}': 'a person name no earlier run has used',
  '{{phone}}': 'a phone number in the range reserved for fiction',
  '{{today}}': "today's date, as YYYY-MM-DD",
  '{{tomorrow}}': 'tomorrow, as YYYY-MM-DD',
  '{{future_date}}': 'thirty days from now, as YYYY-MM-DD',
  '{{past_date}}': 'thirty days ago, as YYYY-MM-DD',
  '{{adult_birth_date}}': 'a birth date thirty years ago, for age checks',
  '{{test_card}}': 'the card number payment sandboxes accept (4242…); it works on no real processor',
  '{{test_user}}': "the project's test account",
  '{{test_password}}': 'its password — typed in the browser, never shown to the model',
  '{{base_url}}': 'the application under test',
}

/** Placeholders that must NEVER be expanded into an LLM prompt. */
export const SECRET_PLACEHOLDERS = ['{{test_password}}'] as const
