import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchMaintenanceWindows, createMaintenanceWindow, deleteMaintenanceWindow, type MaintenanceWindow } from '../api/maintenance'
import { fetchDevices } from '../api/devices'
import { useRole, hasRole } from '../hooks/useCurrentUser'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function windowStatus(w: MaintenanceWindow): 'active' | 'upcoming' | 'expired' {
  const now   = Date.now()
  const start = new Date(w.starts_at).getTime()
  const end   = new Date(w.ends_at).getTime()
  if (w.is_recurring) return 'active'
  if (now >= start && now <= end) return 'active'
  if (now < start) return 'upcoming'
  return 'expired'
}

const STATUS_STYLE = {
  active:   'bg-amber-100 text-amber-700',
  upcoming: 'bg-blue-50 text-blue-600',
  expired:  'bg-slate-100 text-slate-400',
}

function FInput({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

// ── Create modal ───────────────────────────────────────────────────────────────

interface CreateWindowForm {
  name: string; starts_at: string; ends_at: string
  is_recurring: boolean; recurrence_cron: string
  target: 'all' | 'device'; device_id: string
}

function CreateWindowModal({ devices, onClose }: {
  devices: { id: string; hostname: string; fqdn: string | null }[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [f, setF] = useState<CreateWindowForm>({
    name: '', starts_at: '', ends_at: '',
    is_recurring: false, recurrence_cron: '',
    target: 'all', device_id: '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof CreateWindowForm, v: unknown) => setF(p => ({ ...p, [k]: v }))

  const mut = useMutation({
    mutationFn: () => {
      if (!f.name.trim()) throw new Error('Name is required')
      if (!f.starts_at) throw new Error('Start time is required')
      if (!f.ends_at) throw new Error('End time is required')
      if (new Date(f.ends_at) <= new Date(f.starts_at)) throw new Error('End time must be after start time')
      if (f.target === 'device' && !f.device_id) throw new Error('Select a device or choose "All devices"')
      if (f.is_recurring && !f.recurrence_cron.trim()) throw new Error('Cron expression is required for recurring windows')
      return createMaintenanceWindow({
        name:            f.name,
        starts_at:       f.starts_at,
        ends_at:         f.ends_at,
        is_recurring:    f.is_recurring,
        recurrence_cron: f.is_recurring ? f.recurrence_cron || null : null,
        device_selector: f.target === 'device' && f.device_id ? { device_ids: [f.device_id] } : null,
      })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maint-global'] }); onClose() },
    onError:   (e: any) => {
      const detail = e?.response?.data?.detail
      setError(Array.isArray(detail) ? detail.map((d: any) => d?.msg ?? String(d)).join('; ') : typeof detail === 'string' ? detail : e?.message ?? 'Failed to create')
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Schedule maintenance window</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-3">
          <FInput label="Name" value={f.name} onChange={v => set('name', v)} placeholder="e.g. Core switch upgrade" />

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Applies to</label>
            <select value={f.target} onChange={e => set('target', e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">All devices</option>
              <option value="device">Specific device</option>
            </select>
          </div>

          {f.target === 'device' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Device</label>
              <select value={f.device_id} onChange={e => set('device_id', e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select device…</option>
                {devices.map(d => <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FInput label="Starts at" value={f.starts_at} onChange={v => set('starts_at', v)} type="datetime-local" />
            <FInput label="Ends at"   value={f.ends_at}   onChange={v => set('ends_at', v)}   type="datetime-local" />
          </div>

          <div className="flex items-center gap-2">
            <input type="checkbox" id="recurring" checked={f.is_recurring}
              onChange={e => set('is_recurring', e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            <label htmlFor="recurring" className="text-xs text-slate-600">Recurring (cron)</label>
          </div>

          {f.is_recurring && (
            <FInput label="Cron expression" value={f.recurrence_cron} onChange={v => set('recurrence_cron', v)}
              placeholder="0 2 * * 0  (every Sunday at 2am)" />
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-6 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending}
            className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
            {mut.isPending ? 'Saving…' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function MaintenancePage() {
  const qc = useQueryClient()
  const role   = useRole()
  const canAct = hasRole(role, 'operator')
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'upcoming' | 'expired'>('all')

  const { data: windows = [], isLoading } = useQuery<MaintenanceWindow[]>({
    queryKey:        ['maint-global'],
    queryFn:         () => fetchMaintenanceWindows(),
    refetchInterval: 30_000,
  })

  const { data: devicesResp } = useQuery({
    queryKey: ['devices'],
    queryFn:  () => fetchDevices({ limit: 500 }),
  })
  const devices     = (devicesResp as any)?.items ?? devicesResp ?? []
  const deviceById  = Object.fromEntries((devices as any[]).map((d: any) => [d.id, d]))

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMaintenanceWindow(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['maint-global'] }); setConfirmDel(null) },
  })

  const sorted = [...windows].sort((a, b) => {
    const order = { active: 0, upcoming: 1, expired: 2 }
    return order[windowStatus(a)] - order[windowStatus(b)] ||
           new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
  })
  const filtered = filter === 'all' ? sorted : sorted.filter(w => windowStatus(w) === filter)
  const counts = {
    active:   windows.filter(w => windowStatus(w) === 'active').length,
    upcoming: windows.filter(w => windowStatus(w) === 'upcoming').length,
    expired:  windows.filter(w => windowStatus(w) === 'expired').length,
  }

  function targetLabel(w: MaintenanceWindow): string {
    const sel = w.device_selector as any
    if (!sel || Object.keys(sel).length === 0) return 'All devices'
    const ids: string[] = sel.device_ids ?? []
    if (ids.length === 1) {
      const d = deviceById[ids[0]] as any
      return d ? (d.fqdn ?? d.hostname) : ids[0].slice(0, 8) + '…'
    }
    return `${ids.length} devices`
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Maintenance Windows</h1>
          <p className="text-xs text-slate-400 mt-0.5">Active windows suppress all alerts for covered devices</p>
        </div>
        {canAct && (
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
            New window
          </button>
        )}
      </div>

      <div className="px-6 py-5 max-w-5xl">
        {/* Filter pills */}
        <div className="flex items-center gap-2 mb-4">
          {(['all', 'active', 'upcoming', 'expired'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                filter === f ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
              }`}>
              {f === 'all' ? `All (${windows.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f]})`}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="text-slate-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
            <p className="text-slate-400 text-sm">No {filter === 'all' ? '' : filter} maintenance windows.</p>
            {canAct && filter === 'all' && (
              <button onClick={() => setShowCreate(true)} className="mt-3 text-sm text-blue-600 hover:underline">
                Schedule your first window
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Applies to</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Schedule</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map(w => {
                  const status = windowStatus(w)
                  return (
                    <tr key={w.id} className={`transition-colors ${status === 'active' ? 'bg-amber-50/60' : 'hover:bg-slate-50'}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{w.name}</div>
                        {w.description && <div className="text-xs text-slate-400 mt-0.5">{w.description}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{targetLabel(w)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {w.is_recurring ? (
                          <div>
                            <span className="inline-flex items-center gap-1 text-purple-600 font-medium">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15" /></svg>
                              Recurring
                            </span>
                            <div className="font-mono text-slate-400 mt-0.5">{w.recurrence_cron}</div>
                            {w.next_fire_at && (
                              <div className="flex items-center gap-1 mt-1 text-slate-400">
                                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>
                                Next: {fmtDateTime(w.next_fire_at)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div>
                            <div>{fmtDateTime(w.starts_at)}</div>
                            <div className="text-slate-400">→ {fmtDateTime(w.ends_at)}</div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLE[status]}`}>
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canAct && (confirmDel === w.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => deleteMut.mutate(w.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                            <button onClick={() => setConfirmDel(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirmDel(w.id)}
                            className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" /></svg>
                          </button>
                        ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <CreateWindowModal devices={devices as any} onClose={() => setShowCreate(false)} />
      )}
    </div>
  )
}
