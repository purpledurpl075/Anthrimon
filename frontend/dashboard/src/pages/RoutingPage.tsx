import { useState, useMemo, type ReactNode } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  fetchAllBGPSessions, fetchBGPSummary, fetchBGPPrefixTotals,
  fetchBGPFlapLog, fetchBGPPrefixHistory, fetchBGPSessionEvents,
  fetchOSPFNeighbors, fetchOSPFAreas,
  fetchISISNeighbors, fetchISISSummary, fetchISISAreas, fetchRoutes,
  fetchISISCircuitLevels, fetchISISLsps, fetchISISTopology,
  type BGPSession, type BGPFlapEvent, type OSPFNeighbor, type ISISNeighbor, type ISISArea, type RouteEntryDTO,
  type ISISCircuitLevel, type ISISLsp, type ISISTopologyNode,
} from '../api/bgp'
import TimeSeriesChart from '../components/TimeSeriesChart'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUptime(secs: number | null): string {
  if (!secs || secs <= 0) return '—'
  if (secs < 60)    return `${secs}s`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`
}

function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}

// ── BGP constants ─────────────────────────────────────────────────────────────

const BGP_STATE_CLS: Record<string, string> = {
  established: 'text-green-700 bg-green-50',
  active:      'text-amber-700 bg-amber-50',
  idle:        'text-slate-600 bg-slate-100',
  connect:     'text-blue-700 bg-blue-50',
  opensent:    'text-purple-700 bg-purple-50',
  openconfirm: 'text-purple-700 bg-purple-50',
}

const BGP_STATE_COLOR: Record<string, string> = {
  established: '#16a34a',
  active:      '#d97706',
  connect:     '#2563eb',
  opensent:    '#7c3aed',
  openconfirm: '#7c3aed',
  idle:        '#94a3b8',
}

// ── OSPF constants ────────────────────────────────────────────────────────────

const OSPF_STATE_CLS: Record<string, string> = {
  full:      'text-green-700 bg-green-50',
  loading:   'text-blue-700 bg-blue-50',
  exchange:  'text-blue-700 bg-blue-50',
  exstart:   'text-blue-700 bg-blue-50',
  two_way:   'text-amber-700 bg-amber-50',
  init:      'text-orange-700 bg-orange-50',
  attempt:   'text-orange-700 bg-orange-50',
  down:      'text-red-700 bg-red-50',
  unknown:   'text-slate-600 bg-slate-100',
}

const OSPF_STATE_COLOR: Record<string, string> = {
  full:      '#16a34a',
  loading:   '#2563eb',
  exchange:  '#2563eb',
  exstart:   '#2563eb',
  two_way:   '#d97706',
  init:      '#ea580c',
  attempt:   '#ea580c',
  down:      '#dc2626',
  unknown:   '#94a3b8',
}

const PEER_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d']

const BGP_TIME_WINDOWS = [
  { label: '1h',  hours: 1   },
  { label: '6h',  hours: 6   },
  { label: '24h', hours: 24  },
  { label: '7d',  hours: 168 },
]

// ── Tiny sparkline ────────────────────────────────────────────────────────────

function MiniSparkline({ data, color = '#2563eb', w = 80, h = 24 }: { data: [number, number][]; color?: string; w?: number; h?: number }) {
  if (data.length < 2) return <span className="text-slate-300 text-[10px]">—</span>
  const vals  = data.map(([, v]) => v)
  const times = data.map(([t]) => t)
  const minV  = Math.min(...vals), maxV = Math.max(...vals)
  const rangeV = maxV - minV || 1
  const minT  = Math.min(...times), maxT = Math.max(...times)
  const rangeT = maxT - minT || 1
  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 2 - ((v - minV) / rangeV) * (h - 6)
  const pts  = data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')
  const area = `M${sx(times[0])},${h} L${data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' L')} L${sx(times[times.length - 1])},${h} Z`
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <path d={area} fill={color} fillOpacity={0.1} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Top receivers bar chart ───────────────────────────────────────────────────

function TopReceiversChart({ receivers }: { receivers: { device: string; peer_ip: string; peer_asn: number | null; prefixes_rx: number }[] }) {
  if (receivers.length === 0) return null
  const max = Math.max(...receivers.map(r => r.prefixes_rx), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">Top prefix receivers</h3>
      <div className="space-y-2.5">
        {receivers.map((r, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-32 shrink-0">
              <div className="text-xs font-medium text-slate-700 truncate">{r.device}</div>
              <div className="font-mono text-[10px] text-slate-400">{r.peer_ip}{r.peer_asn ? ` AS${r.peer_asn}` : ''}</div>
            </div>
            <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full transition-all"
                style={{ width: `${(r.prefixes_rx / max) * 100}%`, backgroundColor: PEER_COLORS[i % PEER_COLORS.length] }}
              />
            </div>
            <div className="w-12 text-xs font-medium text-slate-700 text-right tabular-nums">
              {fmtNum(r.prefixes_rx)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── BGP session event drawer ──────────────────────────────────────────────────

function BGPEventDrawer({ session }: { session: BGPSession }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey:  ['bgp-events', session.id],
    queryFn:   () => fetchBGPSessionEvents(session.id),
    staleTime: 60_000,
  })
  return (
    <tr>
      <td colSpan={10} className="bg-slate-50 border-b border-slate-100 px-6 py-4">
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
          State transitions — {session.peer_ip}{session.peer_asn ? ` AS${session.peer_asn}` : ''}
        </div>
        {isLoading ? (
          <span className="text-xs text-slate-400">Loading…</span>
        ) : events.length === 0 ? (
          <span className="text-xs text-slate-400">No transitions recorded yet.</span>
        ) : (
          <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {events.map(e => (
              <div key={e.id} className="flex items-center gap-2 text-xs">
                <span className="text-slate-400 tabular-nums w-40 shrink-0">{new Date(e.recorded_at).toLocaleString()}</span>
                <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.prev_state] ?? 'text-slate-600 bg-slate-100'}`}>{e.prev_state}</span>
                <span className="text-slate-400">→</span>
                <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.new_state] ?? 'text-slate-600 bg-slate-100'}`}>{e.new_state}</span>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  )
}

// ── BGP: sessions tab ─────────────────────────────────────────────────────────

type SessionFilter = 'all' | 'ibgp' | 'ebgp' | 'down'

function fmtAgo(ts: string | null): string {
  if (!ts) return '—'
  return fmtUptime(Math.floor((Date.now() - new Date(ts).getTime()) / 1000)) + ' ago'
}

function BGPSessionsTab({ sessions, isLoading, pfxByDevicePeer }: {
  sessions:         BGPSession[]
  isLoading:        boolean
  pfxByDevicePeer:  Record<string, Record<string, [number, number][]>>
}) {
  const [filter, setFilter]   = useState<SessionFilter>('all')
  const [vrf, setVrf]         = useState('all')
  const [search, setSearch]   = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [rowExpanded, setRowExpanded] = useState<string | null>(null)

  const vrfs = useMemo(() => {
    const set = new Set(sessions.map(s => s.vrf || 'default'))
    return set.size > 1 ? ['all', ...Array.from(set).sort()] : []
  }, [sessions])

  const filteredSessions = useMemo(() => {
    let s = sessions
    if (filter === 'ibgp') s = s.filter(x => x.session_type === 'iBGP')
    if (filter === 'ebgp') s = s.filter(x => x.session_type === 'eBGP')
    if (filter === 'down') s = s.filter(x => x.session_state !== 'established')
    if (vrf !== 'all') s = s.filter(x => (x.vrf || 'default') === vrf)
    if (search.trim()) {
      const q = search.toLowerCase()
      s = s.filter(x =>
        x.device_name.toLowerCase().includes(q) ||
        x.peer_ip.toLowerCase().includes(q) ||
        (x.peer_asn ? `as${x.peer_asn}`.includes(q) : false) ||
        (x.peer_description ?? '').toLowerCase().includes(q)
      )
    }
    return s
  }, [sessions, filter, vrf, search])

  // Group by device
  const byDevice = useMemo(() => {
    const m = new Map<string, { id: string; name: string; sessions: BGPSession[] }>()
    for (const s of filteredSessions) {
      if (!m.has(s.device_id)) m.set(s.device_id, { id: s.device_id, name: s.device_name, sessions: [] })
      m.get(s.device_id)!.sessions.push(s)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [filteredSessions])

  // Default: all devices expanded
  const isDeviceExpanded = (id: string) => expanded[id] !== false

  const toggleDevice = (id: string) => setExpanded(e => ({ ...e, [id]: !isDeviceExpanded(id) }))

  const counts = useMemo(() => ({
    all:  sessions.length,
    ibgp: sessions.filter(s => s.session_type === 'iBGP').length,
    ebgp: sessions.filter(s => s.session_type === 'eBGP').length,
    down: sessions.filter(s => s.session_state !== 'established').length,
  }), [sessions])

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>
  if (sessions.length === 0) return (
    <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
      <p className="text-sm text-slate-400">No BGP sessions found</p>
      <p className="text-xs text-slate-300 mt-1">BGP data is collected via SNMP bgpPeerTable (RFC 1657) or ArubaOS-CX REST API</p>
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Search + filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search device, peer IP, AS…"
            className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-60"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {([['all', `All (${counts.all})`], ['ibgp', `iBGP (${counts.ibgp})`], ['ebgp', `eBGP (${counts.ebgp})`], ['down', `Down (${counts.down})`]] as [SessionFilter, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === k ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              } ${k === 'down' && counts.down > 0 ? 'ring-1 ring-red-200' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
        {vrfs.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">VRF</span>
            {vrfs.map(v => (
              <button key={v} onClick={() => setVrf(v)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${vrf === v ? 'bg-purple-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {v === 'all' ? 'All' : v}
              </button>
            ))}
          </div>
        )}
      </div>

      {byDevice.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-sm text-slate-400">
          No sessions match
        </div>
      ) : (
        <div className="space-y-2">
          {byDevice.map(dev => {
            const est    = dev.sessions.filter(s => s.session_state === 'established').length
            const flaps  = dev.sessions.filter(s => s.flap_count > 1).length
            const totalPfx = dev.sessions.reduce((a, s) => a + (s.prefixes_received ?? 0), 0)
            const allOk  = est === dev.sessions.length && flaps === 0
            const open   = isDeviceExpanded(dev.id)

            return (
              <div key={dev.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                {/* Device header */}
                <button
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => toggleDevice(dev.id)}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${allOk ? 'bg-green-500' : 'bg-red-500'}`} />
                  <Link
                    to={`/devices/${dev.id}`}
                    className="text-sm font-semibold text-slate-800 hover:text-blue-600"
                    onClick={e => e.stopPropagation()}
                  >
                    {dev.name}
                  </Link>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    est === dev.sessions.length ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'
                  }`}>
                    {est}/{dev.sessions.length} established
                  </span>
                  {totalPfx > 0 && (
                    <span className="text-xs text-slate-500">{fmtNum(totalPfx)} pfx</span>
                  )}
                  {flaps > 0 && (
                    <span className="text-xs font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                      {flaps} flapping
                    </span>
                  )}
                  <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
                </button>

                {/* Sessions table */}
                {open && (
                  <table className="w-full text-sm border-t border-slate-100">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="text-left px-5 py-2 text-xs font-medium text-slate-400">Peer IP</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">AS</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Type</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">State</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Pfx Rx / Tx</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">24h</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Updates In/Out</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Flaps</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Up / Changed</th>
                        <th className="w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {dev.sessions.map(s => {
                        const spark = pfxByDevicePeer[s.device_id]?.[s.peer_ip] ?? []
                        const isOpen = rowExpanded === s.id
                        return (
                          <>
                            <tr
                              key={s.id}
                              className="hover:bg-slate-50 transition-colors cursor-pointer"
                              onClick={() => setRowExpanded(isOpen ? null : s.id)}
                            >
                              <td className="px-5 py-2.5">
                                <div className="font-mono text-xs text-slate-700">{s.peer_ip}</div>
                                {s.peer_router_id && s.peer_router_id !== s.peer_ip && (
                                  <div className="font-mono text-[10px] text-slate-400">{s.peer_router_id}</div>
                                )}
                                {s.peer_description && (
                                  <div className="text-[10px] text-slate-400 italic">{s.peer_description}</div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-slate-500">
                                {s.peer_asn ? `AS${s.peer_asn}` : '—'}
                              </td>
                              <td className="px-4 py-2.5">
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                  s.session_type === 'iBGP' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                                }`}>
                                  {s.session_type}
                                </span>
                              </td>
                              <td className="px-4 py-2.5">
                                <span className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: BGP_STATE_COLOR[s.session_state] ?? '#94a3b8' }} />
                                  <span className={`text-xs font-medium capitalize px-1.5 py-0.5 rounded ${BGP_STATE_CLS[s.session_state] ?? 'text-slate-600 bg-slate-100'}`}>
                                    {s.session_state}
                                  </span>
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                <div className="text-xs font-medium text-slate-700">
                                  {s.prefixes_received != null ? fmtNum(s.prefixes_received) : '—'}
                                </div>
                                {s.prefixes_advertised != null && s.prefixes_advertised > 0 && (
                                  <div className="text-[10px] text-slate-400">{fmtNum(s.prefixes_advertised)} tx</div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                <MiniSparkline data={spark} color={BGP_STATE_COLOR[s.session_state] ?? '#2563eb'} />
                              </td>
                              <td className="px-4 py-2.5 text-xs text-slate-500 text-right tabular-nums">
                                {s.in_updates > 0 || s.out_updates > 0
                                  ? `${fmtNum(s.in_updates)} / ${fmtNum(s.out_updates)}`
                                  : '—'}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {s.flap_count > 1
                                  ? <span className="text-xs font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">{s.flap_count}</span>
                                  : <span className="text-xs text-slate-300">0</span>
                                }
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {s.session_state === 'established'
                                  ? <span className="text-xs text-slate-500">{fmtUptime(s.uptime_seconds)}</span>
                                  : s.last_state_change
                                    ? <span className="text-xs text-amber-600" title={`Entered ${s.session_state} at ${new Date(s.last_state_change).toLocaleString()}`}>{fmtAgo(s.last_state_change)}</span>
                                    : <span className="text-xs text-slate-300">—</span>
                                }
                              </td>
                              <td className="px-4 py-2.5 text-slate-300 text-right text-[10px]">{isOpen ? '▲' : '▼'}</td>
                            </tr>
                            {isOpen && <BGPEventDrawer key={`d-${s.id}`} session={s} />}
                          </>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── BGP: prefix trends tab ────────────────────────────────────────────────────

function BGPPrefixTrendsTab({ sessions }: { sessions: BGPSession[] }) {
  const devices = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sessions) if (!seen.has(s.device_id)) seen.set(s.device_id, s.device_name)
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions])

  const [deviceId, setDeviceId] = useState('')
  const [hours, setHours]       = useState(24)
  const selectedDevice = deviceId || devices[0]?.id || ''

  const { data: history, isLoading } = useQuery({
    queryKey:  ['bgp-prefix-history', selectedDevice, hours],
    queryFn:   () => fetchBGPPrefixHistory(selectedDevice, hours),
    enabled:   !!selectedDevice,
    staleTime: 5 * 60_000,
  })

  if (devices.length === 0) return (
    <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-400">No BGP sessions found</div>
  )

  const pfxSeries = (history?.prefix_count ?? []).map((s, i) => ({
    name: `${s.peer_ip}${s.peer_asn ? ` AS${s.peer_asn}` : ''}`,
    color: PEER_COLORS[i % PEER_COLORS.length],
    data: s.values,
  }))
  const updSeries = (history?.update_rate ?? []).map((s, i) => ({
    name: `${s.peer_ip}${s.peer_asn ? ` AS${s.peer_asn}` : ''}`,
    color: PEER_COLORS[i % PEER_COLORS.length],
    data: s.values,
  }))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Device</label>
          <select
            value={deviceId || devices[0]?.id}
            onChange={e => setDeviceId(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex gap-1">
          {BGP_TIME_WINDOWS.map(w => (
            <button key={w.hours} onClick={() => setHours(w.hours)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${hours === w.hours ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Prefix count */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Prefixes received per peer</h3>
        {isLoading
          ? <div className="h-40 flex items-center justify-center text-slate-300 text-sm">Loading…</div>
          : <TimeSeriesChart series={pfxSeries} height={160} yFmt={fmtNum} empty="No prefix data in this window" />
        }
        {pfxSeries.length > 1 && (
          <div className="flex flex-wrap gap-3 mt-3">
            {pfxSeries.map(s => (
              <div key={s.name} className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className="w-3 h-1.5 rounded-sm inline-block" style={{ backgroundColor: s.color }} />
                {s.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Update rate */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">UPDATE message rate (per min)</h3>
        {isLoading
          ? <div className="h-32 flex items-center justify-center text-slate-300 text-sm">Loading…</div>
          : <TimeSeriesChart series={updSeries} height={120} yFmt={v => `${v.toFixed(2)}/m`} empty="No update rate data in this window" />
        }
      </div>
    </div>
  )
}


// ── BGP: flap log tab ─────────────────────────────────────────────────────────

function BGPFlapLogTab() {
  const [limit, setLimit] = useState(50)
  const { data: events = [], isLoading } = useQuery({
    queryKey:        ['bgp-flap-log', limit],
    queryFn:         () => fetchBGPFlapLog(limit),
    refetchInterval: 30_000,
  })
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Show last</span>
        {[20, 50, 100, 200].map(n => (
          <button key={n} onClick={() => setLimit(n)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${limit === n ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {n}
          </button>
        ))}
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-400">Loading…</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">No state transitions recorded</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Time</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Device</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Peer</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">AS</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Transition</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {events.map((e: BGPFlapEvent, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-xs text-slate-500 tabular-nums whitespace-nowrap">{new Date(e.recorded_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-xs font-medium text-slate-700">{e.device}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{e.peer_ip}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{e.peer_asn ? `AS${e.peer_asn}` : '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.prev_state] ?? 'text-slate-600 bg-slate-100'}`}>{e.prev_state}</span>
                      <span className="text-slate-400">→</span>
                      <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.new_state] ?? 'text-slate-600 bg-slate-100'}`}>{e.new_state}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── BGP panel ─────────────────────────────────────────────────────────────────

function BGPPanel() {
  const [tab, setTab] = useState<'sessions' | 'trends' | 'flap-log' | 'routes'>('sessions')

  const { data: sessions = [], isLoading } = useQuery({
    queryKey:        ['bgp-sessions-all'],
    queryFn:         () => fetchAllBGPSessions(),
    refetchInterval: 30_000,
  })
  const { data: summary }  = useQuery({ queryKey: ['bgp-summary'],        queryFn: fetchBGPSummary,       refetchInterval: 30_000 })
  const { data: totals }   = useQuery({ queryKey: ['bgp-prefix-totals'],  queryFn: fetchBGPPrefixTotals,  refetchInterval: 60_000 })

  // Pre-fetch all device prefix histories for sparklines
  const deviceIds = useMemo(() => [...new Set(sessions.map(s => s.device_id))], [sessions])
  const historyResults = useQueries({
    queries: deviceIds.map(id => ({
      queryKey:  ['bgp-prefix-history', id, 24],
      queryFn:   () => fetchBGPPrefixHistory(id, 24),
      staleTime: 5 * 60_000,
      enabled:   tab === 'sessions',
    })),
  })
  const pfxByDevicePeer = useMemo(() => {
    const m: Record<string, Record<string, [number, number][]>> = {}
    deviceIds.forEach((id, i) => {
      const data = historyResults[i]?.data
      if (!data) return
      m[id] = {}
      for (const s of data.prefix_count) m[id][s.peer_ip] = s.values
    })
    return m
  }, [historyResults, deviceIds])

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Sessions</div>
          <div className="text-2xl font-bold text-slate-800">{summary?.total ?? '—'}</div>
          {summary && summary.total > 0 && (
            <div className="flex rounded-full overflow-hidden h-1.5 mt-2">
              {Object.entries(summary.by_state).sort((a, b) => b[1] - a[1]).map(([st, n]) => (
                <div key={st} style={{ width: `${(n / summary.total) * 100}%`, backgroundColor: BGP_STATE_COLOR[st] ?? '#94a3b8' }} title={`${st}: ${n}`} />
              ))}
            </div>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Established</div>
          <div className="text-2xl font-bold text-green-600">{summary?.established ?? '—'}</div>
          {summary && summary.total > 0 && (
            <div className="text-xs text-slate-400 mt-1">{Math.round((summary.established / summary.total) * 100)}% of sessions</div>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Down</div>
          <div className={`text-2xl font-bold ${(summary?.down ?? 0) > 0 ? 'text-red-600' : 'text-slate-400'}`}>{summary?.down ?? '—'}</div>
          {(summary?.down ?? 0) > 0 && <div className="text-xs text-red-400 mt-1">Requires attention</div>}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Total prefixes RX</div>
          <div className="text-2xl font-bold text-slate-800">{totals ? fmtNum(totals.total_rx) : '—'}</div>
          {totals && <div className="text-xs text-slate-400 mt-1">across {totals.established} sessions</div>}
        </div>
      </div>

      {/* Top receivers */}
      {(totals?.top_receivers ?? []).length > 0 && (
        <TopReceiversChart receivers={totals!.top_receivers} />
      )}

      {/* Top flappers callout */}
      {(summary?.top_flappers ?? []).length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
          <div className="text-xs font-semibold text-amber-700 mb-2 uppercase tracking-wide">Flappers</div>
          <div className="flex flex-wrap gap-3">
            {summary!.top_flappers.map(f => (
              <div key={f.session_id} className="flex items-center gap-2 text-xs">
                <span className="font-medium text-amber-800">{f.device_name}</span>
                <span className="font-mono text-amber-700">{f.peer_ip}</span>
                {f.peer_asn && <span className="text-amber-600">AS{f.peer_asn}</span>}
                <span className="font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">{f.flap_count}×</span>
                <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[f.state] ?? 'text-slate-600 bg-slate-100'}`}>{f.state}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div>
        <div className="flex gap-1 border-b border-slate-200 mb-4">
          {([['sessions', 'Sessions'], ['trends', 'Prefix Trends'], ['flap-log', 'Flap Log'], ['routes', 'Routes']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === k ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'sessions'  && <BGPSessionsTab sessions={sessions} isLoading={isLoading} pfxByDevicePeer={pfxByDevicePeer} />}
        {tab === 'trends'    && <BGPPrefixTrendsTab sessions={sessions} />}
        {tab === 'flap-log'  && <BGPFlapLogTab />}
        {tab === 'routes'    && <RoutesPanel protocol="bgp" />}
      </div>
    </div>
  )
}

// ── OSPF panel ────────────────────────────────────────────────────────────────

function OSPFPanel() {
  const [subTab, setSubTab] = useState<'neighbours' | 'routes'>('neighbours')

  const { data: neighbors = [], isLoading } = useQuery({
    queryKey:        ['ospf-neighbors'],
    queryFn:         fetchOSPFNeighbors,
    refetchInterval: 30_000,
  })
  const { data: areas = [] } = useQuery({
    queryKey:        ['ospf-areas'],
    queryFn:         fetchOSPFAreas,
    refetchInterval: 60_000,
  })

  const totalFull    = areas.reduce((a, r) => a + r.full, 0)
  const totalNotFull = areas.reduce((a, r) => a + r.not_full, 0)
  const totalAll     = totalFull + totalNotFull

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Neighbours</div>
          <div className="text-2xl font-bold text-slate-800">{totalAll}</div>
          {totalAll > 0 && (
            <div className="flex rounded-full overflow-hidden h-1.5 mt-2">
              <div style={{ width: `${(totalFull / totalAll) * 100}%` }} className="bg-green-500" />
              <div style={{ width: `${(totalNotFull / totalAll) * 100}%` }} className="bg-red-400" />
            </div>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Full</div>
          <div className="text-2xl font-bold text-green-600">{totalFull}</div>
          {totalAll > 0 && <div className="text-xs text-slate-400 mt-1">{Math.round((totalFull / totalAll) * 100)}% converged</div>}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Not full</div>
          <div className={`text-2xl font-bold ${totalNotFull > 0 ? 'text-red-600' : 'text-slate-400'}`}>{totalNotFull}</div>
          {totalNotFull > 0 && <div className="text-xs text-red-400 mt-1">Not converged</div>}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Areas</div>
          <div className="text-2xl font-bold text-slate-800">{areas.length}</div>
          {areas.length > 0 && (
            <div className="text-xs text-slate-400 mt-1 truncate">
              {areas.map(a => a.area).join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* Area breakdown */}
      {areas.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Area summary</h3>
          <div className="space-y-2">
            {areas.map(a => {
              const pct = a.total > 0 ? Math.round((a.full / a.total) * 100) : 0
              return (
                <div key={`${a.area}-${a.vrf}`} className="flex items-center gap-3">
                  <div className="w-24 shrink-0">
                    <div className="text-xs font-medium text-slate-700">{a.area}</div>
                    {a.vrf !== 'default' && <div className="text-[10px] text-slate-400">vrf:{a.vrf}</div>}
                  </div>
                  <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div className="h-2 rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="w-28 text-xs text-slate-600 text-right tabular-nums">
                    <span className="font-medium text-green-600">{a.full}</span>
                    <span className="text-slate-400">/{a.total}</span>
                    <span className="ml-1 text-slate-400">full</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div>
        <div className="flex gap-1 border-b border-slate-200 mb-4">
          {([['neighbours', 'Neighbours'], ['routes', 'Routes']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setSubTab(k)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${subTab === k ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
        {subTab === 'neighbours' && <OSPFNeighborsTab neighbors={neighbors} />}
        {subTab === 'routes'     && <RoutesPanel protocol="ospf" />}
      </div>
    </div>
  )
}

function OSPFNeighborsTab({ neighbors }: { neighbors: OSPFNeighbor[] }) {
  const [search, setSearch] = useState('')
  const [areaFilter, setAreaFilter] = useState('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const uniqueAreas  = useMemo(() => ['all', ...new Set(neighbors.map(n => n.area))].sort(), [neighbors])

  const filtered = useMemo(() => {
    let n = neighbors
    if (areaFilter !== 'all') n = n.filter(x => x.area === areaFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      n = n.filter(x =>
        x.device_name.toLowerCase().includes(q) ||
        (x.neighbor_ip ?? '').includes(q) ||
        (x.neighbor_router_id ?? '').includes(q) ||
        (x.interface_name ?? '').toLowerCase().includes(q)
      )
    }
    return n
  }, [neighbors, areaFilter, search])

  // Group by device
  const byDevice = useMemo(() => {
    const m = new Map<string, { id: string; name: string; neighbors: OSPFNeighbor[] }>()
    for (const n of filtered) {
      if (!m.has(n.device_id)) m.set(n.device_id, { id: n.device_id, name: n.device_name, neighbors: [] })
      m.get(n.device_id)!.neighbors.push(n)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [filtered])

  const isDeviceOpen = (id: string) => expanded[id] !== false

  return (
    <div className="space-y-3">
      {/* Search + area filter */}
      {neighbors.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search device, neighbour IP…"
              className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-60"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {uniqueAreas.map(a => (
              <button key={a} onClick={() => setAreaFilter(a)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${areaFilter === a ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {a === 'all' ? 'All areas' : `Area ${a}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Neighbours grouped by device */}
      {neighbors.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-sm text-slate-400">No OSPF neighbours found</p>
          <p className="text-xs text-slate-300 mt-1">OSPF data is collected via SNMP ospfNbrTable</p>
        </div>
      ) : byDevice.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-sm text-slate-400">No neighbours match</div>
      ) : (
        <div className="space-y-2">
          {byDevice.map(dev => {
            const full    = dev.neighbors.filter(n => n.state === 'full').length
            const allOk   = full === dev.neighbors.length
            const open    = isDeviceOpen(dev.id)
            return (
              <div key={dev.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => setExpanded(e => ({ ...e, [dev.id]: !isDeviceOpen(dev.id) }))}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${allOk ? 'bg-green-500' : 'bg-amber-400'}`} />
                  <Link to={`/devices/${dev.id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600" onClick={e => e.stopPropagation()}>
                    {dev.name}
                  </Link>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${allOk ? 'text-green-700 bg-green-50' : 'text-amber-700 bg-amber-50'}`}>
                    {full}/{dev.neighbors.length} full
                  </span>
                  <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
                </button>
                {open && (
                  <table className="w-full text-sm border-t border-slate-100">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="text-left px-5 py-2 text-xs font-medium text-slate-400">Neighbour IP</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Router ID</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Interface</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Area</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">State</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Uptime</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {dev.neighbors.map(n => (
                        <tr key={n.id} className="hover:bg-slate-50">
                          <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{n.neighbor_ip ?? '—'}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{n.neighbor_router_id ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{n.interface_name ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{n.area}</td>
                          <td className="px-4 py-2.5">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: OSPF_STATE_COLOR[n.state] ?? '#94a3b8' }} />
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${OSPF_STATE_CLS[n.state] ?? 'text-slate-600 bg-slate-100'}`}>
                                {n.state.replace('_', ' ')}
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-500 text-right tabular-nums">
                            {n.uptime_seconds != null
                              ? fmtUptime(n.uptime_seconds)
                              : n.last_state_change
                                ? fmtUptime(Math.floor((Date.now() - new Date(n.last_state_change).getTime()) / 1000))
                                : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── IS-IS constants ───────────────────────────────────────────────────────────

const ISIS_STATE_CLS: Record<string, string> = {
  up:            'text-green-700 bg-green-50',
  initializing:  'text-blue-700 bg-blue-50',
  down:          'text-red-700 bg-red-50',
  failed:        'text-red-700 bg-red-100',
  unknown:       'text-slate-600 bg-slate-100',
}

const ISIS_STATE_COLOR: Record<string, string> = {
  up:           '#16a34a',
  initializing: '#2563eb',
  down:         '#dc2626',
  failed:       '#b91c1c',
  unknown:      '#94a3b8',
}

// Full "Xd Xh Xm" style — like BGP uptime but shows all units when large
function fmtUptimeFull(secs: number | null): string {
  if (!secs || secs <= 0) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${secs}s`
}

// Zero-padded hex, e.g. fmtHex(26, 4) → "0x001a"
function fmtHex(n: number | null, width: number): string {
  if (n == null) return '—'
  return '0x' + n.toString(16).padStart(width, '0')
}

// ── IS-IS panel ───────────────────────────────────────────────────────────────

function ISISAdjacenciesPanel() {
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('all')
  const [instanceFilter, setInstanceFilter] = useState('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { data: neighbors = [], isLoading } = useQuery({
    queryKey:        ['isis-neighbors'],
    queryFn:         fetchISISNeighbors,
    refetchInterval: 30_000,
  })
  const { data: summary } = useQuery({
    queryKey:        ['isis-summary'],
    queryFn:         fetchISISSummary,
    refetchInterval: 30_000,
  })
  const { data: areas = [] } = useQuery({
    queryKey:        ['isis-areas'],
    queryFn:         fetchISISAreas,
    refetchInterval: 60_000,
  })
  const { data: circuitLevels = [] } = useQuery({
    queryKey:        ['isis-circuit-levels'],
    queryFn:         fetchISISCircuitLevels,
    refetchInterval: 60_000,
  })

  // Build area lookup: "deviceId|instance" → comma-joined area addrs
  const areaByKey = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const a of areas) {
      const k = `${a.device_id}|${a.instance}`
      if (!m[k]) m[k] = []
      m[k].push(a.area_addr)
    }
    return m
  }, [areas])

  // Build link-detail lookup: "deviceId|instance|interface" → per-level circuit details
  const circuitLevelsByKey = useMemo(() => {
    const m: Record<string, ISISCircuitLevel[]> = {}
    for (const cl of circuitLevels) {
      const k = `${cl.device_id}|${cl.instance}|${cl.interface_name}`
      if (!m[k]) m[k] = []
      m[k].push(cl)
    }
    return m
  }, [circuitLevels])

  // The levels relevant to a given adjacency row — level-1-2 circuits show both
  const circuitLevelsFor = (n: ISISNeighbor): ISISCircuitLevel[] => {
    if (!n.interface_name) return []
    const all = circuitLevelsByKey[`${n.device_id}|${n.instance}|${n.interface_name}`] ?? []
    return all.filter(cl => cl.level === n.circuit_type || n.circuit_type === 'level-1-2')
  }

  const uniqueLevels = useMemo(
    () => ['all', ...new Set(neighbors.map(n => n.circuit_type))].sort(),
    [neighbors]
  )

  const uniqueInstances = useMemo(() => {
    const s = new Set(neighbors.map(n => n.instance))
    return s.size > 1 ? ['all', ...Array.from(s).sort()] : []
  }, [neighbors])

  const filtered = useMemo(() => {
    let n = neighbors
    if (levelFilter !== 'all') n = n.filter(x => x.circuit_type === levelFilter)
    if (instanceFilter !== 'all') n = n.filter(x => x.instance === instanceFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      n = n.filter(x =>
        x.device_name.toLowerCase().includes(q) ||
        x.sys_id.toLowerCase().includes(q) ||
        (x.hostname ?? '').toLowerCase().includes(q) ||
        (x.interface_name ?? '').toLowerCase().includes(q) ||
        (x.ipv4_address ?? '').includes(q) ||
        x.instance.toLowerCase().includes(q)
      )
    }
    return n
  }, [neighbors, levelFilter, instanceFilter, search])

  // Group by device_id + instance so named instances are shown separately
  const byDeviceInstance = useMemo(() => {
    const m = new Map<string, { id: string; name: string; instance: string; neighbors: ISISNeighbor[] }>()
    for (const n of filtered) {
      const key = `${n.device_id}|${n.instance}`
      if (!m.has(key)) m.set(key, { id: n.device_id, name: n.device_name, instance: n.instance, neighbors: [] })
      m.get(key)!.neighbors.push(n)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.instance.localeCompare(b.instance))
  }, [filtered])

  const isGroupOpen = (key: string) => expanded[key] !== false

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Adjacencies</div>
          <div className="text-2xl font-bold text-slate-800">{summary?.total ?? neighbors.length}</div>
          {(summary?.total ?? 0) > 0 && (
            <div className="flex rounded-full overflow-hidden h-1.5 mt-2">
              <div style={{ width: `${((summary?.up ?? 0) / (summary?.total ?? 1)) * 100}%` }} className="bg-green-500" />
              <div style={{ width: `${((summary?.down ?? 0) / (summary?.total ?? 1)) * 100}%` }} className="bg-red-400" />
            </div>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Up</div>
          <div className="text-2xl font-bold text-green-600">{summary?.up ?? '—'}</div>
          {(summary?.total ?? 0) > 0 && (
            <div className="text-xs text-slate-400 mt-1">
              {Math.round(((summary?.up ?? 0) / (summary?.total ?? 1)) * 100)}% up
            </div>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Down / Failed</div>
          <div className={`text-2xl font-bold ${(summary?.down ?? 0) > 0 ? 'text-red-600' : 'text-slate-400'}`}>
            {summary?.down ?? '—'}
          </div>
          {(summary?.down ?? 0) > 0 && <div className="text-xs text-red-400 mt-1">Requires attention</div>}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Devices</div>
          <div className="text-2xl font-bold text-slate-800">{summary?.devices ?? '—'}</div>
          {(summary?.devices ?? 0) > 0 && (
            <div className="text-xs text-slate-400 mt-1">running IS-IS</div>
          )}
        </div>
      </div>

      {/* Search + filters */}
      {neighbors.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search device, sys-id, instance, IP…"
              className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {uniqueLevels.map(l => (
              <button key={l} onClick={() => setLevelFilter(l)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${levelFilter === l ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {l === 'all' ? 'All levels' : l}
              </button>
            ))}
          </div>
          {uniqueInstances.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Instance</span>
              {uniqueInstances.map(inst => (
                <button key={inst} onClick={() => setInstanceFilter(inst)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${instanceFilter === inst ? 'bg-purple-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {inst === 'all' ? 'All' : inst}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Adjacencies grouped by device + instance */}
      {neighbors.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-sm text-slate-400">No IS-IS adjacencies found</p>
          <p className="text-xs text-slate-300 mt-1">IS-IS data is collected via eAPI or SNMP ISIS-MIB (RFC 4444)</p>
        </div>
      ) : byDeviceInstance.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-sm text-slate-400">No adjacencies match</div>
      ) : (
        <div className="space-y-2">
          {byDeviceInstance.map(grp => {
            const key      = `${grp.id}|${grp.instance}`
            const upCount  = grp.neighbors.filter(n => n.adjacency_state === 'up').length
            const severity = upCount === grp.neighbors.length ? 'ok'
                           : upCount === 0                    ? 'down'
                           : 'partial'
            const dotCls   = severity === 'ok' ? 'bg-green-500' : severity === 'partial' ? 'bg-amber-400' : 'bg-red-500'
            const badgeCls = severity === 'ok' ? 'text-green-700 bg-green-50' : severity === 'partial' ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50'
            const open     = isGroupOpen(key)
            const areaList = areaByKey[key] ?? []
            const isNamed  = grp.instance && grp.instance !== 'default'
            return (
              <div key={key} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => setExpanded(e => ({ ...e, [key]: !isGroupOpen(key) }))}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
                  <Link to={`/devices/${grp.id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600" onClick={e => e.stopPropagation()}>
                    {grp.name}
                  </Link>
                  {/* Instance badge — always shown, highlighted for named instances */}
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isNamed ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-500'}`}>
                    {grp.instance}
                  </span>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${badgeCls}`}>
                    {upCount}/{grp.neighbors.length} up
                  </span>
                  {areaList.length > 0 && (
                    <span className="text-xs text-slate-400 font-mono">
                      area {areaList.join(', ')}
                    </span>
                  )}
                  <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
                </button>
                {open && (
                  <table className="w-full text-sm border-t border-slate-100">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="text-left px-5 py-2 text-xs font-medium text-slate-400">Neighbour Sys-ID</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Hostname</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Interface</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Level</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">IP</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">State</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Uptime</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {grp.neighbors.map(n => {
                        const isUp      = n.adjacency_state === 'up'
                        const stateAt   = n.last_state_change
                          ? `${isUp ? 'Up' : 'Entered ' + n.adjacency_state} at ${new Date(n.last_state_change).toLocaleString()}`
                          : undefined
                        const uptimeSecs = n.uptime_seconds != null
                          ? n.uptime_seconds
                          : n.last_state_change
                            ? Math.floor((Date.now() - new Date(n.last_state_change).getTime()) / 1000)
                            : null
                        return (
                          <tr key={n.id} className="hover:bg-slate-50">
                            <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{n.sys_id || '—'}</td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">{n.hostname ?? '—'}</td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">
                              {n.interface_name ?? '—'}
                              {circuitLevelsFor(n).map(cl => (
                                <div key={cl.level} className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400 mt-0.5">
                                  {n.circuit_type === 'level-1-2' && (
                                    <span className="font-semibold text-slate-400">{cl.level === 'level-1' ? 'L1' : 'L2'}</span>
                                  )}
                                  {cl.metric != null && <span>metric {cl.metric}</span>}
                                  {cl.hello_interval != null && cl.hold_timer != null && (
                                    <span>hello {cl.hello_interval}s/hold {cl.hold_timer}s</span>
                                  )}
                                  {cl.dis_id && (
                                    <span className="px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 font-semibold leading-none" title={`LAN DIS: ${cl.dis_id}`}>
                                      DIS
                                    </span>
                                  )}
                                </div>
                              ))}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">{n.circuit_type}</td>
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                              {n.ipv4_address ?? n.ipv6_address ?? '—'}
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className="flex items-center gap-1.5"
                                title={stateAt}
                              >
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ISIS_STATE_COLOR[n.adjacency_state] ?? '#94a3b8' }} />
                                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${ISIS_STATE_CLS[n.adjacency_state] ?? 'text-slate-600 bg-slate-100'}`}>
                                  {n.adjacency_state}
                                </span>
                                {stateAt && (
                                  <span className="text-[10px] text-slate-400 hidden group-hover:inline">
                                    {isUp ? '' : fmtAgo(n.last_state_change)}
                                  </span>
                                )}
                              </span>
                              {!isUp && n.last_state_change && (
                                <div className="text-[10px] text-amber-500 mt-0.5" title={stateAt}>
                                  {fmtAgo(n.last_state_change)}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                              {isUp ? (
                                <span className="text-xs text-slate-500">{fmtUptimeFull(uptimeSecs)}</span>
                              ) : uptimeSecs != null ? (
                                <span
                                  className="text-xs text-amber-600"
                                  title={n.last_state_change ? `Since ${new Date(n.last_state_change).toLocaleString()}` : undefined}
                                >
                                  {fmtUptimeFull(uptimeSecs)} ago
                                </span>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Routes panel (shared by BGP / OSPF / IS-IS) ──────────────────────────────

const ROUTES_PROTOCOL_LABEL: Record<'bgp' | 'ospf' | 'isis', string> = {
  bgp:  'BGP',
  ospf: 'OSPF',
  isis: 'IS-IS',
}

function RoutesPanel({ protocol }: { protocol: 'bgp' | 'ospf' | 'isis' }) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const isISIS = protocol === 'isis'

  const { data: routes = [], isLoading } = useQuery({
    queryKey:        ['routes', protocol],
    queryFn:         () => fetchRoutes(protocol),
    refetchInterval: 30_000,
  })

  // IS-IS-only extras: area badges (per device) and per-circuit levels
  const { data: areas = [] } = useQuery({
    queryKey:        ['isis-areas'],
    queryFn:         fetchISISAreas,
    refetchInterval: 60_000,
    enabled:         isISIS,
  })
  const { data: circuitLevels = [] } = useQuery({
    queryKey:        ['isis-circuit-levels'],
    queryFn:         fetchISISCircuitLevels,
    refetchInterval: 60_000,
    enabled:         isISIS,
  })

  // Device → union of area addresses across all instances (route_entries has no instance column)
  const areasByDevice = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    for (const a of areas) {
      if (!m[a.device_id]) m[a.device_id] = new Set()
      m[a.device_id].add(a.area_addr)
    }
    return m
  }, [areas])

  // "deviceId|interface" → set of levels seen on that circuit
  const levelsByDeviceIface = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    for (const cl of circuitLevels) {
      const k = `${cl.device_id}|${cl.interface_name}`
      if (!m[k]) m[k] = new Set()
      m[k].add(cl.level)
    }
    return m
  }, [circuitLevels])

  const levelLabel = (r: RouteEntryDTO): string => {
    if (!r.interface_name) return '—'
    const levels = levelsByDeviceIface[`${r.device_id}|${r.interface_name}`]
    if (!levels || levels.size === 0) return '—'
    if (levels.has('level-1') && levels.has('level-2')) return 'L1+L2'
    return levels.has('level-1') ? 'L1' : 'L2'
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return routes
    const q = search.toLowerCase()
    return routes.filter(r =>
      r.device_name.toLowerCase().includes(q) ||
      r.destination.toLowerCase().includes(q) ||
      (r.next_hop ?? '').toLowerCase().includes(q) ||
      (r.interface_name ?? '').toLowerCase().includes(q)
    )
  }, [routes, search])

  const byDevice = useMemo(() => {
    const m = new Map<string, { id: string; name: string; routes: RouteEntryDTO[] }>()
    for (const r of filtered) {
      if (!m.has(r.device_id)) m.set(r.device_id, { id: r.device_id, name: r.device_name, routes: [] })
      m.get(r.device_id)!.routes.push(r)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [filtered])

  const isGroupOpen = (key: string) => expanded[key] !== false

  const distinctPrefixes = useMemo(() => new Set(routes.map(r => r.destination)).size, [routes])
  const ecmpCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of routes) counts.set(r.destination, (counts.get(r.destination) ?? 0) + 1)
    return [...counts.values()].filter(c => c > 1).length
  }, [routes])

  const label = ROUTES_PROTOCOL_LABEL[protocol]

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Routes</div>
          <div className="text-2xl font-bold text-slate-800">{routes.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Devices</div>
          <div className="text-2xl font-bold text-slate-800">{byDevice.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Distinct Prefixes</div>
          <div className="text-2xl font-bold text-slate-800">{distinctPrefixes}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">ECMP Routes</div>
          <div className="text-2xl font-bold text-slate-800">{ecmpCount}</div>
          {ecmpCount > 0 && <div className="text-xs text-slate-400 mt-1">multiple next-hops</div>}
        </div>
      </div>

      {/* Search */}
      {routes.length > 0 && (
        <div className="relative w-64">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search destination, next hop, interface…"
            className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
        </div>
      )}

      {/* Routes grouped by device */}
      {routes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-sm text-slate-400">No {label} routes found</p>
          <p className="text-xs text-slate-300 mt-1">{label} routes are learned from the device's routing table (protocol "{protocol}")</p>
        </div>
      ) : byDevice.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-sm text-slate-400">No routes match</div>
      ) : (
        <div className="space-y-2">
          {byDevice.map(grp => {
            const open     = isGroupOpen(grp.id)
            const areaList = isISIS ? [...(areasByDevice[grp.id] ?? [])] : []
            return (
              <div key={grp.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => setExpanded(e => ({ ...e, [grp.id]: !isGroupOpen(grp.id) }))}
                >
                  <Link to={`/devices/${grp.id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600" onClick={e => e.stopPropagation()}>
                    {grp.name}
                  </Link>
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded text-slate-600 bg-slate-100">
                    {grp.routes.length} route{grp.routes.length === 1 ? '' : 's'}
                  </span>
                  {areaList.length > 0 && (
                    <span className="text-xs text-slate-400 font-mono">
                      area {areaList.join(', ')}
                    </span>
                  )}
                  <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
                </button>
                {open && (
                  <table className="w-full text-sm border-t border-slate-100">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="text-left px-5 py-2 text-xs font-medium text-slate-400">Destination</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Next Hop</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Interface</th>
                        {isISIS && <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Level</th>}
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Metric</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {grp.routes.map(r => (
                        <tr key={`${r.destination}|${r.next_hop ?? ''}`} className="hover:bg-slate-50">
                          <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{r.destination}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{r.next_hop ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{r.interface_name ?? '—'}</td>
                          {isISIS && <td className="px-4 py-2.5 text-xs text-slate-500">{levelLabel(r)}</td>}
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs text-slate-500">{r.metric ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── IS-IS LSP database panel ────────────────────────────────────────────────

function ISISLspPanel() {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { data: lsps = [], isLoading } = useQuery({
    queryKey:        ['isis-lsps'],
    queryFn:         fetchISISLsps,
    refetchInterval: 30_000,
  })
  const { data: areas = [] } = useQuery({
    queryKey:        ['isis-areas'],
    queryFn:         fetchISISAreas,
    refetchInterval: 60_000,
  })

  // Build area lookup: "deviceId|instance" → comma-joined area addrs
  const areaByKey = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const a of areas) {
      const k = `${a.device_id}|${a.instance}`
      if (!m[k]) m[k] = []
      m[k].push(a.area_addr)
    }
    return m
  }, [areas])

  const filtered = useMemo(() => {
    if (!search.trim()) return lsps
    const q = search.toLowerCase()
    return lsps.filter(l =>
      l.device_name.toLowerCase().includes(q) ||
      l.lsp_id.toLowerCase().includes(q) ||
      l.instance.toLowerCase().includes(q)
    )
  }, [lsps, search])

  const byDeviceInstance = useMemo(() => {
    const m = new Map<string, { id: string; name: string; instance: string; lsps: ISISLsp[] }>()
    for (const l of filtered) {
      const key = `${l.device_id}|${l.instance}`
      if (!m.has(key)) m.set(key, { id: l.device_id, name: l.device_name, instance: l.instance, lsps: [] })
      m.get(key)!.lsps.push(l)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.instance.localeCompare(b.instance))
  }, [filtered])

  const isGroupOpen = (key: string) => expanded[key] !== false
  const overloadCount = useMemo(() => lsps.filter(l => l.overload_bit).length, [lsps])
  const attachedCount = useMemo(() => lsps.filter(l => l.attached_bit).length, [lsps])

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">LSPs</div>
          <div className="text-2xl font-bold text-slate-800">{lsps.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Devices</div>
          <div className="text-2xl font-bold text-slate-800">{byDeviceInstance.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Overload Bit Set</div>
          <div className={`text-2xl font-bold ${overloadCount > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{overloadCount}</div>
          {overloadCount > 0 && <div className="text-xs text-amber-500 mt-1">May affect path selection</div>}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Attached Bit Set</div>
          <div className={`text-2xl font-bold ${attachedCount > 0 ? 'text-blue-600' : 'text-slate-400'}`}>{attachedCount}</div>
          {attachedCount > 0 && <div className="text-xs text-blue-400 mt-1">L1 default route to L2</div>}
        </div>
      </div>

      {/* Search */}
      {lsps.length > 0 && (
        <div className="relative w-64">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search device, LSP ID, instance…"
            className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
        </div>
      )}

      {/* LSPs grouped by device + instance */}
      {lsps.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <p className="text-sm text-slate-400">No IS-IS LSPs found</p>
          <p className="text-xs text-slate-300 mt-1">The LSP database is collected via SNMP ISIS-MIB (isisLSPSummaryTable)</p>
        </div>
      ) : byDeviceInstance.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-sm text-slate-400">No LSPs match</div>
      ) : (
        <div className="space-y-2">
          {byDeviceInstance.map(grp => {
            const key      = `${grp.id}|${grp.instance}`
            const open     = isGroupOpen(key)
            const isNamed  = grp.instance && grp.instance !== 'default'
            const areaList = areaByKey[key] ?? []
            return (
              <div key={key} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => setExpanded(e => ({ ...e, [key]: !isGroupOpen(key) }))}
                >
                  <Link to={`/devices/${grp.id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600" onClick={e => e.stopPropagation()}>
                    {grp.name}
                  </Link>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isNamed ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-500'}`}>
                    {grp.instance}
                  </span>
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded text-slate-600 bg-slate-100">
                    {grp.lsps.length} LSP{grp.lsps.length === 1 ? '' : 's'}
                  </span>
                  {areaList.length > 0 && (
                    <span className="text-xs text-slate-400 font-mono">
                      area {areaList.join(', ')}
                    </span>
                  )}
                  <span className="ml-auto text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
                </button>
                {open && (
                  <table className="w-full text-sm border-t border-slate-100">
                    <thead>
                      <tr className="bg-slate-50">
                        <th className="text-left px-5 py-2 text-xs font-medium text-slate-400">LSP ID</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Level</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Seq #</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Checksum</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">PDU Len</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-slate-400">Remaining Life</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-slate-400">Flags</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {grp.lsps.map(l => {
                        const lowLife = l.remaining_lifetime != null && l.remaining_lifetime < 300
                        return (
                          <tr key={`${l.level}|${l.lsp_id}`} className="hover:bg-slate-50">
                            <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{l.lsp_id}</td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">{l.level}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{fmtHex(l.sequence_number, 8)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{fmtHex(l.checksum, 4)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-xs text-slate-500">{l.pdu_length ?? '—'}</td>
                            <td className={`px-4 py-2.5 text-right tabular-nums text-xs ${lowLife ? 'text-amber-600 font-semibold' : 'text-slate-500'}`}>
                              {l.remaining_lifetime != null ? `${l.remaining_lifetime}s` : '—'}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex gap-1">
                                {l.overload_bit && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">OL</span>}
                                {l.attached_bit && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">ATT</span>}
                                {!l.overload_bit && !l.attached_bit && <span className="text-slate-300 text-xs">—</span>}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── IS-IS topology panel ────────────────────────────────────────────────────

const ISIS_LEVEL_EDGE_COLOR: Record<string, string> = {
  'level-1':   '#3b82f6',
  'level-2':   '#8b5cf6',
  'level-1-2': '#94a3b8',
}

// Edges that are "up" carry the level color; anything else carries the same
// state color used in the Adjacencies tab (initializing → blue, down/failed → red).
function isisEdgeColor(level: string, state: string): string {
  if (state === 'up') return ISIS_LEVEL_EDGE_COLOR[level] ?? '#94a3b8'
  return ISIS_STATE_COLOR[state] ?? '#94a3b8'
}

const TOPO_COL_GAP = 220
const TOPO_ROW_GAP = 90

function ISISTopoNode({ data }: NodeProps) {
  const d = data as unknown as { label: string; area: string | null; managed: boolean }
  return (
    <div className={`px-3 py-2 rounded-xl border text-xs shadow-sm min-w-[150px] ${d.managed ? 'bg-white border-slate-300' : 'bg-slate-50 border-dashed border-slate-300'}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5 font-semibold text-slate-700">
        <span className={`w-2 h-2 rounded-full shrink-0 ${d.managed ? 'bg-slate-700' : 'bg-slate-300'}`} />
        <span className="truncate">{d.label}</span>
      </div>
      {d.area && <div className="text-[10px] text-slate-400 mt-0.5">area {d.area}</div>}
      {!d.managed && <div className="text-[10px] text-slate-400 mt-0.5">external</div>}
    </div>
  )
}

const ISIS_TOPO_NODE_TYPES = { isisTopo: ISISTopoNode }

function ISISTopologyPanel() {
  const { data, isLoading } = useQuery({
    queryKey:        ['isis-topology'],
    queryFn:         fetchISISTopology,
    refetchInterval: 60_000,
  })

  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []

  // Group nodes into columns by area — managed devices without an area, then
  // external (unmanaged) neighbors, are placed in their own trailing columns.
  const groups = useMemo(() => {
    const byArea = new Map<string, ISISTopologyNode[]>()
    for (const n of nodes) {
      const key = n.managed ? (n.area ?? 'Unassigned') : 'External'
      if (!byArea.has(key)) byArea.set(key, [])
      byArea.get(key)!.push(n)
    }
    const keys = [...byArea.keys()].sort((a, b) => {
      if (a === 'External') return 1
      if (b === 'External') return -1
      if (a === 'Unassigned') return 1
      if (b === 'Unassigned') return -1
      return a.localeCompare(b)
    })
    return keys.map(k => ({ area: k, nodes: byArea.get(k)!.sort((a, b) => a.label.localeCompare(b.label)) }))
  }, [nodes])

  const flowNodes: Node[] = useMemo(() => {
    const out: Node[] = []
    groups.forEach((g, colIdx) => {
      g.nodes.forEach((n, rowIdx) => {
        out.push({
          id:       n.id,
          type:     'isisTopo',
          position: { x: colIdx * TOPO_COL_GAP, y: rowIdx * TOPO_ROW_GAP },
          data:     { label: n.label, area: n.area, managed: n.managed },
        })
      })
    })
    return out
  }, [groups])

  const flowEdges: Edge[] = useMemo(() => edges.map(e => {
    const isDown = e.state !== 'up'
    return {
      id:     `${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      label:  e.level === 'level-1-2' ? undefined : (e.level === 'level-1' ? 'L1' : 'L2'),
      labelStyle: { fontSize: 10, fill: '#64748b' },
      style: {
        stroke:          isisEdgeColor(e.level, e.state),
        strokeWidth:     2,
        strokeDasharray: isDown ? '4 4' : undefined,
      },
    }
  }), [edges])

  if (isLoading) return <div className="text-sm text-slate-400 p-4">Loading…</div>

  if (nodes.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
        <p className="text-sm text-slate-400">No IS-IS topology data</p>
        <p className="text-xs text-slate-300 mt-1">Topology is derived from IS-IS adjacencies and area addresses</p>
      </div>
    )
  }

  const linksDown = edges.filter(e => e.state !== 'up' && e.state !== 'unknown').length

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Nodes</div>
          <div className="text-2xl font-bold text-slate-800">{nodes.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Managed Devices</div>
          <div className="text-2xl font-bold text-slate-800">{nodes.filter(n => n.managed).length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Links</div>
          <div className="text-2xl font-bold text-slate-800">{edges.length}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="text-xs text-slate-500 font-medium mb-1">Links Down</div>
          <div className={`text-2xl font-bold ${linksDown > 0 ? 'text-red-600' : 'text-slate-400'}`}>{linksDown}</div>
          {linksDown > 0 && <div className="text-xs text-red-400 mt-1">Requires attention</div>}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-slate-500 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-700" /> Managed device</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-300" /> External neighbor</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 bg-blue-500" /> Level-1</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 bg-purple-500" /> Level-2</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 bg-slate-400" /> Level-1-2</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 border-t-2 border-dashed border-blue-600" /> Initializing</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 border-t-2 border-dashed border-red-600" /> Down / Failed</span>
      </div>
      <div className="bg-white rounded-2xl border border-slate-200" style={{ height: 520 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={ISIS_TOPO_NODE_TYPES}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#dde3eb" gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}

// ── IS-IS panel (sub-tabs) ────────────────────────────────────────────────────

function ISISPanel() {
  const [subTab, setSubTab] = useState<'adjacencies' | 'routes' | 'lsps' | 'topology'>('adjacencies')

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-slate-200 mb-1">
        {([['adjacencies', 'Adjacencies'], ['routes', 'Routes'], ['lsps', 'LSP Database'], ['topology', 'Topology']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSubTab(k)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${subTab === k ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {subTab === 'adjacencies' && <ISISAdjacenciesPanel />}
      {subTab === 'routes'      && <RoutesPanel protocol="isis" />}
      {subTab === 'lsps'        && <ISISLspPanel />}
      {subTab === 'topology'    && <ISISTopologyPanel />}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Protocol = 'bgp' | 'ospf' | 'isis'

const PROTOCOLS: { key: Protocol; label: string; desc: string; icon: ReactNode }[] = [
  {
    key: 'bgp',
    label: 'BGP',
    desc: 'Sessions · Prefixes · Flap log · Routes',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 shrink-0">
        <circle cx="3" cy="8" r="1.5" />
        <circle cx="13" cy="4" r="1.5" />
        <circle cx="13" cy="12" r="1.5" />
        <line x1="4.5" y1="7.3" x2="11.5" y2="4.7" />
        <line x1="4.5" y1="8.7" x2="11.5" y2="11.3" />
      </svg>
    ),
  },
  {
    key: 'ospf',
    label: 'OSPF',
    desc: 'Adjacencies · Areas · Routes',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 shrink-0">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 2.5 C10.5 5 10.5 11 8 13.5" />
        <path d="M8 2.5 C5.5 5 5.5 11 8 13.5" />
        <line x1="2.5" y1="8" x2="13.5" y2="8" />
      </svg>
    ),
  },
  {
    key: 'isis',
    label: 'IS-IS',
    desc: 'Level 1/2 · Adjacencies · Routes · LSPs · Topology',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 shrink-0">
        <rect x="2" y="2.5" width="12" height="3" rx="1" />
        <rect x="2" y="6.5" width="12" height="3" rx="1" />
        <rect x="2" y="10.5" width="12" height="3" rx="1" />
      </svg>
    ),
  },
]

export default function RoutingPage() {
  const [protocol, setProtocol] = useState<Protocol>('bgp')

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-52 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col overflow-y-auto">
        {/* Sidebar header */}
        <div className="px-4 pt-5 pb-4 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">Routing</div>
          <div className="text-[11px] text-slate-400 mt-0.5">BGP · OSPF · IS-IS</div>
        </div>

        {/* Protocol nav */}
        <div className="flex flex-col pt-3 pb-2">
          <div className="px-4 pb-2 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
            Protocols
          </div>
          {PROTOCOLS.map(p => {
            const active = protocol === p.key
            return (
              <button
                key={p.key}
                onClick={() => setProtocol(p.key)}
                className={`flex items-start gap-2.5 w-full px-4 py-2.5 text-left transition-all ${
                  active
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}
              >
                <span className={`mt-0.5 ${active ? 'text-blue-500' : ''}`}>{p.icon}</span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm leading-tight">{p.label}</span>
                  <span className="text-[10px] text-slate-400 mt-0.5 leading-tight">{p.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {protocol === 'bgp'  && <BGPPanel />}
        {protocol === 'ospf' && <OSPFPanel />}
        {protocol === 'isis' && <ISISPanel />}
      </div>
    </div>
  )
}
