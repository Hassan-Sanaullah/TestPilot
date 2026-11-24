/**
 * Element inventory: DOM-only knowledge of the application, accumulated from
 * every observation (runs and crawls). It is the evidence base for the gap
 * filter's feasibility check — "does the UI this test needs actually exist?"
 */
import type { ObservationData } from '@testpilot/shared'
import { prisma } from '../db'

export interface InventoryRow {
  url: string
  role: string
  label: string
  href?: string
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    u.search = ''
    return u.toString()
  } catch {
    return url
  }
}

export class InventoryCollector {
  private rows = new Map<string, InventoryRow>()

  add(obs: ObservationData): void {
    const url = normalizeUrl(obs.url)
    for (const el of obs.elements) {
      const label = el.label.trim().slice(0, 120)
      if (!label) continue
      const key = `${url}|${el.role}|${label}`
      if (!this.rows.has(key)) this.rows.set(key, { url, role: el.role, label, href: el.href })
    }
  }

  get size(): number {
    return this.rows.size
  }

  async persist(projectId: string, limit = 400): Promise<number> {
    let n = 0
    for (const r of [...this.rows.values()].slice(0, limit)) {
      await prisma.elementInventory
        .upsert({
          where: { projectId_url_role_label: { projectId, url: r.url, role: r.role, label: r.label } },
          create: { projectId, url: r.url, role: r.role, label: r.label, href: r.href ?? null },
          update: { seenAt: new Date(), href: r.href ?? null },
        })
        .then(() => n++)
        .catch(() => undefined)
    }
    return n
  }
}

/** Compact inventory text for prompts: grouped by page, capped. */
export async function inventorySummary(projectId: string, maxPages = 12, maxPerPage = 30): Promise<string> {
  const rows = await prisma.elementInventory.findMany({ where: { projectId }, orderBy: [{ url: 'asc' }, { seenAt: 'desc' }] })
  const byUrl = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byUrl.get(r.url) ?? []
    if (list.length < maxPerPage) list.push(r)
    byUrl.set(r.url, list)
  }
  const out: string[] = []
  for (const [url, list] of [...byUrl.entries()].slice(0, maxPages)) {
    out.push(`PAGE ${url}`)
    for (const r of list) out.push(`  ${r.role} "${r.label}"`)
  }
  return out.length ? out.join('\n') : '(no UI observed yet — run a test or propose requirements first)'
}
