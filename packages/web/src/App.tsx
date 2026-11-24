import { useEffect, useMemo, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  IconBugs,
  IconCoverage,
  IconGaps,
  IconMap,
  IconMenu,
  IconMoon,
  IconOverview,
  IconProjects,
  IconRequirements,
  IconRuns,
  IconSettings,
  IconSparkle,
  IconSun,
  IconTests,
  Logo,
} from './components/icons'
import { ToastProvider, useDarkMode } from './components/ui'
import { PROJECT_TABS, ProjectNavContext, type ProjectNav, type TabKey } from './nav'
import BugPage from './pages/BugPage'
import ProjectPage from './pages/ProjectPage'
import ProjectsPage from './pages/ProjectsPage'
import RunPage from './pages/RunPage'
import SettingsPage from './pages/SettingsPage'

const TAB_ICONS: Record<TabKey, (p: { size?: number }) => JSX.Element> = {
  overview: IconOverview,
  tests: IconTests,
  runs: IconRuns,
  coverage: IconCoverage,
  gaps: IconGaps,
  bugs: IconBugs,
  requirements: IconRequirements,
  inventory: IconMap,
  settings: IconSettings,
}

export default function App() {
  const [dark, toggleDark] = useDarkMode()
  const [nav, setNav] = useState<ProjectNav>({ project: null, tab: 'overview', go: () => {} })
  const [open, setOpen] = useState(false)
  const location = useLocation()

  // The sidebar is a sheet on a phone; moving to another page closes it.
  useEffect(() => setOpen(false), [location.pathname, location.search])

  const value = useMemo(() => nav, [nav])

  return (
    <ToastProvider>
      <ProjectNavContext.Provider value={value}>
        <div className="min-h-screen lg:flex">
          <Sidebar nav={nav} open={open} onClose={() => setOpen(false)} />

          <div className="min-w-0 flex-1">
            <TopBar dark={dark} onToggleTheme={toggleDark} onMenu={() => setOpen((o) => !o)} />
            <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-4 sm:px-6">
              <Routes>
                <Route path="/" element={<ProjectsPage />} />
                <Route path="/projects/:id" element={<ProjectPage onNav={setNav} />} />
                <Route path="/runs/:id" element={<RunPage />} />
                <Route path="/bugs/:id" element={<BugPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<p className="text-sm text-ink2">That page does not exist.</p>} />
              </Routes>
            </main>
          </div>
        </div>
      </ProjectNavContext.Provider>
    </ToastProvider>
  )
}

function Sidebar({ nav, open, onClose }: { nav: ProjectNav; open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const project = nav.project

  return (
    <>
      {/* The dimmer behind the phone sheet. */}
      {open && <button className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-label="Close the menu" />}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[272px] shrink-0 overflow-y-auto border-r border-line px-4 py-5 transition-transform
                    lg:static lg:z-auto lg:w-[252px] lg:translate-x-0
                    ${open ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ background: 'var(--side-grad)' }}
      >
        <NavLink to="/" className="mb-6 flex items-center gap-2.5 px-2 text-[17px] font-bold tracking-tight text-ink">
          <Logo />
          TestPilot
        </NavLink>

        {project && (
          <>
            <button
              onClick={() => navigate('/')}
              className="card-raise mb-4 flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:brightness-[1.04]"
              title="Switch project"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent text-[13px] font-bold text-white">
                {project.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink">{project.name}</span>
                <span className="block truncate text-[11px] text-ink2">{project.baseUrl.replace(/^https?:\/\//, '')}</span>
              </span>
            </button>

            <nav className="space-y-0.5">
              {PROJECT_TABS.map((t) => {
                const Icon = TAB_ICONS[t.key]
                const active = nav.tab === t.key
                const badge = nav.badges?.[t.key]
                return (
                  <button
                    key={t.key}
                    onClick={() => nav.go(t.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-ctl px-3 py-2.5 text-left text-sm font-medium transition
                                ${active ? 'bg-accent text-white' : 'text-ink2 hover:bg-raise hover:text-ink'}`}
                  >
                    <Icon size={17} />
                    <span className="flex-1 truncate">{t.label}</span>
                    {badge ? (
                      <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${active ? 'bg-white/25 text-white' : 'bg-raise text-ink2'}`}>{badge}</span>
                    ) : null}
                  </button>
                )
              })}
            </nav>
          </>
        )}

        <div className={project ? 'mt-6' : ''}>
          <p className="label px-3">Workspace</p>
          <nav className="space-y-0.5">
            <SideLink to="/" icon={<IconProjects size={17} />} label="Projects" />
            <SideLink to="/settings" icon={<IconSparkle size={17} />} label="AI settings" />
          </nav>
        </div>

        {project && (
          <div className="relative mt-6 overflow-hidden rounded-card p-4" style={{ background: 'var(--card-grad)', boxShadow: 'var(--card-shadow)' }}>
            <span className="orb -right-6 -top-8 h-24 w-24" style={{ background: '#5C5FC8' }} />
            <p className="relative text-[13px] font-semibold text-ink">Explore my app</p>
            <p className="relative mt-1 text-[12px] leading-snug text-ink2">
              TestPilot walks the application and learns its forms, fields and the rules it states, so it can design tests for them.
            </p>
            <button className="btn-primary btn-sm relative mt-3 w-full" onClick={() => nav.go('inventory')}>
              Open the app map
            </button>
          </div>
        )}
      </aside>
    </>
  )
}

function SideLink({ to, icon, label }: { to: string; icon: JSX.Element; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-ctl px-3 py-2.5 text-sm font-medium transition ${
          isActive ? 'bg-accent text-white' : 'text-ink2 hover:bg-raise hover:text-ink'
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  )
}

function TopBar({ dark, onToggleTheme, onMenu }: { dark: boolean; onToggleTheme: () => void; onMenu: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 sm:px-6" style={{ background: 'rgb(var(--page) / 0.85)', backdropFilter: 'blur(12px)' }}>
      <button className="btn-ghost btn-sm lg:hidden" onClick={onMenu} aria-label="Open the menu">
        <IconMenu />
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn-ghost btn-sm" onClick={onToggleTheme} aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}>
          {dark ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  )
}
