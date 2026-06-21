import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fetchSyslogSummary, fetchSyslogMessages, fetchSyslogRate,
  fetchSyslogTopPrograms, fetchSyslogTopDevices,
} from '../api/syslog'
import { fetchDevices } from '../api/devices'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'
import TrapsTab from './TrapsTab'
import { SkeletonTable, SkeletonInline } from '../components/Skeleton'
import { fmtNum, fmtTs, TIME_WINDOWS } from './logHelpers'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_ORDER = ['emergency','alert','critical','error','warning','notice','info','debug'] as const
type SevName = typeof SEV_ORDER[number]

const SEV_COLOR: Record<SevName, string> = {
  emergency: '#dc2626', alert: '#dc2626', critical: '#dc2626',
  error: '#ea580c', warning: '#d97706', notice: '#2563eb',
  info: '#64748b', debug: '#94a3b8',
}
const SEV_BG: Record<SevName, string> = {
  emergency: 'bg-red-100 text-red-700',
  alert:     'bg-red-100 text-red-700',
  critical:  'bg-red-100 text-red-700',
  error:     'bg-orange-100 text-orange-700',
  warning:   'bg-yellow-100 text-yellow-700',
  notice:    'bg-blue-100 text-blue-700',
  info:      'bg-slate-100 text-slate-600',
  debug:     'bg-slate-50 text-slate-400',
}

const SEV_MAX: Record<SevName, number> = {
  emergency: 0, alert: 1, critical: 2, error: 3,
  warning: 4, notice: 5, info: 6, debug: 7,
}

// ── Log rate mini chart ───────────────────────────────────────────────────────

