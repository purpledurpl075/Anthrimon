import { useState, createContext, useContext, useRef, useEffect, useCallback } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'
import { hasRole } from '../hooks/useCurrentUser'
import { useTheme, type Theme } from '../hooks/useTheme'
import { fetchSearch, type SearchResult, type ResultType } from '../api/search'

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
const I = {
  grid:        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  monitor:     <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  topology:    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>,
  list:        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>,
  search:      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  bell:        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  rules:       <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4"/></svg>,
  policies:    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/></svg>,
  key:         <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  settings:    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  calendar:    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  flow:        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  syslog:      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h6"/></svg>,
  config:      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
  bgp:         <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 12h5m5-5.5-5 5m0 1 5 5"/></svg>,
  collectors:  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  // Observability section icon — activity/pulse
  observability: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  // Analysis section icon — magnifier + chart
  analysis:    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m7 16 4-4 4 4 4-6"/></svg>,
  // Alerting section icon — shield with exclamation
  alerting:    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></svg>,
  wiki:        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  logout:      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  chevronDown: <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>,
  chevronLeft: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>,
  chevronRight:<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>,
  platform:    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  users:       <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
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
      // Force full reload so all queries re-fetch with the new token context
      window.location.href = '/'
    } catch {
      setSwitching(false)
    }
  }

  const filtered = tenants.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  )

  const otherTenants = filtered.filter(t => t.id !== activeTenantId)

  return (
    <div ref={ref} className="relative px-2.5 pt-2 pb-1">
      <button
        onClick={() => canSwitch ? setOpen(o => !o) : undefined}
        className={`w-full flex items-center gap-1.5 group rounded-md px-0.5 py-0.5 transition-colors ${
          canSwitch ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default'
        }`}
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

// ── Theme toggle ───────────────────────────────────────────────────────────
const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light:  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>,
  dark:   <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  system: <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
}
const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme()
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]

  return (
    <button
      onClick={() => setTheme(next)}
      title={collapsed ? `Theme: ${THEME_LABEL[theme]}` : undefined}
      className={`flex items-center w-full rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all ${
        collapsed ? 'justify-center px-0 py-2.5 mx-1' : 'gap-2.5 px-2.5 py-2'
      }`}
    >
      {THEME_ICONS[theme]}
      {!collapsed && (
        <span className="flex-1 text-left">
          {THEME_LABEL[theme]}
        </span>
      )}
    </button>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────
export default function Sidebar() {
  const navigate  = useNavigate()
  const location  = useLocation()

  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  )

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('sidebar-collapsed', String(next))
  }

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false })
  const { data: openAlerts } = useQuery({
    queryKey: ['alert-count'],
    queryFn: fetchAlertCount,
    refetchInterval: 30_000,
    retry: false,
  })

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
              <button onClick={toggle} title="Expand sidebar"
                className="p-1 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/5 transition-colors">
                {I.chevronRight}
              </button>
            </div>
          )}

          {!collapsed && (
            <button onClick={toggle} title="Collapse sidebar"
              className="p-1 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/5 transition-colors shrink-0">
              {I.chevronLeft}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className={`flex-1 py-3 overflow-y-auto overflow-x-hidden ${collapsed ? 'px-0 space-y-0.5' : 'px-3 space-y-0'}`}>

          {/* Global search */}
          <SidebarSearch collapsed={collapsed} />

          {/* Tenant switcher */}
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

          {/* Overview — standalone home item */}
          <Item to="/" label="Overview" icon={I.grid} end />

          {/* Network — infrastructure */}
          <Section label="Network" icon={I.topology}>
            <Item to="/devices"   label="Devices"   icon={I.monitor} />
            <Item to="/topology"  label="Topology"  icon={I.topology} />
            <Item to="/addresses" label="Addresses" icon={I.list} />
            <Item to="/discover"  label="Discover"  icon={I.search} />
          </Section>

          {/* Observability — live operational telemetry */}
          <Section label="Observability" icon={I.observability}>
            <Item to="/alerts"  label="Alerts"  icon={I.bell}   badge={openAlerts} />
            <Item to="/flow"    label="Flow"    icon={I.flow} />
            <Item to="/syslog"  label="Logging" icon={I.syslog} />
          </Section>

          {/* Analysis — deeper investigation */}
          <Section label="Analysis" icon={I.analysis}>
            <Item to="/routing" label="Routing" icon={I.bgp} />
            <Item to="/config"  label="Config"  icon={I.config} />
          </Section>

          {/* Alerting — alert management / policy authoring */}
          <Section label="Alerting" icon={I.alerting}>
            <Item to="/alert-rules"  label="Alert Rules"  icon={I.rules} />
            <Item to="/policies"     label="Policies"     icon={I.policies} />
            <Item to="/maintenance"  label="Maintenance"  icon={I.calendar} />
          </Section>

          {/* System — credentials, collectors, admin */}
          <Section label="System" icon={I.settings} defaultOpen={false}>
            <Item to="/credentials" label="Credentials" icon={I.key} />
            <Item to="/collectors"  label="Collectors"  icon={I.collectors} />
            <Item to="/wiki"        label="Wiki"         icon={I.wiki} />
            {(hasRole(me?.role ?? 'readonly', 'admin') || me?.is_platform_admin) && (
              <Item to="/users" label="Users" icon={I.users} />
            )}
            {hasRole(me?.role ?? 'readonly', 'admin') && (
              <Item to="/admin" label="Administration" icon={I.settings} />
            )}
          </Section>

          {/* Platform — only for platform admins */}
          {me?.is_platform_admin && (
            <Section label="Platform" icon={I.platform} defaultOpen={false}>
              <Item to="/platform" label="Platform Admin" icon={I.platform} />
            </Section>
          )}

        </nav>

        {/* Account / footer */}
        <div className={`border-t border-slate-800 py-3 space-y-0.5 ${collapsed ? 'px-0' : 'px-3'}`}>
          <ThemeToggle collapsed={collapsed} />
          <NavLink to="/account"
            title={collapsed ? (me?.username ?? 'Account') : undefined}
            className={`flex items-center rounded-lg text-sm transition-all ${
              collapsed ? 'justify-center px-0 py-2.5 mx-1' : 'gap-2.5 px-2.5 py-2'
            } ${
              location.pathname === '/account' ? 'bg-blue-950/60 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
              location.pathname === '/account' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'
            }`}>
              {(me?.username ?? 'U').slice(0, 2).toUpperCase()}
            </span>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs font-medium leading-none mb-0.5">{me?.username ?? 'Account'}</div>
                {me?.role && <div className="text-[10px] text-slate-500 capitalize leading-none">{me.role}</div>}
              </div>
            )}
          </NavLink>

          <button title={collapsed ? 'Sign out' : undefined}
            onClick={() => { localStorage.removeItem('token'); navigate('/login') }}
            className={`flex items-center w-full rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all ${
              collapsed ? 'justify-center px-0 py-2.5 mx-1' : 'gap-2.5 px-2.5 py-2'
            }`}
          >
            {I.logout}
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>
    </CollapsedCtx.Provider>
  )
}
