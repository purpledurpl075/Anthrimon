import { useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlert, fetchAlertRule, acknowledgeAlert, resolveAlert } from '../api/alerts'
import { fetchDevice } from '../api/devices'
import api from '../api/client'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'
import ErrorState from '../components/ErrorState'
import { formatAge } from '../utils/time'
import { useCurrentUser } from '../hooks/useCurrentUser'

interface AlertComment { id: string; body: string; author: string; user_id: string; created_at: string; updated_at: string | null }
const fetchComments = (id: string) => api.get<AlertComment[]>(`/alerts/${id}/comments`).then(r => r.data)
const postComment   = (id: string, body: string) => api.post<AlertComment>(`/alerts/${id}/comments`, { body }).then(r => r.data)
const editComment   = (alertId: string, commentId: string, body: string) => api.patch<AlertComment>(`/alerts/${alertId}/comments/${commentId}`, { body }).then(r => r.data)
const deleteComment = (alertId: string, commentId: string) => api.delete(`/alerts/${alertId}/comments/${commentId}`)

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  major:    '#ea580c',
  minor:    '#d97706',
  warning:  '#ca8a04',
  info:     '#2563eb',
  resolved: '#16a34a',
}
const SEVERITY_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-amber-100 text-amber-700',
  warning:  'bg-yellow-100 text-yellow-700',
  info:     'bg-blue-100 text-blue-700',
}
const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-yellow-50 text-yellow-600 border-yellow-200',
  info:     'bg-blue-50 text-blue-600 border-blue-200',
}

const STATUS_STYLE: Record<string, string> = {
  open:         'text-red-600 bg-red-50 border-red-200',
  acknowledged: 'text-yellow-600 bg-yellow-50 border-yellow-200',
  resolved:     'text-green-600 bg-green-50 border-green-200',
  suppressed:   'text-slate-500 bg-slate-50 border-slate-200',
}

const METRIC_LABEL: Record<string, string> = {
  cpu_util_pct:     'CPU utilisation',
  mem_util_pct:     'Memory utilisation',
  device_down:      'Device reachability',
  interface_down:   'Interface status',
  interface_flap:   'Interface flapping',
  uptime:           'Device uptime',
  temperature:      'Temperature',
  interface_errors: 'Interface errors',
  custom_oid:       'Custom OID',
}

