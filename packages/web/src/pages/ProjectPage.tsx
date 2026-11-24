import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api, type Project, type ProjectStats } from '../api'
import { Badge, ErrorBox, Skeleton, useAsync, useRunEvents } from '../components/ui'
import { PROJECT_TABS, type ProjectNav, type TabKey } from '../nav'
import BugsTab from './tabs/BugsTab'
import CoverageTab from './tabs/CoverageTab'
import GapsTab from './tabs/GapsTab'
import AppMapTab from './tabs/AppMapTab'
import OverviewTab from './tabs/OverviewTab'
import RequirementsTab from './tabs/RequirementsTab'
import RunsTab from './tabs/RunsTab'
import SettingsTab from './tabs/SettingsTab'
import TestCasesTab from './tabs/TestCasesTab'

const isTab = (v: string): v is TabKey => PROJECT_TABS.some((t) => t.key === v)

export default function ProjectPage({ onNav }: { onNav?: (nav: ProjectNav) => void }) {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab') ?? 'overview'
  const tab: TabKey = isTab(raw) ? raw : 'overview'
  const [tick, setTick] = useState(0)
  const { data: project, error, loading, reload } = useAsync(() => api.get<Project>(`/api/projects/${id}`), [id, tick])
  const { data: stats } = useAsync(() => api.get<ProjectStats>(`/api/projects/${id}/stats`), [id, tick])
  useRunEvents(() => setTick((t) => t + 1))

  const go = (key: TabKey) => setParams({ tab: key })

  // Hand the sidebar the project, the current tab and the counts worth showing
  // next to a nav item.
  useEffect(() => {
    if (!onNav) return
    onNav({
      project: project ? { id: project.id, name: project.name, baseUrl: project.baseUrl } : null,
      tab,
      go: (k) => setParams({ tab: k }),
      badges: stats ? { bugs: stats.counts.bugsOpen, gaps: stats.counts.gapsSuggested } : undefined,
    })
    // Leaving the project must clear the sidebar, or it keeps showing the tabs
    // of a project nobody is looking at any more.
    return () => onNav({ project: null, tab: 'overview', go: () => {} })
  }, [onNav, project, tab, stats, setParams])

  if (loading && !project) return <Skeleton rows={4} />
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (!project) return null

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink2">{PROJECT_TABS.find((t) => t.key === tab)?.label}</p>
          <h1 className="truncate text-2xl font-bold text-ink">{project.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a href={project.baseUrl} target="_blank" rel="noreferrer" className="link text-sm">
              {project.baseUrl}
            </a>
            {project.hasSavedLogin && <Badge status="ok">login session saved</Badge>}
            {project.resetUrl && <Badge status="suggested">reset hook</Badge>}
            {project.parallel === false && <Badge status="queued">runs one at a time</Badge>}
          </div>
        </div>
      </header>

      {tab === 'overview' && <OverviewTab project={project} tick={tick} onGo={go} />}
      {tab === 'requirements' && <RequirementsTab project={project} onChange={reload} />}
      {tab === 'tests' && <TestCasesTab project={project} onChange={reload} />}
      {tab === 'runs' && <RunsTab project={project} tick={tick} />}
      {tab === 'coverage' && <CoverageTab project={project} />}
      {tab === 'gaps' && <GapsTab project={project} onChange={reload} />}
      {tab === 'bugs' && <BugsTab project={project} tick={tick} />}
      {tab === 'inventory' && <AppMapTab project={project} />}
      {tab === 'settings' && <SettingsTab project={project} onChange={reload} />}
    </div>
  )
}
