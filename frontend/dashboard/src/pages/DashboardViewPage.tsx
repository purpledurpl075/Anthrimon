import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Pencil, Plus, MoreVertical, Star, Copy, Share2, Trash2, MonitorPlay, RefreshCw,
} from 'lucide-react'
import { DashboardGrid } from '../components/DashboardGrid'
import { useDashboardWidgets, findWidgetDef, METRIC_WIDGET_DEFS, type DashboardWidgetDef } from '../hooks/useDashboardWidgets'
import { WIDGET_DEFS } from '../hooks/useDashboardLayout'
import { WidgetConfigModal } from '../components/widgets'
import { cloneDashboard, deleteDashboard, type MetricWidgetConfig } from '../api/dashboards'
import { useRole, hasRole } from '../hooks/useCurrentUser'

const TIME_RANGES = [
  { value: '15m', label: '15 minutes' },
  { value: '1h',  label: '1 hour' },
  { value: '6h',  label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '7d',  label: '7 days' },
]

const REFRESH_INTERVALS = [
  { value: 0,   label: 'Off' },
  { value: 30,  label: '30s' },
  { value: 60,  label: '1m' },
  { value: 300, label: '5m' },
]

const selectCls = 'text-xs border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed bg-white'

// ── Add widget menu ───────────────────────────────────────────────────────────