function LogRateChart({ hours, deviceId }: { hours: number; deviceId: string }) {
  const { data = [] } = useQuery({
    queryKey:        ['syslog-rate', hours, deviceId],
    queryFn:         () => fetchSyslogRate(hours, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const byHour = useMemo(() => {
    const m: Record<number, Record<string, number>> = {}
    for (const p of data) {
      if (!m[p.ts_ms]) m[p.ts_ms] = {}
      m[p.ts_ms][p.severity_name] = (m[p.ts_ms][p.severity_name] ?? 0) + p.count
    }
    return Object.entries(m).sort(([a], [b]) => Number(a) - Number(b))
  }, [data])

  if (byHour.length < 2) return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-3">Log rate</h2>
      <div className="flex items-center justify-center h-20 text-xs text-slate-300">No data yet</div>
    </div>
  )

  const maxTotal = Math.max(...byHour.map(([, sevs]) => Object.values(sevs).reduce((a, b) => a + b, 0)), 1)
  const barW = 100 / byHour.length
  const sevToDraw = ['error','warning','notice','info','debug'] as const

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-800">Log rate</h2>
        <div className="flex items-center gap-3 flex-wrap">
          {(['error','warning','info'] as const).map(s => (
            <span key={s} className="flex items-center gap-1 text-[10px] text-slate-500">
              <span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: SEV_COLOR[s] }} />
              {s}
            </span>
          ))}
        </div>
      </div>
      <svg width="100%" height={80} viewBox={`0 0 100 80`} preserveAspectRatio="none" className="overflow-visible">
        {byHour.map(([ts, sevs], i) => {
          let y = 80
          return (
            <g key={ts}>
              {sevToDraw.map(sev => {
                const n = sevs[sev] ?? 0
                if (!n) return null
                const h = Math.max((n / maxTotal) * 78, 1)
                y -= h
                return (
                  <rect key={sev} x={i * barW + 0.2} y={y} width={barW - 0.4} height={h}
                    fill={SEV_COLOR[sev]} fillOpacity={0.85} />
                )
              })}
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between text-[9px] text-slate-300 mt-0.5">
        <span>{fmtTs(Number(byHour[0][0]))}</span>
        <span>{fmtTs(Number(byHour.at(-1)![0]))}</span>
      </div>
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['syslog-summary', minutes, deviceId],
    queryFn:         () => fetchSyslogSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const bySev = data?.by_severity ?? {}
  const errorCount = (bySev.emergency ?? 0) + (bySev.alert ?? 0) + (bySev.critical ?? 0) + (bySev.error ?? 0)
  const warnCount  = bySev.warning ?? 0

  const cards = [
    { label: 'Total messages',  value: data ? fmtNum(data.total)          : '—', accent: '#6366f1' },
    { label: 'Errors/critical', value: data ? fmtNum(errorCount)          : '—', accent: errorCount > 0 ? '#dc2626' : '#94a3b8' },
    { label: 'Warnings',        value: data ? fmtNum(warnCount)            : '—', accent: warnCount  > 0 ? '#d97706' : '#94a3b8' },
    { label: 'Active devices',  value: data ? String(data.active_devices)  : '—', accent: '#0891b2' },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map(c => (
        <div key={c.label} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
          <p className="text-xs text-slate-400 mb-1">{c.label}</p>
          <p className="text-xl font-bold text-slate-800 tabular-nums">
            {isLoading ? <SkeletonInline /> : c.value}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── Severity breakdown ────────────────────────────────────────────────────────

function SeverityBreakdown({ minutes, deviceId, onSevFilter }: {
  minutes: number; deviceId: string; onSevFilter: (max: number | null) => void
}) {
  const { data } = useQuery({
    queryKey:        ['syslog-summary', minutes, deviceId],
    queryFn:         () => fetchSyslogSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const bySev = data?.by_severity ?? {}
  const total = data?.total ?? 0

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">By severity</h2>
      {total === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No messages</p>
      ) : (
        <div className="space-y-2">
          {SEV_ORDER.map(sev => {
            const n = bySev[sev] ?? 0
            return (
              <button key={sev} onClick={() => onSevFilter(n > 0 ? SEV_MAX[sev] : null)}
                className={`w-full flex items-center gap-2 text-left group ${n === 0 ? 'opacity-30' : ''}`}
                disabled={n === 0}>
                <span className="text-xs font-medium w-16 shrink-0 capitalize text-slate-600 group-hover:text-blue-600 transition-colors">{sev}</span>
                <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${total > 0 ? (n / total) * 100 : 0}%`, backgroundColor: SEV_COLOR[sev] }} />
                </div>
                <span className="text-xs font-bold tabular-nums w-10 text-right shrink-0 text-slate-600">{fmtNum(n)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Top programs ──────────────────────────────────────────────────────────────

function TopPrograms({ minutes, deviceId, onProgramFilter }: {
  minutes: number; deviceId: string; onProgramFilter: (p: string) => void
}) {
  const { data = [] } = useQuery({
    queryKey:        ['syslog-programs', minutes, deviceId],
    queryFn:         () => fetchSyslogTopPrograms(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const maxTotal = Math.max(...data.map(p => p.total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">Top programs</h2>
      {data.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No data</p>
      ) : (
        <div className="space-y-2.5">
          {data.map(p => (
            <div key={p.program} className="flex items-center gap-2 group">
              <button onClick={() => onProgramFilter(p.program)}
                className="text-xs font-mono font-medium text-slate-700 hover:text-blue-600 transition-colors w-28 shrink-0 truncate text-left">
                {p.program}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-400 transition-all"
                  style={{ width: `${(p.total / maxTotal) * 100}%` }} />
              </div>
              {p.errors > 0 && (
                <span className="text-[10px] font-bold text-red-500 tabular-nums shrink-0 w-6 text-right">{fmtNum(p.errors)}</span>
              )}
              <span className="text-xs font-bold text-slate-600 tabular-nums shrink-0 w-10 text-right">{fmtNum(p.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top devices ───────────────────────────────────────────────────────────────

function TopDevices({ minutes, onSelectDevice }: { minutes: number; onSelectDevice: (id: string) => void }) {
  const { data = [] } = useQuery({
    queryKey:        ['syslog-top-devices', minutes],
    queryFn:         () => fetchSyslogTopDevices(minutes),
    refetchInterval: 30_000,
  })

  const maxTotal = Math.max(...data.map(d => d.total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top devices by log volume</h2>
      </div>
      {data.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-slate-400">No data</div>
      ) : (
        <div className="divide-y divide-slate-50">
          {data.map(d => (
            <div key={d.device_id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group">
              <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }}>
                <DeviceTypeIcon type={d.device_type} size={14} />
              </span>
              <button onClick={() => onSelectDevice(d.device_id)}
                className="text-sm font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors w-32 shrink-0 text-left">
                {d.device_name}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-500 transition-all"
                  style={{ width: `${(d.total / maxTotal) * 100}%` }} />
              </div>
              {d.errors > 0 && (
                <span className="text-xs font-bold text-red-500 tabular-nums shrink-0">{fmtNum(d.errors)}</span>
              )}
              <span className="text-xs font-bold text-slate-600 tabular-nums shrink-0 w-14 text-right">
                {fmtNum(d.total)}
              </span>
              <Link to={`/devices/${d.device_id}`} className="shrink-0 text-slate-300 hover:text-blue-500 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Message table ─────────────────────────────────────────────────────────────

function MessageTable({ minutes, deviceId, severityMax, program, query }: {
  minutes: number; deviceId: string
  severityMax: number | null; program: string; query: string
}) {
  const [page, setPage] = useState(0)
  const LIMIT = 100

  useEffect(() => { setPage(0) }, [minutes, deviceId, severityMax, program, query])

  const [expanded, setExpanded] = useState<string | null>(null)

  const params = {
    device_id:    deviceId || undefined,
    severity_max: severityMax ?? undefined,
    program:      program || undefined,
    q:            query || undefined,
    minutes,
    limit: LIMIT,
    offset: page * LIMIT,
  }

  const { data, isLoading, isFetching } = useQuery({
    queryKey:        ['syslog-messages', params],
    queryFn:         () => fetchSyslogMessages(params),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })

  const messages = data?.messages ?? []
  const total    = data?.total ?? 0
  const pages    = Math.ceil(total / LIMIT)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Messages</h2>
          {isFetching && <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
        </div>
        <span className="text-xs text-slate-400">{fmtNum(total)} total</span>
      </div>

      {isLoading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : messages.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-slate-400">No messages match the current filters</p>
          <p className="text-xs text-slate-300 mt-1">Configure syslog export on your devices to port 514</p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-slate-50">
            {messages.map((m, i) => {
              const key = `${m.ts_ms}-${i}`
              const isOpen = expanded === key
              const sev = m.severity_name as SevName
              return (
                <div key={key}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : key)}
                    className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors text-left group"
                  >
                    <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded mt-0.5 capitalize min-w-[4.5rem] text-center ${SEV_BG[sev] ?? SEV_BG.info}`}>
                      {m.severity_name}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-slate-400 mt-0.5 w-36 hidden md:block">
                      {fmtTs(m.ts_ms)}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-500 mt-0.5 w-28 truncate hidden lg:block">
                      {m.device_name}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-slate-500 mt-0.5 w-20 truncate hidden lg:block">
                      {m.program}{m.pid ? `[${m.pid}]` : ''}
                    </span>
                    <span className="flex-1 text-xs text-slate-700 truncate">{m.message}</span>
                    <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 mt-0.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-3 bg-slate-50 border-t border-slate-100">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[11px] mt-2 mb-2">
                        <div><span className="text-slate-400">Device</span> <span className="text-slate-700 font-medium">{m.device_name}</span></div>
                        <div><span className="text-slate-400">Host</span> <span className="text-slate-700 font-mono">{m.hostname}</span></div>
                        <div><span className="text-slate-400">Program</span> <span className="text-slate-700 font-mono">{m.program}{m.pid ? `[${m.pid}]` : ''}</span></div>
                        <div><span className="text-slate-400">Facility</span> <span className="text-slate-700">{m.facility_name}</span></div>
                        <div className="col-span-2 md:col-span-4"><span className="text-slate-400">Time</span> <span className="text-slate-700 font-mono">{fmtTs(m.ts_ms)}</span></div>
                      </div>
                      <div className="bg-slate-900 text-green-400 font-mono text-[11px] rounded-lg px-3 py-2 break-all leading-relaxed">
                        {m.raw || m.message}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {pages > 1 && (
            <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-30 transition-colors">
                ← Previous
              </button>
              <span className="text-xs text-slate-400">Page {page + 1} of {pages}</span>
              <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
                className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-30 transition-colors">
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Syslog tab content ────────────────────────────────────────────────────────

function SyslogTab({ devices }: { devices: any[] }) {
  const [deviceId,    setDeviceId]    = useState('')
  const [windowMins,  setWindowMins]  = useState(1440)
  const [severityMax, setSeverityMax] = useState<number | null>(null)
  const [program,     setProgram]     = useState('')
  const [query,       setQuery]       = useState('')
  const [queryInput,  setQueryInput]  = useState('')

  const hasFilters = severityMax !== null || !!program || !!query

  const clearFilters = () => {
    setSeverityMax(null)
    setProgram('')
    setQuery('')
    setQueryInput('')
  }

  return (
    <>
      {/* Syslog filter bar */}
      <div className="px-6 py-3 border-b border-slate-100 bg-white shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Search */}
          <form onSubmit={e => { e.preventDefault(); setQuery(queryInput) }} className="flex items-center gap-1.5">
            <input
              value={queryInput}
              onChange={e => setQueryInput(e.target.value)}
              placeholder="Search messages…"
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs w-48 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            />
            <button type="submit" className="px-3 py-1.5 bg-slate-800 text-white text-xs rounded-lg hover:bg-slate-700 transition-colors">
              Search
            </button>
          </form>

          {/* Device filter */}
          <select value={deviceId} onChange={e => setDeviceId(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-600">
            <option value="">All devices</option>
            {devices.map((d: any) => <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>)}
          </select>

          {/* Time window */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {TIME_WINDOWS.map(w => (
              <button key={w.minutes} onClick={() => setWindowMins(w.minutes)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  windowMins === w.minutes ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                } ${w.minutes !== 15 ? 'border-l border-slate-200' : ''}`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {hasFilters && (
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            {severityMax !== null && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 rounded-full text-xs text-red-700">
                sev ≤ {SEV_ORDER[severityMax]}
                <button onClick={() => setSeverityMax(null)} aria-label="Clear severity filter" className="text-red-400 hover:text-red-700 ml-0.5">×</button>
              </span>
            )}
            {program && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-mono">
                {program}
                <button onClick={() => setProgram('')} aria-label="Clear program filter" className="text-blue-400 hover:text-blue-700 ml-0.5">×</button>
              </span>
            )}
            {query && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-50 border border-purple-200 rounded-full text-xs text-purple-700">
                "{query}"
                <button onClick={() => { setQuery(''); setQueryInput('') }} aria-label="Clear search query" className="text-purple-400 hover:text-purple-700 ml-0.5">×</button>
              </span>
            )}
            <button onClick={clearFilters} className="text-[10px] text-slate-400 hover:text-slate-600 underline">Clear all</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-4">
        <SummaryCards minutes={windowMins} deviceId={deviceId} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <LogRateChart hours={Math.ceil(windowMins / 60) || 1} deviceId={deviceId} />
          </div>
          <SeverityBreakdown minutes={windowMins} deviceId={deviceId}
            onSevFilter={max => setSeverityMax(max === severityMax ? null : max)} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TopPrograms minutes={windowMins} deviceId={deviceId}
            onProgramFilter={p => setProgram(program === p ? '' : p)} />
          <TopDevices minutes={windowMins} onSelectDevice={setDeviceId} />
        </div>

        <MessageTable
          minutes={windowMins} deviceId={deviceId}
          severityMax={severityMax} program={program} query={query}
        />
      </div>
    </>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type LogTab = 'syslog' | 'traps'

export default function SyslogPage() {
  const [activeTab, setActiveTab] = useState<LogTab>('syslog')

  const { data: devicesResp } = useQuery({
    queryKey: ['devices-list'],
    queryFn:  () => fetchDevices({ limit: 500 }),
  })
  const devices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-slate-800">Logging</h1>
            <p className="text-xs text-slate-400 mt-0.5">Syslog · SNMP Traps</p>
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            <button
              onClick={() => setActiveTab('syslog')}
              className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                activeTab === 'syslog' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
              }`}>
              Syslog
            </button>
            <button
              onClick={() => setActiveTab('traps')}
              className={`px-4 py-1.5 text-xs font-medium transition-colors border-l border-slate-200 ${
                activeTab === 'traps' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
              }`}>
              Traps
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'syslog' && <SyslogTab devices={devices} />}
      {activeTab === 'traps'  && <TrapsTab  devices={devices} />}
    </div>
  )
}
