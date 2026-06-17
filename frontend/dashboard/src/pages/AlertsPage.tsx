import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchAlerts, acknowledgeAlert, resolveAlert, subscribeAlerts } from '../api/alerts'
import type { AlertsWsStatus } from '../api/alerts'
import type { Alert } from '../api/types'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import SavedViewsMenu from '../components/SavedViewsMenu'

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-yellow-50 text-yellow-600 border-yellow-200',
  info:     'bg-blue-50 text-blue-600 border-blue-200',
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  major:    'bg-orange-500',
  minor:    'bg-yellow-500',
  warning:  'bg-yellow-400',
  info:     'bg-blue-400',
}

const STATUS_STYLE: Record<string, string> = {
  open:         'text-red-600 bg-red-50',
  acknowledged: 'text-yellow-600 bg-yellow-50',
  resolved:     'text-green-600 bg-green-50',
}

function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)  return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

export default function AlertsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const role = useRole()
  const canAct = hasRole(role, 'operator')
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = searchParams.get('status') ?? 'open'
  const severityFilter = searchParams.get('severity') ?? ''
  const showHistory = searchParams.get('history') === '1'

  const setStatusFilter = (s: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (s === 'open') next.delete('status'); else next.set('status', s)
      return next
    })
  }
  const setSeverityFilter = (s: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (s === '') next.delete('severity'); else next.set('severity', s)
      return next
    })
  }
  const toggleHistory = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (showHistory) {
        next.delete('history')
      } else {
        next.set('history', '1')
        next.set('status', '')
      }
      return next
    })
  }

  const effectiveStatus = showHistory ? (statusFilter === 'open' ? '' : statusFilter) : statusFilter

  const { data } = useQuery({
    queryKey: ['alerts', effectiveStatus, severityFilter],
    queryFn: () => fetchAlerts({
      status: effectiveStatus || undefined,
      severity: severityFilter || undefined,
      limit: 200,
    }),
    // WebSocket pushes drive live updates; this poll is just a safety net.
    refetchInterval: 60_000,
  })

  const [wsStatus, setWsStatus] = useState<AlertsWsStatus>('connecting')
  useEffect(() => {
    return subscribeAlerts(() => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    }, setWsStatus)
  }, [qc])

  const ackMutation = useMutation({
    mutationFn: acknowledgeAlert,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })
  const resolveMutation = useMutation({
    mutationFn: resolveAlert,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  const alerts = data?.items ?? []

  const SEV_COLOR: Record<string, string> = {
    critical: '#dc2626', major: '#ea580c', minor: '#d97706', warning: '#ca8a04', info: '#2563eb',
  }

  const statusPills = showHistory
    ? ['', 'open', 'acknowledged', 'resolved', 'suppressed']
    : ['open', 'acknowledged', 'suppressed']
  const statusLabel: Record<string, string> = {
    '': 'All', open: 'Open', acknowledged: 'Acked', resolved: 'Resolved', suppressed: 'Suppressed',
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-3 md:px-6 py-3 md:py-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-slate-800">Alerts</h1>
            {data && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{data.total}</span>}
            <span className="flex items-center gap-1.5 text-xs text-slate-400" title={wsStatus === 'open' ? 'Live updates connected' : 'Reconnecting to live updates…'}>
              <span className={`w-1.5 h-1.5 rounded-full ${wsStatus === 'open' ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
              {wsStatus === 'open' ? 'Live' : 'Reconnecting…'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <SavedViewsMenu page="alerts" query={searchParams.toString()} onApply={q => setSearchParams(new URLSearchParams(q))} />
            <button
              onClick={toggleHistory}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                showHistory ? 'bg-slate-800 text-white border-slate-800' : 'text-slate-500 border-slate-200 hover:border-slate-400'
              }`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
              </svg>
              {showHistory ? 'History on' : 'History'}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
          {/* Status pills */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {statusPills.map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-slate-800 text-white'
                    : 'bg-white text-slate-500 hover:bg-slate-50'
                } ${s !== statusPills[0] ? 'border-l border-slate-200' : ''}`}>
                {statusLabel[s]}
              </button>
            ))}
          </div>

          {/* Severity filter */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
            {['', 'critical', 'major', 'minor', 'warning', 'info'].map(sev => (
              <button key={sev} onClick={() => setSeverityFilter(sev)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  severityFilter === sev
                    ? sev
                      ? 'text-white border-transparent'
                      : 'bg-slate-800 text-white border-slate-800'
                    : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                }`}
                style={severityFilter === sev && sev ? { backgroundColor: SEV_COLOR[sev], borderColor: SEV_COLOR[sev] } : {}}>
                {sev ? sev.charAt(0).toUpperCase() + sev.slice(1) : 'All severities'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="p-3 md:p-6">
        {alerts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <p className="text-slate-500 text-sm font-medium">All clear</p>
            <p className="text-slate-400 text-xs mt-1">No alerts match the current filters.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {alerts.map((a: Alert) => {
              const sc = SEV_COLOR[a.severity] ?? '#94a3b8'
              const isPct = a.context?.metric === 'cpu_util_pct' || a.context?.metric === 'mem_util_pct'
              return (
                <div
                  key={a.id}
                  onClick={() => navigate(`/alerts/${a.id}`)}
                  className="group bg-white border border-slate-200 rounded-xl px-4 py-3.5 cursor-pointer hover:shadow-sm hover:-translate-y-px transition-all duration-150 flex items-center gap-4"
                  style={{ borderLeft: `3px solid ${sc}` }}
                >
                  {/* Severity dot */}
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sc }} />

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-semibold text-slate-800 truncate">{a.title}</span>
                      {a.context?.value != null && (
                        <span className="text-xs font-mono text-slate-500 shrink-0">
                          {String(a.context.value)}{isPct ? '%' : ''}
                          {a.context?.threshold != null && ` / ${a.context.threshold}${isPct ? '%' : ''}`}
                        </span>
                      )}
                    </div>
                    {a.message && <p className="text-xs text-slate-400 truncate">{a.message}</p>}
                  </div>

                  {/* Badges */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${SEVERITY_STYLE[a.severity] ?? ''}`}>
                      {a.severity}
                    </span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${STATUS_STYLE[a.status] ?? ''}`}>
                      {a.status}
                    </span>
                    {a.suppressed_by_alert_id && (
                      <span
                        onClick={e => { e.stopPropagation(); navigate(`/alerts/${a.suppressed_by_alert_id}`) }}
                        className="text-[10px] font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-full px-2 py-0.5 transition-colors"
                        title="Suppressed because a parent alert is the root cause — click to view"
                      >
                        ↑ parent
                      </span>
                    )}
                    {a.suppressed_child_count > 0 && (
                      <span
                        className="text-[10px] font-medium text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5"
                        title={`Suppressing ${a.suppressed_child_count} child alert${a.suppressed_child_count === 1 ? '' : 's'} as root cause`}
                      >
                        ↓ {a.suppressed_child_count}
                      </span>
                    )}
                    <span className="text-xs text-slate-400 w-16 text-right">{timeAgo(a.triggered_at)}</span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                    {canAct && a.status === 'open' && (
                      <button onClick={() => ackMutation.mutate(a.id)} disabled={ackMutation.isPending}
                        className="text-[10px] font-semibold text-amber-700 border border-amber-200 bg-amber-50 rounded-lg px-2.5 py-1 hover:bg-amber-100 disabled:opacity-50 transition-colors">
                        Ack
                      </button>
                    )}
                    {canAct && (a.status === 'open' || a.status === 'acknowledged') && (
                      <button onClick={() => resolveMutation.mutate(a.id)} disabled={resolveMutation.isPending}
                        className="text-[10px] font-semibold text-green-700 border border-green-200 bg-green-50 rounded-lg px-2.5 py-1 hover:bg-green-100 disabled:opacity-50 transition-colors">
                        Resolve
                      </button>
                    )}
                    <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-400 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="m9 18 6-6-6-6"/>
                    </svg>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