function AddWidgetMenu({ availableSummary, onAddSummary, onAddGeneric, onClose }: {
  availableSummary: DashboardWidgetDef[]
  onAddSummary: (type: string) => void
  onAddGeneric: (type: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-2 w-72 max-h-[70vh] overflow-y-auto"
      onMouseLeave={onClose}
    >
      <div className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Generic widgets</div>
      {METRIC_WIDGET_DEFS.map(d => (
        <button key={d.id} onClick={() => onAddGeneric(d.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-2">
          <Plus className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-700">{d.label}</p>
            <p className="text-[10px] text-slate-400 leading-snug">{d.description}</p>
          </div>
        </button>
      ))}
      {availableSummary.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 mt-1 border-t border-slate-100 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Summary widgets</div>
          {availableSummary.map(d => (
            <button key={d.id} onClick={() => onAddSummary(d.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-start gap-2">
              <Plus className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-700">{d.label}</p>
                <p className="text-[10px] text-slate-400 leading-snug">{d.description}</p>
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface ModalState {
  mode: 'add' | 'edit'
  type: string
  instanceId?: string
  initialConfig: MetricWidgetConfig
}

export default function DashboardViewPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const role = useRole()
  const canShare = hasRole(role, 'operator')

  const {
    dashboard, isLoading, widgets, timeRange, refreshIntervalS,
    addWidget, removeWidget, updateWidgetConfig, updateFromRGL,
    setTimeRange, setRefreshInterval, rename, setShared, setDefault, flush,
  } = useDashboardWidgets(id)

  const [isEditing, setIsEditing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [modal, setModal] = useState<ModalState | null>(null)

  const cloneMut = useMutation({
    mutationFn: () => cloneDashboard(id),
    onSuccess: d => { qc.invalidateQueries({ queryKey: ['dashboards'] }); navigate(`/dashboards/${d.id}`) },
  })
  const deleteMut = useMutation({
    mutationFn: () => deleteDashboard(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dashboards'] }); navigate('/dashboards') },
  })

  if (isLoading || !dashboard) {
    return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  }

  const canEdit = dashboard.can_edit

  const startRename = () => { setNameValue(dashboard.name); setRenaming(true) }
  const commitRename = () => {
    const name = nameValue.trim()
    setRenaming(false)
    if (name && name !== dashboard.name) rename(name)
  }

  const toggleEdit = () => {
    if (isEditing) flush()
    setIsEditing(e => !e)
  }

  const existingSummaryTypes = new Set(
    widgets.filter(w => !findWidgetDef(w.type)?.isMetric).map(w => w.type),
  )
  const availableSummary = WIDGET_DEFS.filter(d => !existingSummaryTypes.has(d.id))

  const openConfigure = (instanceId: string) => {
    const widget = widgets.find(w => w.instance_id === instanceId)
    if (!widget) return
    setModal({ mode: 'edit', type: widget.type, instanceId, initialConfig: widget.config ?? {} })
  }

  const handleModalSave = (config: MetricWidgetConfig) => {
    if (!modal) return
    if (modal.mode === 'add') addWidget(modal.type, config)
    else if (modal.instanceId) updateWidgetConfig(modal.instanceId, config)
    setModal(null)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0 gap-4">
        <div className="min-w-0 flex-1">
          <Link to="/dashboards" className="flex items-center gap-1 text-xs text-slate-400 hover:text-blue-600 transition-colors mb-0.5">
            <ArrowLeft className="w-3 h-3" /> Dashboards
          </Link>
          <div className="flex items-center gap-2 flex-wrap">
            {renaming ? (
              <input
                autoFocus value={nameValue}
                onChange={e => setNameValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
                onBlur={commitRename}
                className="text-base font-semibold text-slate-800 border border-blue-300 rounded-lg px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <h1 className="text-base font-semibold text-slate-800 truncate">{dashboard.name}</h1>
            )}
            {canEdit && !renaming && (
              <button onClick={startRename} title="Rename" className="text-slate-300 hover:text-slate-500 transition-colors">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {dashboard.is_shared && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600 border border-blue-100">
                <Share2 className="w-2.5 h-2.5" /> Shared
              </span>
            )}
            {dashboard.is_default && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-100">
                <Star className="w-2.5 h-2.5" /> Default
              </span>
            )}
            {!canEdit && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-50 text-slate-500 border border-slate-200">
                Read only
              </span>
            )}
          </div>
          {dashboard.description && <p className="text-xs text-slate-400 mt-0.5 truncate">{dashboard.description}</p>}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <select value={timeRange} onChange={e => setTimeRange(e.target.value)} disabled={!canEdit} className={selectCls} title="Time range">
            {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <select value={refreshIntervalS} onChange={e => setRefreshInterval(Number(e.target.value))} disabled={!canEdit} className={selectCls} title="Refresh interval">
            {REFRESH_INTERVALS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button onClick={() => qc.invalidateQueries()} title="Refresh now"
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => navigate(`/dashboards/kiosk?ids=${id}&interval=30`)} title="Kiosk mode"
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            <MonitorPlay className="w-3.5 h-3.5" />
          </button>

          {canEdit && isEditing && (
            <div className="relative">
              <button onClick={() => setShowAddMenu(o => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add widget
              </button>
              {showAddMenu && (
                <AddWidgetMenu
                  availableSummary={availableSummary}
                  onAddSummary={type => { addWidget(type); setShowAddMenu(false) }}
                  onAddGeneric={type => { setModal({ mode: 'add', type, initialConfig: {} }); setShowAddMenu(false) }}
                  onClose={() => setShowAddMenu(false)}
                />
              )}
            </div>
          )}

          {canEdit && (
            <button onClick={toggleEdit}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                isEditing
                  ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                  : 'text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {isEditing ? 'Done' : 'Edit'}
            </button>
          )}

          <div className="relative">
            <button onClick={() => setShowOverflow(o => !o)}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
              <MoreVertical className="w-4 h-4" />
            </button>
            {showOverflow && (
              <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-1 w-48" onMouseLeave={() => setShowOverflow(false)}>
                <button onClick={() => { setShowOverflow(false); cloneMut.mutate() }}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                  <Copy className="w-3.5 h-3.5 text-slate-400" /> Clone
                </button>
                {canEdit && !dashboard.is_default && (
                  <button onClick={() => { setShowOverflow(false); setDefault(true) }}
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                    <Star className="w-3.5 h-3.5 text-slate-400" /> Set as default
                  </button>
                )}
                {canEdit && canShare && (
                  <button onClick={() => { setShowOverflow(false); setShared(!dashboard.is_shared) }}
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                    <Share2 className="w-3.5 h-3.5 text-slate-400" /> {dashboard.is_shared ? 'Unshare' : 'Share with tenant'}
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => { setShowOverflow(false); setConfirmDelete(true) }}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 border-t border-slate-100 mt-1">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        {isEditing && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-xl">
            <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <p className="text-xs text-slate-600">
              <span className="font-medium">Edit mode</span> — drag anywhere on a widget to move it, drag the
              bottom-right corner <span className="font-mono bg-white border border-slate-200 px-1 rounded text-[10px]">⤡</span> to resize.
              Hover a widget for export, configure, and remove actions.
            </p>
          </div>
        )}

        <DashboardGrid
          widgets={widgets}
          timeRange={timeRange}
          refreshIntervalS={refreshIntervalS}
          isEditing={isEditing}
          onLayoutChange={updateFromRGL}
          onRemoveWidget={removeWidget}
          onUpdateWidgetConfig={updateWidgetConfig}
          onConfigureWidget={openConfigure}
        />
      </div>

      {modal && (
        <WidgetConfigModal
          widgetType={modal.type}
          initialConfig={modal.initialConfig}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">Delete dashboard</h2>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-slate-600">
                Delete <span className="font-medium">{dashboard.name}</span>? This can't be undone.
              </p>
            </div>
            <div className="px-6 pb-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
              <button onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}
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
