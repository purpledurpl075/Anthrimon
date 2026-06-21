import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  fetchChangeRequests, fetchChangeRequest, createChangeRequest,
  approveChangeRequest, rejectChangeRequest, executeChangeRequest,
  cancelChangeRequest,
} from '../api/changes'
import type { ChangeRequest, ChangeActionCreate } from '../api/changes'
import { fetchDevices } from '../api/devices'
import { useCurrentUser, useRole, hasRole } from '../hooks/useCurrentUser'
import { formatAge } from '../utils/time'

const STATUS_STYLE: Record<string, string> = {
  draft:             'bg-slate-100 text-slate-600',
  pending_approval:  'bg-amber-100 text-amber-700',
  approved:          'bg-blue-100 text-blue-700',
  rejected:          'bg-red-100 text-red-700',
  executing:         'bg-purple-100 text-purple-700',
  completed:         'bg-green-100 text-green-700',
  failed:            'bg-red-100 text-red-700',
  rolled_back:       'bg-orange-100 text-orange-700',
  cancelled:         'bg-slate-100 text-slate-500',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', pending_approval: 'Pending Approval', approved: 'Approved',
  rejected: 'Rejected', executing: 'Executing', completed: 'Completed',
  failed: 'Failed', rolled_back: 'Rolled Back', cancelled: 'Cancelled',
}

const ACTION_STATUS_STYLE: Record<string, string> = {
  pending:     'bg-slate-100 text-slate-500',
  running:     'bg-blue-100 text-blue-700 animate-pulse',
  completed:   'bg-green-100 text-green-700',
  failed:      'bg-red-100 text-red-700',
  skipped:     'bg-slate-100 text-slate-400',
  rolled_back: 'bg-orange-100 text-orange-700',
}

