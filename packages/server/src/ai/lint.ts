/**
 * Instruction review. The deterministic half lives in @testpilot/shared and
 * runs in the browser as you type; this adds an AI rewrite that knows the
 * application's actual UI, so the suggestion references real pages and fields.
 */
import { z } from 'zod'
import { type LintIssue, lintInstruction } from '@testpilot/shared'
import { prisma } from '../db'
import { inventorySummary } from '../engine/inventory'
import { LINT_SYSTEM } from './prompts'
import { type LLMRouter, llm as defaultLlm, parseJsonObject } from './router'

const Schema = z.object({
  verdict: z.enum(['good', 'needs-work']).default('needs-work'),
  problems: z.array(z.string()).default([]),
  improved: z.string().default(''),
  alternatives: z.array(z.object({ title: z.string(), instruction: z.string() })).default([]),
})

export interface LintResult {
  issues: LintIssue[]
  verdict: 'good' | 'needs-work'
  problems: string[]
  improved: string | null
  alternatives: { title: string; instruction: string }[]
}

export async function reviewInstruction(projectId: string, instruction: string, useAi: boolean, llm: LLMRouter = defaultLlm): Promise<LintResult> {
  const issues = lintInstruction(instruction)
  const base: LintResult = {
    issues,
    verdict: issues.some((i) => i.severity === 'error') ? 'needs-work' : 'good',
    problems: [],
    improved: null,
    alternatives: [],
  }
  if (!useAi) return base

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  const inventory = await inventorySummary(projectId, 8, 20)
  const requirements = await prisma.requirement.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 25 })

  try {
    const res = await llm.reason({
      messages: [
        { role: 'system', content: LINT_SYSTEM },
        {
          role: 'user',
          content:
            `APPLICATION: ${project.name} — ${project.baseUrl}\n` +
            (project.description ? `DESCRIPTION: ${project.description}\n` : '') +
            (requirements.length ? `\nREQUIREMENTS CHECKLIST\n${requirements.map((r) => `${r.key}: ${r.text}`).join('\n')}\n` : '') +
            `\nOBSERVED UI\n${inventory}\n\nINSTRUCTION TO REVIEW\n${instruction}`,
        },
      ],
      json: true,
      temperature: 0.2,
    })
    const parsed = Schema.parse(parseJsonObject(res.content))
    return {
      issues,
      verdict: issues.some((i) => i.severity === 'error') ? 'needs-work' : parsed.verdict,
      problems: parsed.problems.slice(0, 3),
      improved: parsed.improved && parsed.improved.trim() !== instruction.trim() ? parsed.improved.trim() : null,
      alternatives: parsed.alternatives.slice(0, 3),
    }
  } catch (e) {
    console.warn('[lint] AI review failed:', (e as Error).message)
    return base
  }
}
