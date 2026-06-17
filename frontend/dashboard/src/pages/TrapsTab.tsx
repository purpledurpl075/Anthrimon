import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchTraps, fetchTrapSummary, fetchTrapRate, fetchTrapTopTypes, fetchTrapTopDevices } from '../api/devices'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'
import { fmtNum, fmtTs, fmtIso, TIME_WINDOWS } from './logHelpers'

// ── Severity / alert styling ─────────────────────────────────────────────────

const TRAP_SEV_ORDER = ['critical', 'warning', 'info'] as const

const TRAP_SEV_COLOR: Record<string, string> = {
  critical: '#dc2626',
  warning:  '#d97706',
  info:     '#64748b',
}

const TRAP_SEV_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning:  'bg-yellow-100 text-yellow-700',
  info:     'bg-slate-100 text-slate-600',
}

const ALERT_SEV_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-yellow-100 text-yellow-700',
  warning:  'bg-yellow-50 text-yellow-600',
  info:     'bg-blue-50 text-blue-600',
}

const ALERT_STATUS_BG: Record<string, string> = {
  open:         'text-red-600 bg-red-50',
  acknowledged: 'text-yellow-600 bg-yellow-50',
  resolved:     'text-green-600 bg-green-50',
}

const CATEGORY_LABEL: Record<string, string> = {
  standard: 'Standard', bgp: 'BGP', ospf: 'OSPF', isis: 'IS-IS', mpls: 'MPLS',
  stp: 'STP', lldp: 'LLDP', vrrp: 'VRRP', arista: 'Arista', aruba_cx: 'Aruba CX',
  hp: 'HP', cisco: 'Cisco', juniper: 'Juniper', unknown: 'Unknown',
}

// ── Trap rate mini chart ──────────────────────────────────────────────────────