export default function ChangesPage() {
  const qc = useQueryClient()
  const role = useRole()
  const { data: me } = useCurrentUser()
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = searchParams.get('status') ?? ''
  const selectedId = searchParams.get('id')
  const [showCreate, setShowCreate] = useState(false)

  const { data: changes = [] } = useQuery({
    queryKey: ['changes', statusFilter],
    queryFn: () => fetchChangeRequests(statusFilter ? { status: statusFilter } : undefined),
    refetchInterval: 15_000,
  })

  const { data: detail } = useQuery({
    queryKey: ['change', selectedId],
    queryFn: () => fetchChangeRequest(selectedId!),
    enabled: !!selectedId,
    refetchInterval: 5_000,
  })

  const selectCR = (id: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id) next.set('id', id); else next.delete('id')
      return next
    })
  }

  const setStatus = (s: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (s) next.set('status', s); else next.delete('status')
      next.delete('id')
      return next
    })
  }

  const approveMut = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => approveChangeRequest(id, notes),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['changes'] }); qc.invalidateQueries({ queryKey: ['change'] }) },
  })
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectChangeRequest(id, reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['changes'] }); qc.invalidateQueries({ queryKey: ['change'] }) },
  })
  const executeMut = useMutation({
    mutationFn: (id: string) => executeChangeRequest(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['changes'] }); qc.invalidateQueries({ queryKey: ['change'] }) },
  })
  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelChangeRequest(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['changes'] }); qc.invalidateQueries({ queryKey: ['change'] }) },
  })

  const isAdmin = hasRole(role, 'admin')
  const canAct = hasRole(role, 'operator')

  return (
    <div className="min-h-screen bg-slate-50">
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}

      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Change Management</h1>
          <p className="text-xs text-slate-400 mt-0.5">{changes.length} change requests</p>
        </div>
        {canAct && (
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
            New change
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="px-6 py-3 border-b border-slate-100 bg-white flex gap-2 overflow-x-auto">
        {['', 'pending_approval', 'approved', 'executing', 'completed', 'failed', 'rejected', 'cancelled'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              statusFilter === s ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
            }`}>
            {s ? STATUS_LABEL[s] : 'All'}
          </button>
        ))}
      </div>

      <div className="flex">
        {/* List */}
        <div className={`${selectedId ? 'w-1/2 border-r border-slate-200' : 'flex-1'} max-h-[calc(100vh-10rem)] overflow-y-auto`}>
          {changes.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">No change requests found.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {changes.map(cr => (
                <button key={cr.id} onClick={() => selectCR(cr.id)}
                  className={`w-full text-left px-6 py-4 hover:bg-slate-50 transition-colors ${selectedId === cr.id ? 'bg-blue-50' : ''}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[cr.status] ?? ''}`}>
                      {STATUS_LABEL[cr.status] ?? cr.status}
                    </span>
                    <span className="text-sm font-medium text-slate-800 truncate">{cr.title}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>by {cr.requested_by_name ?? 'unknown'}</span>
                    <span>{formatAge(cr.created_at)}</span>
                    <span>{cr.actions.length} action{cr.actions.length !== 1 ? 's' : ''}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedId && detail && (
          <div className="flex-1 p-6 max-h-[calc(100vh-10rem)] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">{detail.title}</h2>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[detail.status] ?? ''}`}>
                  {STATUS_LABEL[detail.status] ?? detail.status}
                </span>
              </div>
              <button onClick={() => selectCR(null)} className="text-slate-400 hover:text-slate-600 text-sm">Close</button>
            </div>

            {detail.description && (
              <p className="text-sm text-slate-600 mb-4 whitespace-pre-wrap">{detail.description}</p>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs mb-6">
              <div><span className="text-slate-400">Requested by:</span> <span className="text-slate-700 font-medium">{detail.requested_by_name}</span></div>
              <div><span className="text-slate-400">Created:</span> <span className="text-slate-700">{new Date(detail.created_at).toLocaleString()}</span></div>
              {detail.approved_by_name && (
                <div><span className="text-slate-400">Approved by:</span> <span className="text-slate-700 font-medium">{detail.approved_by_name}</span></div>
              )}
              {detail.executed_by_name && (
                <div><span className="text-slate-400">Executed by:</span> <span className="text-slate-700 font-medium">{detail.executed_by_name}</span></div>
              )}
              {detail.rejection_reason && (
                <div className="col-span-2"><span className="text-slate-400">Rejection reason:</span> <span className="text-red-600">{detail.rejection_reason}</span></div>
              )}
              {detail.rollback_plan && (
                <div className="col-span-2"><span className="text-slate-400">Rollback plan:</span> <span className="text-slate-700">{detail.rollback_plan}</span></div>
              )}
            </div>

            {/* Actions */}
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Actions ({detail.actions.length})</h3>
            <div className="space-y-2 mb-6">
              {detail.actions.map((a, i) => (
                <div key={a.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-slate-400 w-6">#{i + 1}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${ACTION_STATUS_STYLE[a.status] ?? ''}`}>
                      {a.status}
                    </span>
                    <span className="text-xs font-medium text-slate-700">{a.action_type}</span>
                    <span className="text-xs text-slate-400">→ {a.device_name ?? a.device_id.slice(0, 8)}</span>
                  </div>
                  {a.payload.commands && (
                    <pre className="text-[11px] text-slate-600 bg-slate-50 rounded p-2 mt-1 max-h-24 overflow-y-auto font-mono">
                      {(a.payload.commands as string[]).join('\n')}
                    </pre>
                  )}
                  {a.payload.config_text && (
                    <pre className="text-[11px] text-slate-600 bg-slate-50 rounded p-2 mt-1 max-h-24 overflow-y-auto font-mono">
                      {a.payload.config_text as string}
                    </pre>
                  )}
                  {a.output && (
                    <details className="mt-1">
                      <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600">Output</summary>
                      <pre className="text-[10px] text-slate-500 bg-slate-50 rounded p-2 mt-1 max-h-32 overflow-y-auto font-mono">{a.output}</pre>
                    </details>
                  )}
                  {a.error_message && (
                    <p className="text-[11px] text-red-600 mt-1">{a.error_message}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
              {detail.status === 'pending_approval' && isAdmin && me && detail.requested_by !== me.id && (
                <>
                  <button onClick={() => approveMut.mutate({ id: detail.id })}
                    disabled={approveMut.isPending}
                    className="px-4 py-2 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors">
                    {approveMut.isPending ? 'Approving…' : 'Approve'}
                  </button>
                  <RejectButton id={detail.id} onReject={(reason) => rejectMut.mutate({ id: detail.id, reason })} isPending={rejectMut.isPending} />
                </>
              )}
              {detail.status === 'approved' && canAct && (
                <button onClick={() => { if (confirm('Execute this change? This will push config to devices.')) executeMut.mutate(detail.id) }}
                  disabled={executeMut.isPending}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {executeMut.isPending ? 'Executing…' : 'Execute'}
                </button>
              )}
              {['draft', 'pending_approval', 'approved'].includes(detail.status) && (
                <button onClick={() => cancelMut.mutate(detail.id)}
                  disabled={cancelMut.isPending}
                  className="px-4 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


function RejectButton({ id, onReject, isPending }: { id: string; onReject: (reason: string) => void; isPending: boolean }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-4 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
        Reject
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection…"
        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 w-48 focus:outline-none focus:ring-2 focus:ring-red-400" />
      <button onClick={() => { if (reason.trim()) { onReject(reason.trim()); setOpen(false) } }}
        disabled={!reason.trim() || isPending}
        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
        Confirm
      </button>
      <button onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
    </div>
  )
}


function CreateModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [rollbackPlan, setRollbackPlan] = useState('')
  const [actions, setActions] = useState<ChangeActionCreate[]>([])
  const [error, setError] = useState('')

  const { data: devicesData } = useQuery({
    queryKey: ['devices', undefined, 0],
    queryFn: () => fetchDevices({ limit: 500 }),
  })
  const devices = devicesData?.items ?? []

  const [actionDeviceId, setActionDeviceId] = useState('')
  const [actionType, setActionType] = useState('config_push')
  const [actionCommands, setActionCommands] = useState('')

  const addAction = () => {
    if (!actionDeviceId || !actionCommands.trim()) return
    const payload: Record<string, any> = actionType === 'config_push'
      ? { config_text: actionCommands.trim(), save: true }
      : { commands: actionCommands.trim().split('\n').filter(Boolean) }
    setActions([...actions, { device_id: actionDeviceId, action_type: actionType, payload }])
    setActionCommands('')
  }

  const removeAction = (i: number) => setActions(actions.filter((_, idx) => idx !== i))

  const createMut = useMutation({
    mutationFn: createChangeRequest,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['changes'] })
      onClose()
    },
    onError: (err: any) => setError(err?.response?.data?.detail ?? 'Failed to create'),
  })

  const handleSubmit = () => {
    if (!title.trim()) { setError('Title is required'); return }
    if (actions.length === 0) { setError('At least one action is required'); return }
    setError('')
    createMut.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      rollback_plan: rollbackPlan.trim() || undefined,
      actions,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-slate-800">New Change Request</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Title <span className="text-red-500">*</span></label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Add VLAN 200 to access switches" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="What this change does and why…" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rollback Plan</label>
            <textarea value={rollbackPlan} onChange={e => setRollbackPlan(e.target.value)} rows={2}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="How to revert if something goes wrong…" />
          </div>

          {/* Actions list */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-2">
              Actions <span className="text-slate-400">({actions.length})</span>
            </label>
            {actions.map((a, i) => (
              <div key={i} className="flex items-start gap-2 mb-2 border border-slate-200 rounded-lg p-2">
                <span className="text-xs font-mono text-slate-400 pt-0.5">#{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-700 font-medium">{a.action_type} → {devices.find(d => d.id === a.device_id)?.hostname ?? a.device_id.slice(0, 8)}</div>
                  <pre className="text-[10px] text-slate-500 mt-0.5 truncate">{a.payload.config_text ?? (a.payload.commands as string[])?.join('; ')}</pre>
                </div>
                <button onClick={() => removeAction(i)} className="text-slate-400 hover:text-red-600 text-sm">×</button>
              </div>
            ))}

            {/* Add action form */}
            <div className="border border-dashed border-slate-300 rounded-lg p-3 space-y-2">
              <div className="flex gap-2">
                <select value={actionDeviceId} onChange={e => setActionDeviceId(e.target.value)}
                  className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select device…</option>
                  {devices.map(d => <option key={d.id} value={d.id}>{d.hostname} ({d.mgmt_ip})</option>)}
                </select>
                <select value={actionType} onChange={e => setActionType(e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="config_push">Config Push</option>
                  <option value="command_run">Command Run</option>
                </select>
              </div>
              <textarea value={actionCommands} onChange={e => setActionCommands(e.target.value)} rows={3}
                className="w-full text-xs font-mono border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                placeholder={actionType === 'config_push' ? 'interface Vlan200\n ip address 10.0.200.1 255.255.255.0\n no shutdown' : 'show run\nshow ip bgp summary'} />
              <button onClick={addAction} disabled={!actionDeviceId || !actionCommands.trim()}
                className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50 transition-colors">
                + Add action
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
            <button onClick={handleSubmit} disabled={createMut.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {createMut.isPending ? 'Creating…' : 'Submit for Approval'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
