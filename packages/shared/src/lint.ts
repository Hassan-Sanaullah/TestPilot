/**
 * Instruction quality check.
 *
 * A test instruction has to say two things: what to DO and what must be TRUE
 * afterwards. Without the second half the agent has nothing to judge against,
 * and "the application did something" gets reported as a pass. These checks are
 * deterministic and run in the browser as you type; `improveInstruction` on the
 * server additionally offers an AI-written replacement.
 */

export type LintSeverity = 'error' | 'warning'

export interface LintIssue {
  severity: LintSeverity
  code: string
  message: string
  hint: string
}

const VERIFY_WORDS = /\b(verify|verif\w+|assert|check|confirm|ensure|expect\w*|should|must|displays?|shows?|appears?|is shown|is displayed|rejects?|accepts?)\b/i
const OUTCOME_WORDS = /\b(message|error|text|page|url|total|price|heading|list|result|confirmation|redirect\w*|visible|contains?|equals?|shown|displayed)\b/i
const VAGUE_OPENERS = /^\s*(test|check|try|verify)\s+(the\s+)?(length|type|types|behaviour|behavior|functionality|features?|working|flow|everything|all)\b/i
const QUOTED = /["'“”].+?["'“”]/

/** Checks that need no AI. Safe to run on every keystroke. */
export function lintInstruction(instruction: string): LintIssue[] {
  const text = (instruction ?? '').trim()
  const issues: LintIssue[] = []
  const words = text.split(/\s+/).filter(Boolean)

  if (text.length < 15 || words.length < 5) {
    issues.push({
      severity: 'error',
      code: 'too-short',
      message: 'This instruction is too short to execute.',
      hint: 'Describe the steps to take and the result that must be true afterwards.',
    })
    return issues // other checks are meaningless on a fragment
  }

  if (VAGUE_OPENERS.test(text) && !VERIFY_WORDS.test(text.replace(VAGUE_OPENERS, ''))) {
    issues.push({
      severity: 'error',
      code: 'vague-goal',
      message: 'This describes an area to explore, not a specific test.',
      hint: 'A test checks one concrete scenario. Split "test the password rules" into e.g. "registering with a 3-character password is rejected".',
    })
  }

  if (!VERIFY_WORDS.test(text)) {
    issues.push({
      severity: 'error',
      code: 'no-expectation',
      message: 'No expected outcome is stated, so there is nothing to pass or fail against.',
      hint: 'Add what must be true at the end, for example "…and verify that the error \'Password must be at least 8 characters.\' is shown".',
    })
  } else if (!OUTCOME_WORDS.test(text) && !QUOTED.test(text)) {
    issues.push({
      severity: 'warning',
      code: 'vague-expectation',
      message: 'The expected outcome is not specific.',
      hint: 'Name the exact message, value, element or URL you expect, ideally in quotes.',
    })
  }

  if (!QUOTED.test(text)) {
    issues.push({
      severity: 'warning',
      code: 'no-literals',
      message: 'No exact text or value is given.',
      hint: 'Quoting the exact wording ("An account with this email already exists.") makes the result unambiguous.',
    })
  }

  if (words.length > 150) {
    issues.push({
      severity: 'warning',
      code: 'too-long',
      message: 'This instruction covers a lot of ground.',
      hint: 'Long multi-scenario tests are hard to diagnose when they fail. Consider splitting it into separate test cases.',
    })
  }

  const scenarios = text.split(/\b(?:then try|also try|and then try|next,? try|afterwards try)\b/i).length
  if (scenarios > 2) {
    issues.push({
      severity: 'warning',
      code: 'multi-scenario',
      message: 'This looks like several tests in one.',
      hint: 'One test per scenario makes failures point at a single cause.',
    })
  }

  return issues
}

export const lintBlocks = (issues: LintIssue[]): boolean => issues.some((i) => i.severity === 'error')