function TrapRateChart({ hours, deviceId }: { hours: number; deviceId: string }) {
  const { data = [] } = useQuery({
    queryKey:        ['trap-rate', hours, deviceId],
    queryFn:         () => fetchTrapRate(hours, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const byHour = useMemo(() => {
    const m: Record<number, Record<string, number>> = {}
    for (const p of data) {
      if (!m[p.ts_ms]) m[p.ts_ms] = {}
      m[p.ts_ms][p.severity] = (m[p.ts_ms][p.severity] ?? 0) + p.count
    }
    return Object.entries(m).sort(([a], [b]) => Number(a) - Number(b))
  }, [data])

  if (byHour.length < 2) return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-3">Trap rate</h2>
      <div className="flex items-center justify-center h-20 text-xs text-slate-300">No data yet</div>
    </div>
  )

  const maxTotal = Math.max(...byHour.map(([, sevs]) => Object.values(sevs).reduce((a, b) => a + b, 0)), 1)
  const barW = 100 / byHour.length

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-800">Trap rate</h2>
        <div className="flex items-center gap-3 flex-wrap">
          {TRAP_SEV_ORDER.map(s => (
            <span key={s} className="flex items-center gap-1 text-[10px] text-slate-500">
              <span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: TRAP_SEV_COLOR[s] }} />
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
              {TRAP_SEV_ORDER.map(sev => {
                const n = sevs[sev] ?? 0
                if (!n) return null
                const h = Math.max((n / maxTotal) * 78, 1)
                y -= h
                return (
                  <rect key={sev} x={i * barW + 0.2} y={y} width={barW - 0.4} height={h}
                    fill={TRAP_SEV_COLOR[sev]} fillOpacity={0.85} />
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

function TrapSummaryCards({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['trap-summary', minutes, deviceId],
    queryFn:         () => fetchTrapSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const bySev    = data?.by_severity ?? {}
  const critical = bySev.critical ?? 0
  const warning  = bySev.warning ?? 0

  const cards = [
    { label: 'Total traps',    value: data ? fmtNum(data.total)          : '—', accent: '#6366f1' },
    { label: 'Critical',       value: data ? fmtNum(critical)            : '—', accent: critical > 0 ? '#dc2626' : '#94a3b8' },
    { label: 'Warning',        value: data ? fmtNum(warning)             : '—', accent: warning  > 0 ? '#d97706' : '#94a3b8' },
    { label: 'Active devices', value: data ? String(data.active_devices) : '—', accent: '#0891b2' },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map(c => (
        <div key={c.label} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
          <p className="text-xs text-slate-400 mb-1">{c.label}</p>
          <p className="text-xl font-bold text-slate-800 tabular-nums">
            {isLoading ? <span className="text-slate-300">…</span> : c.value}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── Severity breakdown ────────────────────────────────────────────────────────

function TrapSeverityBreakdown({ minutes, deviceId, onSevFilter }: {
  minutes: number; deviceId: string; onSevFilter: (sev: string | null) => void
}) {
  const { data } = useQuery({
    queryKey:        ['trap-summary', minutes, deviceId],
    queryFn:         () => fetchTrapSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const bySev = data?.by_severity ?? {}
  const total = data?.total ?? 0

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">By severity</h2>
      {total === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No traps</p>
      ) : (
        <div className="space-y-2">
          {TRAP_SEV_ORDER.map(sev => {
            const n = bySev[sev] ?? 0
            return (
              <button key={sev} onClick={() => onSevFilter(n > 0 ? sev : null)}
                className={`w-full flex items-center gap-2 text-left group ${n === 0 ? 'opacity-30' : ''}`}
                disabled={n === 0}>
                <span className="text-xs font-medium w-16 shrink-0 capitalize text-slate-600 group-hover:text-blue-600 transition-colors">{sev}</span>
                <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${total > 0 ? (n / total) * 100 : 0}%`, backgroundColor: TRAP_SEV_COLOR[sev] }} />
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

// ── Top trap types ────────────────────────────────────────────────────────────

function TopTrapTypes({ minutes, deviceId, onTypeFilter }: {
  minutes: number; deviceId: string; onTypeFilter: (t: string) => void
}) {
  const { data = [] } = useQuery({
    queryKey:        ['trap-top-types', minutes, deviceId],
    queryFn:         () => fetchTrapTopTypes(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })

  const maxTotal = Math.max(...data.map(t => t.total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">Top trap types</h2>
      {data.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No data</p>
      ) : (
        <div className="space-y-2.5">
          {data.map(t => (
            <div key={t.trap_type} className="flex items-center gap-2 group">
              <button onClick={() => onTypeFilter(t.trap_type)}
                className="text-xs font-medium text-slate-700 hover:text-blue-600 transition-colors w-36 shrink-0 truncate text-left flex items-center gap-1.5"
                title={t.trap_type}>
                <span className="truncate">{t.label}</span>
                {!t.is_cataloged && (
                  <span className="shrink-0 text-[9px] font-bold px-1 py-px rounded bg-amber-100 text-amber-700" title="Uncatalogued trap type">?</span>
                )}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-400 transition-all"
                  style={{ width: `${(t.total / maxTotal) * 100}%` }} />
              </div>
              {t.critical > 0 && (
                <span className="text-[10px] font-bold text-red-500 tabular-nums shrink-0 w-6 text-right">{fmtNum(t.critical)}</span>
              )}
              <span className="text-xs font-bold text-slate-600 tabular-nums shrink-0 w-10 text-right">{fmtNum(t.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top devices ───────────────────────────────────────────────────────────────

function TopTrapDevices({ minutes, onSelectDevice }: { minutes: number; onSelectDevice: (id: string) => void }) {
  const { data = [] } = useQuery({
    queryKey:        ['trap-top-devices', minutes],
    queryFn:         () => fetchTrapTopDevices(minutes),
    refetchInterval: 30_000,
  })

  const maxTotal = Math.max(...data.map(d => d.total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top devices by trap volume</h2>
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
              {d.critical > 0 && (
                <span className="text-xs font-bold text-red-500 tabular-nums shrink-0">{fmtNum(d.critical)}</span>
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

// ── Trap table ────────────────────────────────────────────────────────────────

function TrapTable({ minutes, deviceId, severity, trapType, query }: {
  minutes: number; deviceId: string
  severity: string | null; trapType: string; query: string
}) {
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const LIMIT = 100

  useEffect(() => { setPage(0) }, [minutes, deviceId, severity, trapType, query])

  const params = {
    device_id: deviceId || undefined,
    trap_type: trapType || undefined,
    severity:  severity ?? undefined,
    q:         query || undefined,
    minutes,
    limit:  LIMIT,
    offset: page * LIMIT,
  }

  const { data, isLoading, isFetching } = useQuery({
    queryKey:        ['traps', params],
    queryFn:         () => fetchTraps(params),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pages = Math.ceil(total / LIMIT)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-800">SNMP Traps</h2>
          {isFetching && <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
        </div>
        <span className="text-xs text-slate-400">{fmtNum(total)} total</span>
      </div>

      {isLoading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-400">Loading…</div>
      ) : items.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-slate-400">No traps match the current filters</p>
          <p className="text-xs text-slate-300 mt-1">Configure SNMP trap destination to this host on UDP :162</p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-slate-50">
            {items.map(trap => {
              const isOpen = expanded === trap.id
              const sevBg  = TRAP_SEV_BG[trap.severity] ?? TRAP_SEV_BG.info
              return (
                <div key={trap.id}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : trap.id)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors text-left group"
                  >
                    <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize min-w-[4rem] text-center ${sevBg}`}>
                      {trap.severity}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-slate-400 w-36 hidden md:block">
                      {fmtIso(trap.received_at)}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-600 w-28 truncate hidden lg:block font-medium">
                      {trap.hostname || trap.source_ip}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-indigo-600 w-36 truncate hidden xl:block" title={trap.label}>
                      {trap.trap_type}
                    </span>
                    <span className="flex-1 text-xs text-slate-500 truncate font-mono" title={trap.oid}>
                      {trap.oid_name ?? trap.oid}
                    </span>
                    {!trap.is_cataloged && (
                      <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title="Uncatalogued trap type">
                        uncatalogued
                      </span>
                    )}
                    {trap.alert_id && (
                      <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${ALERT_SEV_BG[trap.alert_severity ?? ''] ?? 'bg-red-100 text-red-700'}`} title="Correlates with an active alert">
                        alert
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-slate-400 hidden sm:block">
                      {trap.snmp_version}
                    </span>
                    <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-3 bg-slate-50 border-t border-slate-100">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-[11px] mt-2 mb-2">
                        <div><span className="text-slate-400">Device</span> <Link to={`/devices/${trap.device_id}`} className="text-blue-600 hover:underline font-medium">{trap.hostname || '—'}</Link></div>
                        <div><span className="text-slate-400">Source IP</span> <span className="text-slate-700 font-mono">{trap.source_ip}</span></div>
                        <div><span className="text-slate-400">SNMP</span> <span className="text-slate-700">{trap.snmp_version}</span></div>
                        <div><span className="text-slate-400">Trap type</span> <span className="text-slate-700 font-mono">{trap.trap_type}</span></div>
                        <div className="col-span-2 md:col-span-3">
                          <span className="text-slate-400">OID</span>{' '}
                          <span className="text-slate-700 font-mono">{trap.oid}</span>
                          {trap.oid_name && <span className="text-slate-400 font-mono"> ({trap.oid_name})</span>}
                        </div>
                        <div className="col-span-2 md:col-span-3"><span className="text-slate-400">Time</span> <span className="text-slate-700 font-mono">{fmtIso(trap.received_at)}</span></div>
                      </div>

                      {/* What this means */}
                      <div className="mt-2 mb-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-semibold text-slate-700">{trap.label}</span>
                          <span className="text-[10px] text-slate-400 uppercase tracking-wide">{CATEGORY_LABEL[trap.category] ?? trap.category}</span>
                          {!trap.is_cataloged && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                              Uncatalogued — generic vendor notification
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">{trap.description}</p>
                      </div>

                      {/* Correlated alert */}
                      {trap.alert_id && (
                        <div className="mt-1 mb-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] text-red-700">Correlates with alert:</span>
                          <Link to={`/alerts/${trap.alert_id}`} className="text-[11px] font-medium text-red-700 hover:underline truncate">
                            {trap.alert_title}
                          </Link>
                          {trap.alert_status && (
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${ALERT_STATUS_BG[trap.alert_status] ?? ''}`}>
                              {trap.alert_status}
                            </span>
                          )}
                        </div>
                      )}

                      {trap.varbinds && trap.varbinds.length > 0 && (
                        <div className="mt-1">
                          <p className="text-[10px] text-slate-400 mb-1">Varbinds</p>
                          <div className="bg-slate-900 text-green-400 font-mono text-[11px] rounded-lg px-3 py-2 space-y-0.5">
                            {trap.varbinds.map((v, i) => (
                              <div key={i}><span className="text-slate-400" title={v.name ? v.oid : undefined}>{v.name ?? v.oid}</span> <span className="text-slate-300">=</span> {String(v.value)}</div>
                            ))}
                          </div>
                        </div>
                      )}
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

// ── Traps tab ─────────────────────────────────────────────────────────────────

export default function TrapsTab({ devices }: { devices: any[] }) {
  const [deviceId,   setDeviceId]   = useState('')
  const [windowMins, setWindowMins] = useState(1440)
  const [severity,   setSeverity]   = useState<string | null>(null)
  const [trapType,   setTrapType]   = useState('')
  const [query,      setQuery]      = useState('')
  const [queryInput, setQueryInput] = useState('')

  const hasFilters = severity !== null || !!trapType || !!query

  const clearFilters = () => {
    setSeverity(null)
    setTrapType('')
    setQuery('')
    setQueryInput('')
  }

  return (
    <>
      {/* Filter bar */}
      <div className="px-6 py-3 border-b border-slate-100 bg-white shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Search */}
          <form onSubmit={e => { e.preventDefault(); setQuery(queryInput) }} className="flex items-center gap-1.5">
            <input
              value={queryInput}
              onChange={e => setQueryInput(e.target.value)}
              placeholder="Search traps…"
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

          {/* Severity filter */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {([null, ...TRAP_SEV_ORDER] as (string | null)[]).map((s, i) => (
              <button key={s ?? 'all'} onClick={() => setSeverity(s)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  severity === s ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                } ${i !== 0 ? 'border-l border-slate-200' : ''}`}>
                {s ?? 'All'}
              </button>
            ))}
          </div>

          {/* Time window */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200 ml-auto">
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
            {severity !== null && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 rounded-full text-xs text-red-700 capitalize">
                {severity}
                <button onClick={() => setSeverity(null)} className="text-red-400 hover:text-red-700 ml-0.5">×</button>
              </span>
            )}
            {trapType && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-mono">
                {trapType}
                <button onClick={() => setTrapType('')} className="text-blue-400 hover:text-blue-700 ml-0.5">×</button>
              </span>
            )}
            {query && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-50 border border-purple-200 rounded-full text-xs text-purple-700">
                "{query}"
                <button onClick={() => { setQuery(''); setQueryInput('') }} className="text-purple-400 hover:text-purple-700 ml-0.5">×</button>
              </span>
            )}
            <button onClick={clearFilters} className="text-[10px] text-slate-400 hover:text-slate-600 underline">Clear all</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-4">
        <TrapSummaryCards minutes={windowMins} deviceId={deviceId} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <TrapRateChart hours={Math.ceil(windowMins / 60) || 1} deviceId={deviceId} />
          </div>
          <TrapSeverityBreakdown minutes={windowMins} deviceId={deviceId}
            onSevFilter={sev => setSeverity(sev === severity ? null : sev)} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TopTrapTypes minutes={windowMins} deviceId={deviceId}
            onTypeFilter={t => setTrapType(trapType === t ? '' : t)} />
          <TopTrapDevices minutes={windowMins} onSelectDevice={setDeviceId} />
        </div>

        <TrapTable
          minutes={windowMins} deviceId={deviceId}
          severity={severity} trapType={trapType} query={query}
        />
      </div>
    </>
  )
}
