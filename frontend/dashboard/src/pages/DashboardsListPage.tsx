import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  Plus, MoreVertical, Star, Copy, Pencil, Share2, Trash2, MonitorPlay,
  ChevronRight, ChevronDown, X, LayoutTemplate,
} from 'lucide-react'
import {
  fetchDashboards, fetchDashboardTemplates, createDashboard, updateDashboard,
  deleteDashboard, cloneDashboard, cloneTemplate,
  type Dashboard, type DashboardUpdate,
} from '../api/dashboards'
import { useRole, useCurrentUser, hasRole } from '../hooks/useCurrentUser'
import { formatAge } from '../components/widgets'
import { SkeletonCard } from '../components/Skeleton'

function uniqueName(base: string, existing: Dashboard[]): string {
  const names = new Set(existing.map(d => d.name))
  if (!names.has(base)) return base
  let i = 2
  while (names.has(`${base} (${i})`)) i++
  return `${base} (${i})`
}

// ── Kiosk launch modal ────────────────────────────────────────────────────────

function KioskModal({ dashboards, onClose }: { dashboards: Dashboard[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string[]>([])
  const [interval, setIntervalS] = useState(30)

  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  const launch = () => {
    if (selected.length === 0) return
    navigate(`/dashboards/kiosk?ids=${selected.join(',')}&interval=${Math.max(10, interval)}`)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Kiosk mode</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <p className="text-xs text-slate-500">Select dashboards to cycle through fullscreen.</p>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {dashboards.map(d => (
              <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-sm text-slate-700">
                <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                {d.name}
              </label>
            ))}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Interval per dashboard (seconds)</label>
            <input type="number" min={10} value={interval}
              onChange={e => setIntervalS(Math.max(10, Number(e.target.value) || 10))}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
          <button onClick={launch} disabled={selected.length === 0}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5">
            <MonitorPlay className="w-4 h-4" /> Launch
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardsListPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const role = useRole()
  const { data: me } = useCurrentUser()
  const canShare = hasRole(role, 'operator')

  const [showNewMenu, setShowNewMenu] = useState(false)
  const [showKiosk, setShowKiosk] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<Dashboard | null>(null)

  const { data: dashboards = [], isLoading } = useQuery({ queryKey: ['dashboards'], queryFn: fetchDashboards })
  const { data: templates = [] } = useQuery({ queryKey: ['dashboard-templates'], queryFn: fetchDashboardTemplates, staleTime: 300_000 })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dashboards'] })

  const createMut   = useMutation({ mutationFn: (name: string) => createDashboard({ name }), onSuccess: d => { invalidate(); navigate(`/dashboards/${d.id}`) } })
  const templateMut = useMutation({ mutationFn: (key: string) => cloneTemplate(key), onSuccess: d => { invalidate(); navigate(`/dashboards/${d.id}`) } })
  const cloneMut    = useMutation({ mutationFn: cloneDashboard, onSuccess: invalidate })
  const deleteMut   = useMutation({ mutationFn: deleteDashboard, onSuccess: () => { invalidate(); setConfirmDelete(null) } })
  const patchMut    = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: DashboardUpdate }) => updateDashboard(id, patch), onSuccess: invalidate })

  const startRename = (d: Dashboard) => { setRenamingId(d.id); setRenameValue(d.name); setOpenMenuId(null) }
  const commitRename = (id: string) => {
    const name = renameValue.trim()
    setRenamingId(null)
    if (name) patchMut.mutate({ id, patch: { name } })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Dashboards</h1>
          <p className="text-xs text-slate-400 mt-0.5">Build and share custom layouts of widgets, gauges, and graphs</p>
        </div>
        <div className="flex items-center gap-2">
          {dashboards.length > 0 && (
            <button onClick={() => setShowKiosk(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
              <MonitorPlay className="w-3.5 h-3.5" /> Kiosk mode
            </button>
          )}
          <div className="relative">
            <button onClick={() => setShowNewMenu(o => !o)}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
              <Plus className="w-3.5 h-3.5" /> New dashboard <ChevronDown className="w-3 h-3" />
            </button>
            {showNewMenu && (
              <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-2 w-64"
                onMouseLeave={() => setShowNewMenu(false)}>
                <button
                  onClick={() => { setShowNewMenu(false); createMut.mutate(uniqueName('New Dashboard', dashboards)) }}
                  className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5 text-slate-400" /> Blank dashboard
                </button>
                {templates.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-1 mt-1 border-t border-slate-100 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Templates</div>
                    {templates.map(t => (
                      <button key={t.key}
                        onClick={() => { setShowNewMenu(false); templateMut.mutate(t.key) }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-2"
                      >
                        <LayoutTemplate className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-700 truncate">{t.name}</p>
                          <p className="text-[10px] text-slate-400 leading-snug">{t.description}</p>
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} h="h-36" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {dashboards.map(d => {
              const mine = me ? d.user_id === me.id : false
              return (
                <div key={d.id} className="bg-white rounded-2xl border border-slate-200 p-5 hover:shadow-md transition-all flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {renamingId === d.id ? (
                        <input autoFocus value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitRename(d.id); if (e.key === 'Escape') setRenamingId(null) }}
                          onBlur={() => commitRename(d.id)}
                          className="w-full text-sm font-semibold text-slate-800 border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      ) : (
                        <Link to={`/dashboards/${d.id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors truncate block">
                          {d.name}
                        </Link>
                      )}
                      {d.description && <p className="text-xs text-slate-400 mt-1 line-clamp-2">{d.description}</p>}
                    </div>
                    <div className="relative shrink-0">
                      <button onClick={() => setOpenMenuId(o => o === d.id ? null : d.id)}
                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {openMenuId === d.id && (
                        <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-1 w-44"
                          onMouseLeave={() => setOpenMenuId(null)}>
                          {!d.is_default && (
                            <button onClick={() => { setOpenMenuId(null); patchMut.mutate({ id: d.id, patch: { is_default: true } }) }}
                              className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                              <Star className="w-3.5 h-3.5 text-slate-400" /> Set as default
                            </button>
                          )}
                          <button onClick={() => { setOpenMenuId(null); cloneMut.mutate(d.id) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                            <Copy className="w-3.5 h-3.5 text-slate-400" /> Clone
                          </button>
                          {d.can_edit && (
                            <>
                              <button onClick={() => startRename(d)}
                                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                                <Pencil className="w-3.5 h-3.5 text-slate-400" /> Rename
                              </button>
                              {canShare && (
                                <button onClick={() => { setOpenMenuId(null); patchMut.mutate({ id: d.id, patch: { is_shared: !d.is_shared } }) }}
                                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                                  <Share2 className="w-3.5 h-3.5 text-slate-400" /> {d.is_shared ? 'Unshare' : 'Share with tenant'}
                                </button>
                              )}
                              <button onClick={() => { setOpenMenuId(null); setConfirmDelete(d) }}
                                className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 border-t border-slate-100 mt-1">
                                <Trash2 className="w-3.5 h-3.5" /> Delete
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                      mine ? 'bg-slate-50 text-slate-500 border-slate-200' : 'bg-blue-50 text-blue-600 border-blue-100'
                    }`}>
                      {mine ? 'Yours' : `Shared by ${d.owner_name ?? 'another user'}`}
                    </span>
                    {d.is_default && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-100">
                        <Star className="w-2.5 h-2.5" /> Default
                      </span>
                    )}
                    {d.is_shared && mine && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600 border border-blue-100">
                        <Share2 className="w-2.5 h-2.5" /> Shared
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-400 mt-auto pt-2 border-t border-slate-100">
                    <span>Updated {formatAge(d.updated_at)}</span>
                    <Link to={`/dashboards/${d.id}`} className="text-blue-600 hover:underline flex items-center gap-1 font-medium">
                      Open <ChevronRight className="w-3 h-3" />
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showKiosk && <KioskModal dashboards={dashboards} onClose={() => setShowKiosk(false)} />}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">Delete dashboard</h2>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-slate-600">
                Delete <span className="font-medium">{confirmDelete.name}</span>? This can't be undone.
              </p>
            </div>
            <div className="px-6 pb-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
              <button onClick={() => deleteMut.mutate(confirmDelete.id)} disabled={deleteMut.isPending}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
