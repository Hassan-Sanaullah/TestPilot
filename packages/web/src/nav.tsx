/**
 * The current project and tab, shared between the sidebar and the page.
 *
 * The sidebar lives in `App.tsx` and the project lives in `ProjectPage.tsx`, so
 * the navigation has to be lifted somewhere both can see. The tab stays in the
 * URL as `?tab=<key>` because other pages already link to it that way — a run
 * page's "back to runs" link, for one — and changing the scheme would break
 * those links for no benefit.
 */
import { createContext, useContext } from 'react'

export const PROJECT_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tests', label: 'Test cases' },
  { key: 'runs', label: 'Runs' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'gaps', label: 'Missing tests' },
  { key: 'bugs', label: 'Bug reports' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'inventory', label: 'App map' },
  { key: 'settings', label: 'Settings' },
] as const

export type TabKey = (typeof PROJECT_TABS)[number]['key']

export interface ProjectNav {
  project: { id: string; name: string; baseUrl: string } | null
  tab: TabKey
  go: (tab: TabKey) => void
  /** counts shown as small numbers beside a nav item */
  badges?: Partial<Record<TabKey, number>>
}

export const ProjectNavContext = createContext<ProjectNav>({ project: null, tab: 'overview', go: () => {} })

export const useProjectNav = (): ProjectNav => useContext(ProjectNavContext)