function fmt(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function ContextValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">—</span>
    if (typeof value[0] === 'object' && value[0] !== null) {
      return (
        <div className="flex flex-col gap-1">
          {(value as Record<string, unknown>[]).map((item, i) => (
            <span key={i} className="font-mono text-[10px] text-slate-600">
              {Object.entries(item)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}: ${v}`)
                .join('  ·  ')}
            </span>
          ))}
        </div>
      )
    }
    return <span className="font-mono text-[10px] text-slate-600">{value.join(', ')}</span>
  }
  if (typeof value === 'object' && value !== null) {
    return <span className="font-mono text-[10px] text-slate-600">{JSON.stringify(value)}</span>
  }
  return <span className="font-mono text-[10px] text-slate-600">{String(value)}</span>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2.5 border-b border-slate-100 last:border-0">
      <span className="text-xs font-medium text-slate-500 w-32 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-slate-800 flex-1">{children}</span>
    </div>
  )
}

export default function AlertDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: alert, isLoading, isError, refetch } = useQuery({
    queryKey: ['alert', id],
    queryFn: () => fetchAlert(id!),
    enabled: !!id,
  })

  const { data: device } = useQuery({
    queryKey: ['device', alert?.device_id],
    queryFn: () => fetchDevice(alert!.device_id!),
    enabled: !!alert?.device_id,
  })

  const { data: rule } = useQuery({
    queryKey: ['alert-rule', alert?.rule_id],
    queryFn:  () => fetchAlertRule(alert!.rule_id!),
    enabled:  !!alert?.rule_id,
  })

  const ackMut = useMutation({
    mutationFn: () => acknowledgeAlert(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert', id] }),
  })
  const resolveMut = useMutation({
    mutationFn: () => resolveAlert(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert', id] })
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  if (isLoading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  if (isError || !alert) return <ErrorState message="Alert not found." onRetry={() => refetch()} />

  const ctx = alert.context ?? {}
  const metric = ctx.metric as string | undefined
  const value = ctx.value as number | undefined
  const threshold = ctx.threshold as number | undefined
  const condition = ctx.condition as string | undefined
  const isPct = metric === 'cpu_util_pct' || metric === 'mem_util_pct'
  const syslogContext = (ctx.syslog_context ?? []) as Array<{
    ts_ms: number; severity: number; program: string; message: string
  }>

  const sevColor   = alert.status === 'resolved'
    ? SEVERITY_COLOR.resolved
    : (SEVERITY_COLOR[alert.severity] ?? '#475569')
  const statusLabel: Record<string, string> = {
    open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', suppressed: 'Suppressed',
  }

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Breadcrumb */}
      <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between">
        <nav className="flex items-center gap-1.5 text-xs text-slate-400">
          <Link to="/alerts" className="hover:text-blue-600 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
            Alerts
          </Link>
          <span>/</span>
          <span className="text-slate-600 font-medium truncate max-w-xs">{alert.title}</span>
        </nav>
        <div className="flex items-center gap-2">
          {alert.status === 'open' && (
            <button onClick={() => ackMut.mutate()} disabled={ackMut.isPending}
              className="px-3 py-1.5 text-xs font-medium text-amber-700 border border-amber-300 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors">
              {ackMut.isPending ? 'Acknowledging…' : 'Acknowledge'}
            </button>
          )}
          {(alert.status === 'open' || alert.status === 'acknowledged') && (
            <button onClick={() => resolveMut.mutate()} disabled={resolveMut.isPending}
              className="px-3 py-1.5 text-xs font-medium text-green-700 border border-green-300 bg-green-50 rounded-lg hover:bg-green-100 disabled:opacity-50 transition-colors">
              {resolveMut.isPending ? 'Resolving…' : 'Resolve'}
            </button>
          )}
        </div>
      </div>

      {/* Hero */}
      <div className="bg-white border-b border-slate-200" style={{ borderLeft: `4px solid ${sevColor}` }}>
        <div className="px-6 py-5">
          {/* Badges row */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide ${SEVERITY_BG[alert.severity] ?? 'bg-slate-100 text-slate-500'}`}>
              {alert.severity}
            </span>
            <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide"
              style={{ backgroundColor: `${sevColor}18`, color: sevColor }}>
              {statusLabel[alert.status] ?? alert.status}
            </span>
            {metric && (
              <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 uppercase tracking-wide">
                {METRIC_LABEL[metric] ?? metric}
              </span>
            )}
          </div>

          {/* Title */}
          <h1 className="text-xl font-bold text-slate-900 mb-1">{alert.title}</h1>
          {alert.message && <p className="text-sm text-slate-500 mb-4">{alert.message}</p>}

          {/* Parent-of-children callout */}
          {alert.suppressed_child_count > 0 && (
            <div className="mb-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="text-lg leading-none mt-0.5">↓</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-blue-700">
                    Root cause — suppressing {alert.suppressed_child_count} child alert{alert.suppressed_child_count === 1 ? '' : 's'}
                  </p>
                  <p className="text-[11px] text-blue-600 mt-0.5">
                    When this alert resolves, the suppressed children will be re-evaluated automatically.
                  </p>
                </div>
              </div>
              {alert.suppressed_children && alert.suppressed_children.length > 0 && (
                <div className="mt-3 border-t border-blue-100 pt-2.5 space-y-1.5">
                  {alert.suppressed_children.map(c => (
                    <div
                      key={c.id}
                      onClick={() => navigate(`/alerts/${c.id}`)}
                      className="flex items-center gap-2 text-xs cursor-pointer hover:bg-blue-100/60 rounded-md px-2 py-1.5 transition-colors"
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          backgroundColor:
                            c.severity === 'critical' ? '#dc2626' :
                            c.severity === 'major'    ? '#ea580c' :
                            c.severity === 'minor'    ? '#d97706' :
                            c.severity === 'warning'  ? '#ca8a04' :
                                                        '#0891b2',
                        }}
                      />
                      {c.metric && (
                        <span className="font-mono text-[10px] bg-blue-100 text-blue-700 rounded px-1.5 py-0.5 shrink-0">
                          {c.metric}
                        </span>
                      )}
                      <span className="text-slate-700 truncate flex-1">{c.title}</span>
                      <span className="text-[10px] text-blue-500 shrink-0">view →</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Suppressed-by callout */}
          {alert.suppressed_by_alert_id && (
            <div className="mb-4 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex items-start gap-3">
              <span className="text-lg leading-none mt-0.5">↑</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-600">Suppressed by a parent alert</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  This alert is treated as collateral of a root-cause event. It will
                  re-open automatically when the parent resolves.
                </p>
              </div>
              <button
                onClick={() => navigate(`/alerts/${alert.suppressed_by_alert_id}`)}
                className="text-[11px] font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg px-2.5 py-1 hover:bg-slate-100 transition-colors shrink-0"
              >
                View parent →
              </button>
            </div>
          )}

          {/* Value / threshold */}
          {value !== undefined && (
            <div className="flex flex-wrap gap-3 mt-3">
              <div className="bg-slate-50 rounded-xl px-5 py-3 border border-slate-100">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Value</p>
                <p className="text-2xl font-bold" style={{ color: sevColor }}>
                  {value}{isPct ? '%' : ''}
                </p>
              </div>
              {threshold !== undefined && (
                <div className="bg-slate-50 rounded-xl px-5 py-3 border border-slate-100">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Threshold</p>
                  <p className="text-2xl font-bold text-slate-700">
                    {condition === 'gt' ? '>' : condition === 'lt' ? '<' : ''} {threshold}{isPct ? '%' : ''}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Timeline strip */}
        <div className="flex flex-col sm:flex-row border-t border-slate-100">
          {[
            { label: 'Triggered',     ts: alert.triggered_at,   color: '#dc2626' },
            { label: 'Acknowledged',  ts: alert.acknowledged_at, color: '#d97706' },
            { label: 'Resolved',      ts: alert.resolved_at,     color: '#16a34a' },
          ].filter(e => e.ts).map(({ label, ts, color }, i, arr) => (
            <div key={label} className={`px-4 py-2.5 flex-1 ${i < arr.length - 1 ? 'border-b sm:border-b-0 sm:border-r border-slate-100' : ''}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
              </div>
              <span className="text-xs text-slate-700">{fmt(ts)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detail cards */}
      <div className="p-3 md:p-6 grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">

        {/* Device */}
        {device && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Device</h2>
              <Link to={`/devices/${device.id}`}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                Open device
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </Link>
            </div>
            <div className="px-5 py-1">
              <Row label="Hostname">
                <span className="font-medium text-slate-800">{device.fqdn ?? device.hostname}</span>
              </Row>
              <Row label="IP"><span className="font-mono">{device.mgmt_ip}</span></Row>
              {device.vendor && <Row label="Vendor">{device.vendor}</Row>}
              {device.device_type && (
                <Row label="Type">
                  <span className="flex items-center gap-1.5" style={{ color: DEVICE_TYPE_COLOR[device.device_type] ?? '#64748b' }}>
                    <DeviceTypeIcon type={device.device_type} size={13} />
                    <span className="text-slate-700">{DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}</span>
                  </span>
                </Row>
              )}
              <Row label="Status">
                <span className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: device.status === 'up' ? '#16a34a' : '#dc2626' }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: device.status === 'up' ? '#16a34a' : '#dc2626' }} />
                  {device.status}
                </span>
              </Row>
            </div>
          </div>
        )}

        {/* Rule */}
        {alert.rule_id && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Alert Rule</h2>
              <Link to="/alert-rules" className="text-xs text-blue-600 hover:underline">View rules</Link>
            </div>
            <div className="px-5 py-1">
              <Row label="Name">
                <span className="font-medium text-slate-800">
                  {rule?.name ?? <span className="font-mono text-[10px] text-slate-400">{alert.rule_id}</span>}
                </span>
              </Row>
              {rule?.metric && (
                <Row label="Metric"><span className="font-mono text-xs">{METRIC_LABEL[rule.metric] ?? rule.metric}</span></Row>
              )}
              {rule?.threshold != null && (
                <Row label="Threshold">
                  <span className="font-semibold">{rule.threshold}{rule.metric?.includes('pct') ? '%' : ''}</span>
                </Row>
              )}
              {rule?.severity && (
                <Row label="Severity">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${SEVERITY_BG[rule.severity] ?? ''}`}>
                    {rule.severity}
                  </span>
                </Row>
              )}
            </div>
          </div>
        )}

        {/* Extra context */}
        {Object.keys(ctx).some(k => !['metric','value','threshold','condition','syslog_context'].includes(k)) && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Context</h2>
            </div>
            <div className="px-5 py-1">
              {Object.entries(ctx)
                .filter(([k]) => !['metric','value','threshold','condition','syslog_context'].includes(k))
                .map(([k, v]) => (
                  <Row key={k} label={k}>
                    <ContextValue value={v} />
                  </Row>
                ))}
              <Row label="Alert ID"><span className="font-mono text-[10px] text-slate-400">{alert.id}</span></Row>
            </div>
          </div>
        )}

        {/* Correlated syslog */}
        {syslogContext.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden lg:col-span-2">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Related syslog events</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">Messages from this device in the 10 minutes surrounding the alert</p>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {syslogContext.map((e, i) => {
                const SEV_COLORS: Record<number, string> = { 0:'#dc2626',1:'#dc2626',2:'#dc2626',3:'#ea580c',4:'#d97706',5:'#2563eb',6:'#64748b',7:'#94a3b8' }
                const SEV_NAMES: Record<number, string> = { 0:'emerg',1:'alert',2:'crit',3:'error',4:'warn',5:'notice',6:'info',7:'debug' }
                return (
                  <div key={i} className="flex items-start gap-3 px-5 py-2.5">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded mt-0.5 shrink-0 min-w-[3.5rem] text-center"
                      style={{ backgroundColor: `${SEV_COLORS[e.severity]}18`, color: SEV_COLORS[e.severity] }}>
                      {SEV_NAMES[e.severity] ?? e.severity}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400 mt-0.5 shrink-0 w-36 hidden sm:block">
                      {new Date(e.ts_ms).toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
                    </span>
                    <span className="text-[11px] font-mono text-slate-500 mt-0.5 w-20 shrink-0 truncate hidden md:block">{e.program}</span>
                    <span className="text-xs text-slate-700 flex-1">{e.message}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Comments — full width */}
        <div className="lg:col-span-2">
          <CommentThread alertId={alert.id} />
        </div>
      </div>
    </div>
  )
}

function CommentThread({ alertId }: { alertId: string }) {
  const qc = useQueryClient()
  const { data: me } = useCurrentUser()
  const [text, setText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: comments = [] } = useQuery({
    queryKey: ['alert-comments', alertId],
    queryFn: () => fetchComments(alertId),
    refetchInterval: 30_000,
  })

  const addMut = useMutation({
    mutationFn: () => postComment(alertId, text.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-comments', alertId] })
      setText('')
      textareaRef.current?.focus()
    },
  })

  const editMut = useMutation({
    mutationFn: (vars: { commentId: string; body: string }) => editComment(alertId, vars.commentId, vars.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-comments', alertId] })
      setEditingId(null)
      setEditText('')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (commentId: string) => deleteComment(alertId, commentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-comments', alertId] }),
  })

  const startEdit = (c: AlertComment) => {
    setEditingId(c.id)
    setEditText(c.body)
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-4">Comments</h2>

      {comments.length === 0 ? (
        <p className="text-xs text-slate-400 mb-4">No comments yet — add one below.</p>
      ) : (
        <div className="space-y-4 mb-5">
          {comments.map(c => (
            <div key={c.id} className="flex gap-3 group">
              <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 text-[10px] font-bold text-slate-600 uppercase">
                {c.author.slice(0, 2)}
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs font-semibold text-slate-700">{c.author}</span>
                  <span className="text-[10px] text-slate-400">{formatAge(c.updated_at || c.created_at)}</span>
                  {c.updated_at && <span className="text-[10px] text-slate-400 italic">(edited)</span>}
                  {me && c.user_id === me.id && editingId !== c.id && (
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1.5 ml-1">
                      <button onClick={() => startEdit(c)} className="text-[10px] text-slate-400 hover:text-blue-600">edit</button>
                      <button onClick={() => { if (confirm('Delete this comment?')) deleteMut.mutate(c.id) }}
                        className="text-[10px] text-slate-400 hover:text-red-600">delete</button>
                    </span>
                  )}
                </div>
                {editingId === c.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && editText.trim()) {
                          e.preventDefault()
                          editMut.mutate({ commentId: c.id, body: editText.trim() })
                        }
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      rows={3}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditingId(null)}
                        className="px-3 py-1 text-xs text-slate-500 hover:text-slate-700 transition-colors">Cancel</button>
                      <button onClick={() => editMut.mutate({ commentId: c.id, body: editText.trim() })}
                        disabled={!editText.trim() || editMut.isPending}
                        className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                        {editMut.isPending ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{c.body}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Compose */}
      <div className="flex gap-3 items-start">
        <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0 text-[10px] font-bold text-blue-700">
          You
        </div>
        <div className="flex-1 space-y-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault()
                addMut.mutate()
              }
            }}
            placeholder="Add a comment — describe the problem, actions taken, or resolution… (Ctrl+Enter to submit)"
            rows={3}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={() => addMut.mutate()}
              disabled={!text.trim() || addMut.isPending}
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {addMut.isPending ? 'Posting…' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
