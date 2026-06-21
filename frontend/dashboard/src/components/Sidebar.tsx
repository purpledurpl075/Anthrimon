import { useState, createContext, useContext, useRef, useEffect, useCallback } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Star, Share2 } from 'lucide-react'
import api from '../api/client'
import { hasRole } from '../hooks/useCurrentUser'
import { useLicense } from '../hooks/useLicense'
import { MODERN_NAV } from '../icons'
import { useTheme, type Theme } from '../hooks/useTheme'
import { fetchSearch, type SearchResult, type ResultType } from '../api/search'
import { fetchDashboards } from '../api/dashboards'
import { licensedFeaturesIn } from '../features'

// ── Wiki index (loaded once) ───────────────────────────────────────────────
interface WikiEntry { slug: string; title: string; category: string; description: string }
let _wikiCache: WikiEntry[] | null = null
async function loadWikiIndex(): Promise<WikiEntry[]> {
  if (_wikiCache) return _wikiCache
  try {
    const r = await fetch('/wiki/index.json')
    _wikiCache = await r.json()
    return _wikiCache!
  } catch { return [] }
}

interface MeData {
  username: string
  role: string
  tenant_id: string
  tenant_name: string
  is_platform_admin: boolean
  platform_role: string | null
}
const fetchMe = () => api.get<MeData>('/auth/me').then(r => r.data)
const fetchAlertCount = () =>
  api.get<{ total: number }>('/alerts', { params: { status: 'open', limit: 1 } }).then(r => r.data.total)

// ── Collapse context ───────────────────────────────────────────────────────
const CollapsedCtx = createContext(false)

// ── Icons ──────────────────────────────────────────────────────────────────

/** Sidebar icon set. Components alias this to `I` locally so all existing
 *  `I.x` references resolve to the right icon. */
function useIcons(): Record<string, React.ReactNode> {
  return MODERN_NAV
}

// ── Sidebar search ─────────────────────────────────────────────────────────

type AnyResultType = ResultType | 'wiki'

const TYPE_LABEL: Record<AnyResultType, string> = {
  device:    'Device',
  interface: 'Interface',
  alert:     'Alert',
  bgp_peer:  'BGP',
  config:    'Config',
  address:   'Address',
  wiki:      'Wiki',
}

const TYPE_COLOR: Record<AnyResultType, string> = {
  device:    'bg-blue-100 text-blue-700',
  interface: 'bg-slate-100 text-slate-600',
  alert:     'bg-red-100 text-red-700',
  bgp_peer:  'bg-purple-100 text-purple-700',
  config:    'bg-green-100 text-green-700',
  address:   'bg-teal-100 text-teal-700',
  wiki:      'bg-amber-100 text-amber-700',
}

interface AnyResult extends Omit<SearchResult, 'type'> { type: AnyResultType }

const RECENT_KEY = 'search-recent'
const MAX_RECENT = 6

function getRecent(): SearchResult[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}
function saveRecent(r: SearchResult) {
  const prev = getRecent().filter(x => x.id !== r.id || x.type !== r.type)
  localStorage.setItem(RECENT_KEY, JSON.stringify([r, ...prev].slice(0, MAX_RECENT)))
}

function SidebarSearch({ collapsed }: { collapsed: boolean }) {
  const I = useIcons()
  const navigate  = useNavigate()
  const inputRef  = useRef<HTMLInputElement>(null)
  const panelRef  = useRef<HTMLDivElement>(null)

  const [open,    setOpen]    = useState(false)
  const [q,       setQ]       = useState('')
  const [debQ,    setDebQ]    = useState('')
  const [selIdx,  setSelIdx]  = useState(0)
  const [wikiIdx, setWikiIdx] = useState<WikiEntry[]>([])

  // Load wiki index once on mount
  useEffect(() => { loadWikiIndex().then(setWikiIdx) }, [])

  // Debounce input → debQ
  useEffect(() => {
    const t = setTimeout(() => setDebQ(q), 180)
    return () => clearTimeout(t)
  }, [q])

  // Reset selection when results change
  useEffect(() => { setSelIdx(0) }, [debQ])

  const { data } = useQuery({
    queryKey: ['search', debQ],
    queryFn: () => fetchSearch(debQ),
    enabled: debQ.trim().length > 0,
    staleTime: 5_000,
  })

  // Wiki search — client-side, case-insensitive on title + description
  const wikiResults: AnyResult[] = debQ.trim().length > 0
    ? wikiIdx
        .filter(w => {
          const lq = debQ.toLowerCase()
          return w.title.toLowerCase().includes(lq) || w.description.toLowerCase().includes(lq)
        })
        .slice(0, 3)
        .map(w => ({
          type: 'wiki' as const,
          id: w.slug,
          title: w.title,
          subtitle: w.category,
          url: `/wiki/${w.slug}`,
          meta: null,
        }))
    : []

  const apiResults: AnyResult[] = (data?.results ?? []) as AnyResult[]
  const allResults: AnyResult[] = debQ.trim() ? [...apiResults, ...wikiResults] : getRecent() as AnyResult[]
  const showRecent = debQ.trim().length === 0

  const pick = useCallback((r: AnyResult) => {
    saveRecent(r as SearchResult)
    setOpen(false)
    setQ('')
    setDebQ('')
    navigate(r.url)
  }, [navigate])

  // Keyboard navigation
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setSelIdx(i => Math.min(i + 1, allResults.length - 1)) }
    if (e.key === 'ArrowUp')    { e.preventDefault(); setSelIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && allResults[selIdx]) { pick(allResults[selIdx]) }
    if (e.key === 'Escape')     { setOpen(false); setQ('') }
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(true)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [])

  const resultItems = (
    <>
      {showRecent && allResults.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-slate-500">
          Start typing to search devices, interfaces, alerts, wiki…
        </div>
      )}
      {showRecent && allResults.length > 0 && (
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Recent</div>
      )}
      {!showRecent && allResults.length === 0 && debQ && (
        <div className="px-3 py-6 text-center text-xs text-slate-500">No results for "{debQ}"</div>
      )}
      {allResults.map((r, i) => (
        <button
          key={`${r.type}-${r.id}`}
          onMouseDown={e => { e.preventDefault(); pick(r) }}
          onMouseEnter={() => setSelIdx(i)}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
            i === selIdx ? 'bg-blue-600/30' : 'hover:bg-white/5'
          }`}
        >
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${TYPE_COLOR[r.type]}`}>
            {TYPE_LABEL[r.type]}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-xs font-medium text-slate-200 truncate">{r.title}</span>
            {r.subtitle && <span className="block text-[10px] text-slate-400 truncate">{r.subtitle}</span>}
          </span>
          {r.meta && r.type === 'alert' && (
            <span className={`text-[9px] font-medium px-1 py-0.5 rounded flex-shrink-0 ${
              r.meta === 'critical' ? 'bg-red-900/50 text-red-400' :
              r.meta === 'major'    ? 'bg-orange-900/50 text-orange-400' :
              'bg-slate-700 text-slate-400'
            }`}>{r.meta}</span>
          )}
        </button>
      ))}
    </>
  )

  if (collapsed) {
    return (
      <div ref={panelRef}>
        <button
          onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50) }}
          title="Search (⌘K)"
          aria-label="Search (⌘K)"
          className="flex items-center justify-center w-full py-2.5 mx-0 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
        >
          {I.search}
        </button>

        {/* Floating panel anchored to the right of the collapsed sidebar */}
        {open && (
          <div className="fixed left-14 top-3 z-50 w-72">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border bg-slate-800 border-blue-500/50 shadow-xl">
              <span className="text-slate-500 shrink-0">{I.search}</span>
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                onFocus={() => setOpen(true)}
                onKeyDown={onKey}
                placeholder="Search…"
                autoFocus
                className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-500 outline-none min-w-0"
              />
              <button
                onMouseDown={e => { e.preventDefault(); setOpen(false); setQ(''); setDebQ('') }}
                aria-label="Close search"
                className="text-slate-500 hover:text-slate-300 shrink-0 text-xs"
              >✕</button>
            </div>
            <div className="mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden max-h-72 overflow-y-auto">
              {resultItems}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={panelRef} className="relative px-3 pb-1 pt-2">
      <div
        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-colors cursor-text ${
          open ? 'bg-slate-800 border-blue-500/50' : 'bg-slate-800/50 border-slate-700/50 hover:border-slate-600'
        }`}
        onClick={() => { setOpen(true); inputRef.current?.focus() }}
      >
        <span className="text-slate-500 shrink-0">{I.search}</span>
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="Search…"
          className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-500 outline-none min-w-0"
        />
        {!open && <span className="text-[9px] text-slate-600 font-mono shrink-0">⌘K</span>}
        {open && q && (
          <button
            onMouseDown={e => { e.preventDefault(); setQ(''); setDebQ(''); inputRef.current?.focus() }}
            aria-label="Clear search"
            className="text-slate-500 hover:text-slate-300 shrink-0 text-xs"
          >✕</button>
        )}
      </div>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden max-h-72 overflow-y-auto">
          {resultItems}
        </div>
      )}
    </div>
  )
}

// ── Tenant switcher ────────────────────────────────────────────────────────
interface TenantSummary { id: string; name: string; slug: string; is_active: boolean }

function TenantSwitcher({ me }: { me: MeData }) {
  const I = useIcons()
  const [open, setOpen]       = useState(false)
  const [search, setSearch]   = useState('')
  const ref                   = useRef<HTMLDivElement>(null)
  const inputRef              = useRef<HTMLInputElement>(null)
  const [switching, setSwitching] = useState(false)

  const { data: tenants = [] } = useQuery<TenantSummary[]>({
    queryKey: ['auth-tenants'],
    queryFn:  () => api.get<TenantSummary[]>('/auth/tenants').then(r => r.data),
    staleTime: 60_000,
  })

  const activeTenantId = (() => {
    try {
      const token = localStorage.getItem('token') ?? ''
      const payload = JSON.parse(atob(token.split('.')[1]))
      return payload.tid as string
    } catch { return me.tenant_id }
  })()

  const activeTenant    = tenants.find(t => t.id === activeTenantId) ??
    { id: me.tenant_id, name: me.tenant_name, slug: '', is_active: true }
  const canSwitch = me.is_platform_admin || tenants.length > 1

  useEffect(() => {
    if (!open) return
    setTimeout(() => inputRef.current?.focus(), 50)
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false); setSearch('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const switchTenant = async (tenantId: string) => {
    if (tenantId === activeTenantId) { setOpen(false); return }
    setSwitching(true)
    try {
      const resp = await api.post<{ access_token: string }>('/auth/switch-tenant', { tenant_id: tenantId })
      localStorage.setItem('token', resp.data.access_token)
      window.location.href = '/'
    } catch {
      setSwitching(false)
    }
  }

  if (!canSwitch) return null

  const filtered = tenants.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  )

  const otherTenants = filtered.filter(t => t.id !== activeTenantId)

  return (
    <div ref={ref} className="relative px-2.5 pt-2 pb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 group rounded-md px-0.5 py-0.5 transition-colors hover:bg-white/5 cursor-pointer"
      >
        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-[0.08em] truncate flex-1 text-left group-hover:text-slate-400 transition-colors">
          {activeTenant.name}
          {activeTenantId !== me.tenant_id && (
            <span className="ml-1 text-amber-400 normal-case tracking-normal font-normal">acting as</span>
          )}
        </p>
        {canSwitch && (
          <span className={`text-slate-600 group-hover:text-slate-500 transition-all duration-150 shrink-0 ${open ? 'rotate-180' : ''}`}>
            {I.chevronDown}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-slate-700/60">
            <div className="flex items-center gap-2 bg-slate-700/60 rounded-lg px-2.5 py-1.5">
              <svg className="w-3 h-3 text-slate-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Find organization…"
                className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-500 outline-none min-w-0"
              />
            </div>
          </div>

          {/* Current org */}
          <div className="p-2 space-y-0.5">
            <p className="px-2 pt-0.5 pb-1 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Current</p>
            <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-blue-600/15">
              <span className="w-5 h-5 rounded-md bg-blue-600/40 flex items-center justify-center text-[9px] font-bold text-blue-300 shrink-0">
                {activeTenant.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="text-xs font-medium text-slate-200 truncate flex-1">{activeTenant.name}</span>
              <svg className="w-3 h-3 text-blue-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path d="m20 6-11 11-5-5"/>
              </svg>
            </div>
          </div>

          {/* Other tenants */}
          {otherTenants.length > 0 ? (
            <div className="p-2 space-y-0.5 border-t border-slate-700/50 max-h-48 overflow-y-auto">
              <p className="px-2 pt-0.5 pb-1 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Switch to</p>
              {otherTenants.map(t => (
                <button
                  key={t.id}
                  onClick={() => switchTenant(t.id)}
                  disabled={switching}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-white/5 transition-colors text-left disabled:opacity-50"
                >
                  <span className="w-5 h-5 rounded-md bg-slate-600/60 flex items-center justify-center text-[9px] font-bold text-slate-400 shrink-0">
                    {t.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="text-xs font-medium text-slate-300 truncate flex-1">{t.name}</span>
                  {!t.is_active && (
                    <span className="text-[9px] text-slate-500 shrink-0">inactive</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-center border-t border-slate-700/50">
              <p className="text-[10px] text-slate-600">
                {search ? 'No matching organizations' : 'No other organizations'}
              </p>
            </div>
          )}

          {/* Return to home tenant */}
          {activeTenantId !== me.tenant_id && (
            <div className="p-2 border-t border-slate-700/50">
              <button
                onClick={() => switchTenant(me.tenant_id)}
                disabled={switching}
                className="w-full text-xs text-amber-400 hover:text-amber-300 py-1.5 text-center transition-colors disabled:opacity-50"
              >
                Return to home tenant
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Nav item ───────────────────────────────────────────────────────────────
function Item({ to, label, icon, end, badge, activeSearch }: {
  to: string; label: string; icon: React.ReactNode; end?: boolean; badge?: number
  activeSearch?: string
}) {
  const collapsed = useContext(CollapsedCtx)
  const location  = useLocation()
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined}
      className={({ isActive: pathActive }) => {
        const isActive = activeSearch != null
          ? new URLSearchParams(location.search).get('tab') === activeSearch
          : pathActive
        return `group relative flex items-center rounded-lg text-sm transition-all duration-150 ${
          collapsed ? 'justify-center px-0 py-2.5 mx-1' : 'gap-2.5 px-2.5 py-2'
        } ${
          isActive
            ? 'bg-blue-950/60 text-white'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        }`
      }}
    >
      {({ isActive: pathActive }) => {
        const isActive = activeSearch != null
          ? new URLSearchParams(location.search).get('tab') === activeSearch
          : pathActive
        return (
          <>
            {/* Active left-border accent */}
            {!collapsed && isActive && (
              <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-blue-400" />
            )}
            <span className={`shrink-0 transition-colors relative ${isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300'}`}>
              {icon}
              {/* Badge dot when collapsed */}
              {collapsed && badge != null && badge > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full ring-1 ring-slate-900" />
              )}
            </span>
            {!collapsed && <span className="flex-1 truncate font-[450]">{label}</span>}
            {!collapsed && badge != null && badge > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center leading-none tabular-nums">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </>
        )
      }}
    </NavLink>
  )
}

// ── Section ────────────────────────────────────────────────────────────────
function Section({ label, icon, defaultOpen = true, children }: {
  label: string
  icon?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const I = useIcons()
  const collapsed = useContext(CollapsedCtx)
  const [open, setOpen] = useState(defaultOpen)

  if (collapsed) {
    return (
      <div className="space-y-0.5">
        <div className="h-px bg-slate-800/80 mx-3 my-1.5" />
        {children}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-1 group rounded-md hover:bg-white/[0.03] transition-colors"
      >
        {icon && (
          <span className="text-slate-600 group-hover:text-slate-500 transition-colors shrink-0">
            {icon}
          </span>
        )}
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-[0.08em] group-hover:text-slate-400 transition-colors flex-1 text-left">
          {label}
        </span>
        <span className={`text-slate-600 transition-transform duration-200 shrink-0 ${open ? '' : '-rotate-90'}`}>
          {I.chevronDown}
        </span>
      </button>
      <div
        className="overflow-hidden transition-all duration-200"
        style={{ maxHeight: open ? '600px' : '0', opacity: open ? 1 : 0 }}
      >
        <div className="space-y-0.5 pb-1">{children}</div>
      </div>
    </div>
  )
}

// ── Dashboards nav item (with quick-access dropdown) ────────────────────────
function DashboardsNavItem() {
  const I = useIcons()
  const collapsed = useContext(CollapsedCtx)
  const location = useLocation()
  const [open, setOpen] = useState(false)

  const { data: dashboards } = useQuery({
    queryKey: ['dashboards'],
    queryFn: fetchDashboards,
    staleTime: 30_000,
    retry: false,
  })

  if (collapsed) {
    return <Item to="/dashboards" label="Dashboards" icon={I.dashboard} />
  }

  const isActive = location.pathname.startsWith('/dashboards')
  const items = dashboards ?? []
  const visible = items.slice(0, 8)
  const overflow = items.length - visible.length

  return (
    <div className="space-y-0.5">
      <div className={`group relative flex items-center rounded-lg text-sm transition-all duration-150 gap-1 px-2.5 py-2 ${
        isActive ? 'bg-blue-950/60 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
      }`}>
        {isActive && <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-blue-400" />}
        <NavLink to="/dashboards" className="flex items-center gap-2.5 flex-1 min-w-0">
          <span className={`shrink-0 transition-colors ${isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300'}`}>
            {I.dashboard}
          </span>
          <span className="flex-1 truncate font-[450]">Dashboards</span>
        </NavLink>
        {items.length > 0 && (
          <button
            onClick={() => setOpen(o => !o)}
            title={open ? 'Hide quick access' : 'Show quick access'}
            aria-label={open ? 'Hide dashboard quick access' : 'Show dashboard quick access'}
            className="p-1 -mr-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors shrink-0"
          >
            <span className={`inline-block transition-transform duration-200 ${open ? '' : '-rotate-90'}`}>
              {I.chevronDown}
            </span>
          </button>
        )}
      </div>

      {items.length > 0 && (
        <div
          className="overflow-hidden transition-all duration-200"
          style={{ maxHeight: open ? '600px' : '0', opacity: open ? 1 : 0 }}
        >
          <div className="space-y-0.5 pb-1 pl-6">
            {visible.map(d => (
              <NavLink
                key={d.id}
                to={`/dashboards/${d.id}`}
                className={({ isActive: linkActive }) =>
                  `flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors min-w-0 ${
                    linkActive ? 'bg-blue-950/60 text-white' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
                  }`
                }
              >
                {d.is_default
                  ? <Star className="w-3 h-3 text-amber-400 shrink-0" />
                  : d.is_shared
                    ? <Share2 className="w-3 h-3 text-blue-400 shrink-0" />
                    : <span className="w-3 h-3 shrink-0" />}
                <span className="truncate">{d.name}</span>
              </NavLink>
            ))}
            {overflow > 0 && (
              <NavLink to="/dashboards" className="flex items-center px-2 py-1.5 rounded-md text-xs text-slate-600 hover:text-slate-300 hover:bg-white/5 transition-colors">
                +{overflow} more…
              </NavLink>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Theme toggle ───────────────────────────────────────────────────────────
const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light:  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>,
  dark:   <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  system: <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
}
const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }


// ── Account popover ───────────────────────────────────────────────────────
function AccountPopover({ me, collapsed }: { me: MeData | undefined; collapsed: boolean }) {
  const I = useIcons()
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const isAccountActive = location.pathname === '/account'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title={collapsed ? (me?.username ?? 'Account') : undefined}
        className={`flex items-center w-full rounded-lg text-sm transition-all ${
          collapsed ? 'justify-center px-0 py-2.5 mx-1' : 'gap-2.5 px-2.5 py-2'
        } ${
          isAccountActive || open ? 'bg-blue-950/60 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        }`}
      >
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
          isAccountActive || open ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'
        }`}>
          {(me?.username ?? 'U').slice(0, 2).toUpperCase()}
        </span>
        {!collapsed && (
          <div className="flex-1 min-w-0 text-left">
            <div className="truncate text-xs font-medium leading-none mb-0.5">{me?.username ?? 'Account'}</div>
            {me?.role && <div className="text-[10px] text-slate-500 capitalize leading-none">{me.role}</div>}
          </div>
        )}
      </button>

      {open && (
        <div className={`absolute z-50 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden ${
          collapsed ? 'left-14 bottom-0 w-48' : 'left-0 right-0 bottom-full mb-1'
        }`}>
          {/* User info header */}
          <div className="px-3 py-2.5 border-b border-slate-700/60">
            <p className="text-xs font-medium text-slate-200 truncate">{me?.username ?? 'Account'}</p>
            {me?.role && <p className="text-[10px] text-slate-500 capitalize">{me.role}</p>}
          </div>

          <div className="py-1">
            {/* Account link */}
            <button
              onClick={() => { setOpen(false); navigate('/account') }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 transition-colors text-left"
            >
              {I.settings}
              <span>Account Settings</span>
            </button>

            {/* Theme toggle */}
            <button
              onClick={() => setTheme(nextTheme)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 transition-colors text-left"
            >
              {THEME_ICONS[theme]}
              <span>Theme: {THEME_LABEL[theme]}</span>
            </button>
          </div>

          {/* Sign out */}
          <div className="border-t border-slate-700/60 py-1">
            <button
              onClick={() => { localStorage.removeItem('token'); navigate('/login') }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-slate-400 hover:text-red-400 hover:bg-white/5 transition-colors text-left"
            >
              {I.logout}
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────
export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  )

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('sidebar-collapsed', String(next))
  }

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false })
  const I = useIcons()
  const { data: lic } = useLicense()
  const isLicensed = (key: string) =>
    !!lic?.valid && (lic.modules.includes('*') || lic.modules.includes(key))
  const { data: openAlerts } = useQuery({
    queryKey: ['alert-count'],
    queryFn: fetchAlertCount,
    refetchInterval: 30_000,
    retry: false,
  })

  const isAdmin = hasRole(me?.role ?? 'readonly', 'admin') || me?.is_platform_admin

  return (
    <CollapsedCtx.Provider value={collapsed}>
      <aside
        className="flex flex-col shrink-0 bg-slate-900 h-screen border-r border-slate-800 transition-all duration-200"
        style={{ width: collapsed ? 56 : 212 }}
      >
        {/* Brand + toggle */}
        <div className={`flex items-center border-b border-slate-800 ${collapsed ? 'justify-center py-4 px-0' : 'px-4 py-4 justify-between'}`}>
          {!collapsed && (
            <div className="flex items-center min-w-0">
              <img src="/logo-reversed.svg" alt="Anthrimon" className="h-8 w-auto" />
            </div>
          )}

          {collapsed && (
            <div className="flex flex-col items-center gap-2">
              <img src="/logo-icon.svg" alt="Anthrimon" className="w-8 h-8 rounded-lg" />
              <button onClick={toggle} title="Expand sidebar" aria-label="Expand sidebar"
                className="p-1 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/5 transition-colors">
                {I.chevronRight}
              </button>
            </div>
          )}

          {!collapsed && (
            <button onClick={toggle} title="Collapse sidebar" aria-label="Collapse sidebar"
              className="p-1 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/5 transition-colors shrink-0">
              {I.chevronLeft}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className={`flex-1 py-3 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-0 space-y-0.5' : 'px-3 space-y-0'}`}>

          {/* Global search */}
          <SidebarSearch collapsed={collapsed} />

          {/* Tenant switcher — self-hides for single-tenant users */}
          {!collapsed && me && (
            <TenantSwitcher me={me} />
          )}

          {/* Acting-as banner */}
          {!collapsed && me?.is_platform_admin && (() => {
            try {
              const token = localStorage.getItem('token') ?? ''
              const payload = JSON.parse(atob(token.split('.')[1]))
              if (payload.tid && payload.tid !== me.tenant_id) {
                return (
                  <div className="mx-2.5 mb-1 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                    <p className="text-[10px] text-amber-400 font-medium text-center">
                      Acting as another tenant
                    </p>
                  </div>
                )
              }
            } catch {}
            return null
          })()}

          {/* Dashboards — home item with quick-access dropdown */}
          <DashboardsNavItem />

          {/* Network — inventory & topology */}
          <Section label="Network" icon={I.topology}>
            <Item to="/devices"    label="Devices"    icon={I.monitor} />
            <Item to="/topology"   label="Topology"   icon={I.topology} />
            <Item to="/addresses"  label="Addresses"  icon={I.list} />
          </Section>

          {/* Operations — live telemetry, alerting, and diagnostics */}
          <Section label="Operations" icon={I.observability}>
            <Item to="/alerts"       label="Alerts"       icon={I.bell}      badge={openAlerts} />
            <Item to="/alert-rules"  label="Alert Rules"  icon={I.rules} />
            <Item to="/maintenance"  label="Maintenance"  icon={I.calendar} />
            <Item to="/flow"         label="Flow"         icon={I.flow} />
            <Item to="/syslog"       label="Logging"      icon={I.syslog} />
            <Item to="/path-trace"   label="Path Trace"   icon={I.pathTrace} />
            {licensedFeaturesIn('Monitoring', isLicensed).map(f => (
              <Item key={f.key} to={f.to} label={f.label} icon={I.observability} />
            ))}
          </Section>

          {/* Analysis — investigation & compliance */}
          <Section label="Analysis" icon={I.analysis}>
            <Item to="/routing"   label="Routing"    icon={I.bgp} />
            <Item to="/config"    label="Config"     icon={I.config} />
            <Item to="/policies"  label="Policies"   icon={I.policies} />
            <Item to="/changes"  label="Changes"    icon={I.changes} />
            {licensedFeaturesIn('Analysis', isLicensed).map(f => (
              <Item key={f.key} to={f.to} label={f.label} icon={I.analysis} />
            ))}
          </Section>

          {/* Admin — setup, governance, system */}
          <Section label="Admin" icon={I.settings} defaultOpen={false}>
            <Item to="/credentials" label="Credentials" icon={I.key} />
            <Item to="/collectors"  label="Collectors"  icon={I.collectors} />
            <Item to="/probes"      label="Probes"      icon={I.probes} />
            <Item to="/discover"    label="Discover"    icon={I.discover} />
            {isAdmin && (
              <Item to="/users" label="Users" icon={I.users} />
            )}
            {hasRole(me?.role ?? 'readonly', 'admin') && (
              <Item to="/audit" label="Audit Log" icon={I.auditLog} />
            )}
            {hasRole(me?.role ?? 'readonly', 'admin') && (
              <Item to="/platform-health" label="Platform Health" icon={I.health} />
            )}
            {hasRole(me?.role ?? 'readonly', 'admin') && (
              <Item to="/admin" label="Administration" icon={I.settings} />
            )}
            {me?.is_platform_admin && (
              <Item to="/platform" label="Platform Admin" icon={I.platform} />
            )}
          </Section>

        </nav>

        {/* Footer — Wiki + account popover */}
        <div className={`border-t border-slate-800 py-2 space-y-0.5 ${collapsed ? 'px-0' : 'px-3'}`}>
          <Item to="/wiki" label="Wiki" icon={I.wiki} />
          <AccountPopover me={me} collapsed={collapsed} />
        </div>
      </aside>
    </CollapsedCtx.Provider>
  )
}
