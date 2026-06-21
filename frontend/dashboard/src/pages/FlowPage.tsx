import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  fetchFlowSummary, fetchTopTalkers, fetchTopPorts, fetchProtocolBreakdown,
  fetchTopDevices, fetchFlowTimeseries, searchFlows, fetchIpDetail,
  fetchGeoSummary, fetchFlowThreats, fetchIpIntel,
  fetchAsnSummary, fetchApplicationSummary, fetchDirectionSummary,
  fetchElephantFlows, fetchSubnetSummary, fetchTcpFlags,
  type GeoSummaryRow, type ThreatRow, type IpIntel,
  type AsnRow, type AppCategory, type AppPort,
  type DirectionSummary, type ElephantFlow, type SubnetRow, type TcpFlagsSummary,
} from '../api/flow'
import { fetchDevices } from '../api/devices'
import TimeSeriesChart from '../components/TimeSeriesChart'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'
import SavedViewsMenu from '../components/SavedViewsMenu'
import { SkeletonTable, SkeletonInline, SkeletonChart } from '../components/Skeleton'

// ── Intel helpers ─────────────────────────────────────────────────────────────

function countryFlag(iso: string | null | undefined): string {
  if (!iso || iso.length !== 2 || iso === 'XX') return '🌐'
  const base = 0x1F1E6 - 0x41
  return String.fromCodePoint(iso.toUpperCase().charCodeAt(0) + base,
                               iso.toUpperCase().charCodeAt(1) + base)
}

function AbuseScore({ score }: { score: number | null | undefined }) {
  if (score == null) return null
  const color = score >= 75 ? 'bg-red-100 text-red-700'
              : score >= 25 ? 'bg-amber-100 text-amber-700'
              : 'bg-slate-100 text-slate-500'
  return (
    <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${color}`} title={`AbuseIPDB: ${score}`}>
      {score}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}
function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}
function fmtTs(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const PROTO_COLOR: Record<string, string> = {
  TCP: '#3b82f6', UDP: '#f59e0b', ICMP: '#10b981', OSPF: '#8b5cf6',
  GRE: '#ec4899', ESP: '#ef4444', SCTP: '#06b6d4',
}
const protoColor = (name: string) => PROTO_COLOR[name] ?? '#94a3b8'

const PORT_NAMES: Record<number, string> = {
  20: 'FTP-data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 143: 'IMAP', 179: 'BGP', 443: 'HTTPS', 465: 'SMTPS',
  514: 'Syslog', 587: 'SMTP', 993: 'IMAPS', 995: 'POP3S', 1194: 'OpenVPN',
  1433: 'MSSQL', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC',
  6379: 'Redis', 8080: 'HTTP-alt', 8443: 'HTTPS-alt',
}

const TIME_WINDOWS = [
  { label: '15m', minutes: 15 },
  { label: '1h',  minutes: 60 },
  { label: '6h',  minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '7d',  minutes: 10080 },
]

// ── Filter state ──────────────────────────────────────────────────────────────

interface Filters {
  srcIp?:    string
  dstIp?:    string
  protocol?: number
  dstPort?:  number
}

function FilterChips({ filters, onRemove }: { filters: Filters; onRemove: (k: keyof Filters) => void }) {
  const chips: { key: keyof Filters; label: string }[] = []
  if (filters.srcIp)    chips.push({ key: 'srcIp',    label: `src: ${filters.srcIp}` })
  if (filters.dstIp)    chips.push({ key: 'dstIp',    label: `dst: ${filters.dstIp}` })
  if (filters.protocol != null) chips.push({ key: 'protocol', label: `proto: ${filters.protocol}` })
  if (filters.dstPort != null)  chips.push({ key: 'dstPort',  label: `port: ${filters.dstPort}` })
  if (chips.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {chips.map(c => (
        <span key={c.key} className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700 font-mono">
          {c.label}
          <button onClick={() => onRemove(c.key)} aria-label={`Remove ${c.label} filter`} className="text-blue-400 hover:text-blue-700 ml-0.5 leading-none">×</button>
        </span>
      ))}
    </div>
  )
}

// ── Clickable value helpers ───────────────────────────────────────────────────

function ClickableIP({ ip, role, onFilter, onDetail }: {
  ip: string; role: 'src' | 'dst'
  onFilter: (role: 'src' | 'dst', ip: string) => void
  onDetail: (ip: string) => void
}) {
  return (
    <span className="group/ip inline-flex items-center gap-0.5">
      <button
        onClick={() => onDetail(ip)}
        className="font-mono text-xs font-medium text-slate-700 hover:text-blue-600 hover:underline transition-colors"
        title="View IP details"
      >
        {ip}
      </button>
      <button
        onClick={() => onFilter(role, ip)}
        className="opacity-0 group-hover/ip:opacity-100 transition-opacity text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 hover:bg-blue-100 hover:text-blue-600 ml-0.5"
        title={`Filter by ${role} IP`}
      >
        {role}
      </button>
    </span>
  )
}

function ClickableProto({ name, proto, onFilter }: { name: string; proto: number; onFilter: (p: number) => void }) {
  return (
    <button
      onClick={() => onFilter(proto)}
      className="text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors hover:opacity-80"
      style={{ backgroundColor: `${protoColor(name)}18`, color: protoColor(name) }}
      title="Filter by protocol"
    >
      {name}
    </button>
  )
}

function ClickablePort({ port, onFilter }: { port: number; proto?: string; onFilter: (p: number) => void }) {
  return (
    <button
      onClick={() => onFilter(port)}
      className="font-mono text-xs font-bold text-slate-700 hover:text-blue-600 hover:underline transition-colors"
      title="Filter by port"
    >
      {port}
    </button>
  )
}

// ── IP detail panel ───────────────────────────────────────────────────────────

function IpDetailPanel({ ip, minutes, deviceId, onClose, onFilter }: {
  ip: string; minutes: number; deviceId: string
  onClose: () => void
  onFilter: (role: 'src' | 'dst', ip: string) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['flow-ip-detail', ip, minutes, deviceId],
    queryFn:  () => fetchIpDetail(ip, minutes, deviceId || undefined),
  })

  const { data: intelMap = {} } = useQuery({
    queryKey:  ['flow-intel-single', ip],
    queryFn:   () => fetchIpIntel([ip], true),
    staleTime: 300_000,
  })
  const intel: IpIntel | undefined = intelMap[ip]

  const maxPeerBytes = Math.max(...(data?.top_peers ?? []).map(p => p.bytes_sent + p.bytes_received), 1)
  const maxPortBytes = Math.max(...(data?.top_ports ?? []).map(p => p.bytes_total), 1)

  const tsSeries = useMemo(() => [
    { name: 'Out', color: '#f59e0b', data: (data?.timeseries ?? []).map(p => [p.ts_ms, p.bytes_out] as [number, number]) },
    { name: 'In',  color: '#6366f1', data: (data?.timeseries ?? []).map(p => [p.ts_ms, p.bytes_in]  as [number, number]) },
  ], [data])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="w-full max-w-md bg-white shadow-2xl flex flex-col overflow-hidden border-l border-slate-200">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">IP Detail</p>
            <div className="flex items-center gap-2">
              <span className="text-lg leading-none">{countryFlag(intel?.country_iso)}</span>
              <h2 className="text-base font-bold text-slate-800 font-mono">{ip}</h2>
              {intel?.abuse_score != null && <AbuseScore score={intel.abuse_score} />}
            </div>
            {(intel?.country_name || intel?.asn_org) && (
              <p className="text-xs text-slate-400 mt-0.5">
                {intel.country_name}{intel.city ? `, ${intel.city}` : ''}
                {intel.asn_org ? ` · ${intel.asn_org}` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onFilter('src', ip)} className="px-2.5 py-1 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors">as src</button>
            <button onClick={() => onFilter('dst', ip)} className="px-2.5 py-1 text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-100 transition-colors">as dst</button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6"><SkeletonTable rows={4} cols={3} /></div>
          ) : !data ? null : (
            <>
              {/* In/Out totals */}
              <div className="px-5 py-4 grid grid-cols-2 gap-3 border-b border-slate-100">
                <div className="bg-indigo-50 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-indigo-400 font-medium uppercase tracking-wide">Sent (as src)</p>
                  <p className="text-xl font-bold text-indigo-700 tabular-nums mt-1">{fmtBytes(data.bytes_as_src)}</p>
                  <p className="text-xs text-indigo-400 mt-0.5">{fmtNum(data.pkts_as_src)} pkts</p>
                </div>
                <div className="bg-amber-50 rounded-xl px-4 py-3">
                  <p className="text-[10px] text-amber-500 font-medium uppercase tracking-wide">Received (as dst)</p>
                  <p className="text-xl font-bold text-amber-700 tabular-nums mt-1">{fmtBytes(data.bytes_as_dst)}</p>
                  <p className="text-xs text-amber-400 mt-0.5">{fmtNum(data.pkts_as_dst)} pkts</p>
                </div>
              </div>

              {/* Threat intel */}
              {intel && (intel.abuse_score != null || intel.country_name) && (
                <div className={`px-5 py-3 border-b border-slate-100 ${intel.abuse_score != null && intel.abuse_score >= 25 ? 'bg-red-50' : ''}`}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Intelligence</p>
                    <a
                      href={`https://www.abuseipdb.com/check/${ip}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline flex items-center gap-0.5"
                    >
                      AbuseIPDB ↗
                    </a>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {intel.country_name && (
                      <div>
                        <span className="text-slate-400">Country</span>
                        <p className="font-medium text-slate-700">{countryFlag(intel.country_iso)} {intel.country_name}</p>
                      </div>
                    )}
                    {intel.asn && (
                      <div>
                        <span className="text-slate-400">ASN</span>
                        <p className="font-medium text-slate-700">AS{intel.asn}</p>
                      </div>
                    )}
                    {intel.abuse_isp && (
                      <div className="col-span-2">
                        <span className="text-slate-400">ISP</span>
                        <p className="font-medium text-slate-700 truncate">{intel.abuse_isp}</p>
                      </div>
                    )}
                    {intel.abuse_score != null && (
                      <div>
                        <span className="text-slate-400">Abuse score</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <div className="flex-1 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${intel.abuse_score}%`, backgroundColor: intel.abuse_score >= 75 ? '#ef4444' : intel.abuse_score >= 25 ? '#f59e0b' : '#22c55e' }} />
                          </div>
                          <span className="font-bold text-slate-700">{intel.abuse_score}</span>
                        </div>
                        {intel.abuse_reports != null && <p className="text-slate-400 mt-0.5">{intel.abuse_reports} reports</p>}
                      </div>
                    )}
                    {intel.abuse_domain && (
                      <div>
                        <span className="text-slate-400">Domain</span>
                        <p className="font-medium text-slate-700 truncate">{intel.abuse_domain}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Time series */}
              {tsSeries[0].data.length >= 2 && (
                <div className="px-5 py-4 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Traffic over time</p>
                  <TimeSeriesChart series={tsSeries} height={100} yFmt={v => fmtBytes(v) + '/s'} />
                </div>
              )}

              {/* Connection profile */}
              {data.profile && (
                <div className="px-5 py-3 border-b border-slate-100">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Connection profile</p>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: 'Avg flow size', value: fmtBytes(data.profile.avg_bytes_per_flow) },
                      { label: 'Avg duration',  value: fmtDuration(data.profile.avg_duration_s) },
                      { label: 'Bytes/packet',  value: `${Math.round(data.profile.avg_bytes_per_pkt)}B` },
                      { label: 'TCP flows',     value: fmtNum(data.profile.tcp_flows) },
                      { label: 'UDP flows',     value: fmtNum(data.profile.udp_flows) },
                      { label: 'Unique ports',  value: String(Math.max(data.profile.unique_dst_ports, data.profile.unique_src_ports)) },
                    ].map(stat => (
                      <div key={stat.label} className="bg-slate-50 rounded-lg px-2 py-2">
                        <p className="text-[9px] text-slate-400">{stat.label}</p>
                        <p className="text-xs font-bold text-slate-700 mt-0.5">{stat.value}</p>
                      </div>
                    ))}
                  </div>
                  {data.profile.unique_dst_ports > 50 && (
                    <p className="text-[10px] text-amber-600 mt-2 font-medium">⚠ High port diversity — possible scanner</p>
                  )}
                  {data.profile.avg_bytes_per_flow > 10_000_000 && (
                    <p className="text-[10px] text-purple-600 mt-1 font-medium">🐘 Large average flow — elephant traffic</p>
                  )}
                  {data.profile.avg_bytes_per_pkt < 100 && data.profile.tcp_flows > 100 && (
                    <p className="text-[10px] text-blue-600 mt-1 font-medium">📡 Small packets, many flows — possible beacon</p>
                  )}
                </div>
              )}

              {/* Top peers */}
              {data.top_peers.length > 0 && (
                <div className="px-5 py-4 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Top peers</p>
                  <div className="space-y-2">
                    {data.top_peers.map(p => (
                      <div key={p.peer_ip} className="flex items-center gap-2">
                        <button
                          onClick={() => onFilter('dst', p.peer_ip)}
                          className="font-mono text-xs text-slate-700 hover:text-blue-600 hover:underline w-32 shrink-0 text-left truncate"
                        >
                          {p.peer_ip}
                        </button>
                        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full bg-indigo-400" style={{ width: `${((p.bytes_sent + p.bytes_received) / maxPeerBytes) * 100}%` }} />
                        </div>
                        <span className="text-xs text-slate-500 tabular-nums w-14 text-right shrink-0">{fmtBytes(p.bytes_sent + p.bytes_received)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Top ports */}
              {data.top_ports.length > 0 && (
                <div className="px-5 py-4">
                  <p className="text-xs font-semibold text-slate-500 mb-3">Top destination ports</p>
                  <div className="space-y-2">
                    {data.top_ports.map(p => (
                      <div key={`${p.dst_port}-${p.protocol}`} className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-700 w-10 shrink-0">{p.dst_port}</span>
                        <span className="text-[10px] text-slate-400 w-16 shrink-0">{PORT_NAMES[p.dst_port] ?? p.protocol_name}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${(p.bytes_total / maxPortBytes) * 100}%`, backgroundColor: protoColor(p.protocol_name) }} />
                        </div>
                        <span className="text-xs text-slate-500 tabular-nums w-14 text-right shrink-0">{fmtBytes(p.bytes_total)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ minutes, deviceId, filters }: { minutes: number; deviceId: string; filters: Filters }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['flow-summary', minutes, deviceId],
    queryFn:         () => fetchFlowSummary(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const cards = [
    { name: 'Total bytes',    value: data ? fmtBytes(data.bytes_total)    : '—', accent: '#6366f1' },
    { name: 'Packets',        value: data ? fmtNum(data.packets_total)    : '—', accent: '#0891b2' },
    { name: 'Flows',          value: data ? fmtNum(data.flows_total)      : '—', accent: '#10b981' },
    { name: 'Unique src IPs', value: data ? fmtNum(data.unique_src_ips)   : '—', accent: '#f59e0b' },
    { name: 'Unique dst IPs', value: data ? fmtNum(data.unique_dst_ips)   : '—', accent: '#ef4444' },
    { name: 'Exporters',      value: data ? String(data.active_exporters) : '—', accent: '#8b5cf6' },
  ]
  return (
    <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(c => (
        <div key={c.name} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
          <p className="text-xs text-slate-400 mb-1">{c.name}</p>
          <p className="text-xl font-bold text-slate-800 tabular-nums">
            {isLoading ? <SkeletonInline /> : c.value}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── Time series ───────────────────────────────────────────────────────────────

function FlowTimeSeries({ minutes, deviceId, filters }: { minutes: number; deviceId: string; filters: Filters }) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-timeseries', minutes, deviceId, filters.srcIp, filters.dstIp],
    queryFn:         () => fetchFlowTimeseries(minutes, deviceId || undefined, filters.srcIp, filters.dstIp),
    refetchInterval: 30_000,
  })
  const series = [{ name: 'Bytes/s', color: '#6366f1', data: data.map(p => [p.ts_ms, p.bytes_total / 60] as [number, number]) }]
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Traffic volume</h2>
        <span className="text-[10px] text-slate-400">bytes/s avg per minute</span>
      </div>
      <div className="px-5 py-4">
        <TimeSeriesChart series={series} height={140} yFmt={v => fmtBytes(v) + '/s'} empty="No flow data yet" />
      </div>
    </div>
  )
}

// ── Top talkers ───────────────────────────────────────────────────────────────

function TopTalkersTable({ minutes, deviceId, filters, onFilter, onDetail }: {
  minutes: number; deviceId: string; filters: Filters
  onFilter: (role: 'src' | 'dst', ip: string) => void
  onDetail: (ip: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  // local no-op for protocol filter inside table rows — page-level handler owns it
  const setFilterProtoLocal = (_p: number) => {}

  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-top-talkers', minutes, deviceId, filters.protocol],
    queryFn:         () => fetchTopTalkers(minutes, 20, deviceId || undefined, filters.protocol),
    refetchInterval: 30_000,
  })

  const filtered = data.filter(r => {
    if (filters.srcIp  && r.src_ip !== filters.srcIp)  return false
    if (filters.dstIp  && r.dst_ip !== filters.dstIp)  return false
    return true
  })

  const uniqueIps = useMemo(() =>
    [...new Set(filtered.flatMap(r => [r.src_ip, r.dst_ip]))], [filtered])

  const { data: intel = {} } = useQuery({
    queryKey:  ['flow-intel', uniqueIps],
    queryFn:   () => fetchIpIntel(uniqueIps, true),
    enabled:   uniqueIps.length > 0,
    staleTime: 300_000,
  })

  const maxBytes = Math.max(...filtered.map(r => r.bytes_total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Top talkers</h2>
        <span className="text-[10px] text-slate-400">{filtered.length} pairs</span>
      </div>
      {isLoading ? (
        <SkeletonTable rows={6} cols={4} />
      ) : filtered.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {filtered.map((r, i) => {
            const key = `${r.src_ip}-${r.dst_ip}-${r.protocol}`
            const isOpen    = expanded === key
            const srcIntel  = intel[r.src_ip]
            const dstIntel  = intel[r.dst_ip]
            return (
              <div key={i}>
                <div className="px-5 py-2.5 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setExpanded(isOpen ? null : key)}
                      className="text-slate-300 hover:text-slate-500 transition-colors shrink-0"
                      title="Expand conversation"
                    >
                      <svg className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-base leading-none" title={srcIntel?.country_name ?? ''}>{countryFlag(srcIntel?.country_iso)}</span>
                        <ClickableIP ip={r.src_ip} role="src" onFilter={onFilter} onDetail={onDetail} />
                        <AbuseScore score={srcIntel?.abuse_score} />
                        <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14m-4-4 4 4-4 4"/></svg>
                        <span className="text-base leading-none" title={dstIntel?.country_name ?? ''}>{countryFlag(dstIntel?.country_iso)}</span>
                        <ClickableIP ip={r.dst_ip} role="dst" onFilter={onFilter} onDetail={onDetail} />
                        <AbuseScore score={dstIntel?.abuse_score} />
                        <ClickableProto name={r.protocol_name} proto={r.protocol} onFilter={setFilterProtoLocal} />
                        <span className="ml-auto text-xs font-bold text-slate-700 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(r.bytes_total / maxBytes) * 100}%` }} />
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-400">
                        <span>{fmtNum(r.packets_total)} pkts</span>
                        <span>{fmtNum(r.flow_count)} flows</span>
                        {srcIntel?.asn_org && <span className="truncate">{srcIntel.asn_org}</span>}
                      </div>
                    </div>
                  </div>
                </div>

                {isOpen && (
                  <ConversationTimeSeries
                    srcIp={r.src_ip} dstIp={r.dst_ip}
                    minutes={minutes} deviceId={deviceId}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConversationTimeSeries({ srcIp, dstIp, minutes, deviceId }: {
  srcIp: string; dstIp: string; minutes: number; deviceId: string
}) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['flow-conv-ts', srcIp, dstIp, minutes, deviceId],
    queryFn:  () => fetchFlowTimeseries(minutes, deviceId || undefined, srcIp, dstIp),
  })
  const series = [{ name: 'Bytes/s', color: '#6366f1', data: data.map(p => [p.ts_ms, p.bytes_total / 60] as [number, number]) }]
  return (
    <div className="px-8 pb-3 bg-slate-50 border-t border-slate-100">
      <p className="text-[10px] text-slate-400 pt-2 pb-1 font-medium uppercase tracking-wide">
        {srcIp} → {dstIp}
      </p>
      {isLoading ? (
        <SkeletonTable rows={3} cols={3} />
      ) : (
        <TimeSeriesChart series={series} height={80} yFmt={v => fmtBytes(v) + '/s'} empty="No data for this conversation" />
      )}
    </div>
  )
}

// ── Protocol breakdown ────────────────────────────────────────────────────────

function ProtocolBreakdown({ minutes, deviceId, filters, onFilterProto }: {
  minutes: number; deviceId: string; filters: Filters
  onFilterProto: (p: number) => void
}) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-protocols', minutes, deviceId],
    queryFn:         () => fetchProtocolBreakdown(minutes, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const byProto = useMemo(() => {
    const m: Record<string, { name: string; proto: number; bytes: number }> = {}
    for (const p of data) {
      const key = String(p.protocol)
      if (!m[key]) m[key] = { name: p.protocol_name, proto: p.protocol, bytes: 0 }
      m[key].bytes += p.bytes_total
    }
    return Object.values(m).sort((a, b) => b.bytes - a.bytes).slice(0, 12)
  }, [data])
  const maxBytes = Math.max(...byProto.map(p => p.bytes), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Protocol breakdown</h2>
      </div>
      {byProto.length === 0 ? <EmptyFlow /> : (
        <div className="px-5 py-3 space-y-2.5">
          {byProto.map(p => (
            <div key={p.proto} className="flex items-center gap-3">
              <button
                onClick={() => onFilterProto(p.proto)}
                className={`text-xs font-medium w-14 shrink-0 text-left transition-colors hover:underline ${filters.protocol === p.proto ? 'text-blue-600 font-bold' : 'text-slate-600'}`}
              >
                {p.name}
              </button>
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full transition-all cursor-pointer" onClick={() => onFilterProto(p.proto)} style={{ width: `${(p.bytes / maxBytes) * 100}%`, backgroundColor: protoColor(p.name) }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(p.bytes)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top ports ─────────────────────────────────────────────────────────────────

function TopPortsTable({ minutes, deviceId, filters, onFilterPort }: {
  minutes: number; deviceId: string; filters: Filters
  onFilterPort: (p: number) => void
}) {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-top-ports', minutes, deviceId],
    queryFn:         () => fetchTopPorts(minutes, 15, deviceId || undefined),
    refetchInterval: 30_000,
  })
  const maxBytes = Math.max(...data.map(r => r.bytes_total), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top destination ports</h2>
      </div>
      {isLoading ? <SkeletonTable rows={6} cols={4} />
        : data.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {data.map((r, i) => (
            <div key={i} className={`px-5 py-2.5 hover:bg-slate-50 transition-colors flex items-center gap-3 ${filters.dstPort === r.dst_port ? 'bg-blue-50' : ''}`}>
              <div className="w-12 text-right shrink-0">
                <ClickablePort port={r.dst_port} proto={r.protocol_name} onFilter={onFilterPort} />
              </div>
              <div className="w-20 shrink-0 text-[10px] text-slate-400">{PORT_NAMES[r.dst_port] ?? r.protocol_name}</div>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden cursor-pointer" onClick={() => onFilterPort(r.dst_port)}>
                <div className="h-full rounded-full transition-all" style={{ width: `${(r.bytes_total / maxBytes) * 100}%`, backgroundColor: protoColor(r.protocol_name) }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(r.bytes_total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Top devices ───────────────────────────────────────────────────────────────

function TopDevicesPanel({ minutes, onSelectDevice }: { minutes: number; onSelectDevice: (id: string) => void }) {
  const { data = [] } = useQuery({
    queryKey:        ['flow-top-devices', minutes],
    queryFn:         () => fetchTopDevices(minutes),
    refetchInterval: 30_000,
  })
  const maxBytes = Math.max(...data.map(d => d.bytes_total), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-800">Top devices by flow</h2>
      </div>
      {data.length === 0 ? <EmptyFlow /> : (
        <div className="divide-y divide-slate-50">
          {data.map(d => (
            <div key={d.device_id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group">
              <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }}>
                <DeviceTypeIcon type={d.device_type} size={14} />
              </span>
              <button onClick={() => onSelectDevice(d.device_id)} className="text-sm font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors w-32 shrink-0 text-left" title="Filter to this device">
                {d.device_name}
              </button>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${(d.bytes_total / maxBytes) * 100}%` }} />
              </div>
              <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtBytes(d.bytes_total)}</span>
              <Link to={`/devices/${d.device_id}`} className="shrink-0 text-slate-300 hover:text-blue-500 transition-colors" title="Go to device">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Flow search ───────────────────────────────────────────────────────────────

function FlowSearch({ deviceId, filters }: { deviceId: string; filters: Filters }) {
  const [open, setOpen] = useState(false)
  const [srcIp,   setSrcIp]   = useState(filters.srcIp   ?? '')
  const [dstIp,   setDstIp]   = useState(filters.dstIp   ?? '')
  const [proto,   setProto]   = useState(filters.protocol != null ? String(filters.protocol) : '')
  const [dstPort, setDstPort] = useState(filters.dstPort  != null ? String(filters.dstPort)  : '')
  const [minutes, setMinutes] = useState('10')
  const [submitted, setSubmitted] = useState(false)

  const params = {
    device_id: deviceId || undefined,
    src_ip:    srcIp    || undefined,
    dst_ip:    dstIp    || undefined,
    protocol:  proto    ? Number(proto)   : undefined,
    dst_port:  dstPort  ? Number(dstPort) : undefined,
    minutes:   Number(minutes),
    limit:     200,
  }

  const { data = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['flow-search', params],
    queryFn:  () => searchFlows(params),
    enabled:  submitted,
  })

  const inputCls = "border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 w-full bg-white"

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
        <h2 className="text-sm font-semibold text-slate-800">Flow search</h2>
        <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {open && (
        <>
          <div className="px-5 py-4 border-t border-slate-100 grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Src IP</label>
              <input value={srcIp} onChange={e => setSrcIp(e.target.value)} placeholder="1.2.3.4" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Dst IP</label>
              <input value={dstIp} onChange={e => setDstIp(e.target.value)} placeholder="5.6.7.8" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Protocol</label>
              <select value={proto} onChange={e => setProto(e.target.value)} className={inputCls}>
                <option value="">Any</option>
                <option value="6">TCP (6)</option>
                <option value="17">UDP (17)</option>
                <option value="1">ICMP (1)</option>
                <option value="89">OSPF (89)</option>
                <option value="47">GRE (47)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Dst port</label>
              <input value={dstPort} onChange={e => setDstPort(e.target.value)} placeholder="443" className={inputCls} type="number" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Window</label>
              <select value={minutes} onChange={e => setMinutes(e.target.value)} className={inputCls}>
                <option value="5">Last 5m</option>
                <option value="10">Last 10m</option>
                <option value="30">Last 30m</option>
                <option value="60">Last 1h</option>
                <option value="360">Last 6h</option>
              </select>
            </div>
          </div>
          <div className="px-5 pb-4 flex items-center gap-3">
            <button onClick={() => { setSubmitted(true); refetch() }} className="px-4 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-700 transition-colors">
              {isFetching ? 'Searching…' : 'Search'}
            </button>
            {submitted && <span className="text-xs text-slate-400">{data.length} records</span>}
          </div>
          {submitted && data.length > 0 && (
            <div className="border-t border-slate-100 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    {['Time','Src','Dst','Proto','Bytes','Pkts','Type'].map(h => (
                      <th key={h} className={`px-4 py-2 font-medium text-slate-500 ${h === 'Bytes' || h === 'Pkts' ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {data.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-2 font-mono text-slate-400 whitespace-nowrap">{fmtTs(r.flow_start_ms)}</td>
                      <td className="px-4 py-2 font-mono text-slate-700 whitespace-nowrap">
                        {r.src_ip}{r.src_port > 0 && <span className="text-slate-400">:{r.src_port}</span>}
                      </td>
                      <td className="px-4 py-2 font-mono text-slate-700 whitespace-nowrap">
                        {r.dst_ip}{r.dst_port > 0 && <span className="text-slate-400">:{r.dst_port}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: `${protoColor(r.protocol_name)}18`, color: protoColor(r.protocol_name) }}>
                          {r.protocol_name}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-600 whitespace-nowrap">{fmtBytes(r.bytes)}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-500 whitespace-nowrap">{fmtNum(r.packets)}</td>
                      <td className="px-4 py-2 text-slate-400">{r.flow_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {submitted && !isLoading && data.length === 0 && (
            <div className="px-5 py-6 text-center text-xs text-slate-400 border-t border-slate-100">No flows matched</div>
          )}
        </>
      )}
    </div>
  )
}

// ── Geo tab ───────────────────────────────────────────────────────────────────

function GeoTab({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-geo', minutes, deviceId],
    queryFn:         () => fetchGeoSummary(minutes, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const maxBytes = Math.max(...data.map(r => r.bytes_total), 1)
  const total    = data.reduce((s, r) => s + r.bytes_total, 0)

  if (isLoading) return <div className="p-8"><SkeletonTable rows={5} cols={4} /></div>
  if (data.length === 0) return <EmptyFlow />

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Flow by country</h2>
        <span className="text-[10px] text-slate-400">{data.length} countries · {fmtBytes(total)} total</span>
      </div>
      <div className="divide-y divide-slate-50">
        {data.map(r => {
          const pct = Math.round((r.bytes_total / maxBytes) * 100)
          const isPrivate = r.country_iso === 'PRIVATE'
          return (
            <div key={r.country_iso} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50">
              <span className="text-xl w-8 shrink-0">{isPrivate ? '🏠' : countryFlag(r.country_iso)}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-700 truncate">{r.country_name}</span>
                  <span className="text-xs font-bold text-slate-700 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-blue-400" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{r.unique_ips} IPs</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="px-5 py-3 border-t border-slate-100 text-[10px] text-slate-400">
        GeoIP via ip-api.com · Updates every 7 days · Private/RFC1918 ranges shown separately
      </div>
    </div>
  )
}

// ── Threats tab ───────────────────────────────────────────────────────────────

function ThreatsTab({ minutes, deviceId, onDetail }: {
  minutes: number; deviceId: string; onDetail: (ip: string) => void
}) {
  const [minScore, setMinScore] = useState(25)

  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-threats', minutes, deviceId, minScore],
    queryFn:         () => fetchFlowThreats(minutes, minScore, deviceId || undefined),
    refetchInterval: 120_000,
  })

  const scoreColor = (s: number) => s >= 75 ? '#ef4444' : s >= 50 ? '#f97316' : '#f59e0b'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500">Min abuse score:</span>
        {[10, 25, 50, 75].map(v => (
          <button key={v} onClick={() => setMinScore(v)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${minScore === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
            {v}+
          </button>
        ))}
        {data.length > 0 && <span className="text-xs text-red-500 font-medium ml-1">{data.length} flagged</span>}
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-xs text-slate-400">Checking threat intelligence…</div>
      ) : data.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <p className="text-sm text-green-600 font-medium">No threats detected</p>
          <p className="text-xs text-slate-400 mt-1">No IPs with abuse score ≥ {minScore} seen in the last {minutes < 60 ? `${minutes}m` : `${minutes/60}h`}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">IP</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Country / ASN</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Score</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Bytes</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Flows</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Dst IPs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {data.map(r => (
                <tr key={r.ip} className="hover:bg-red-50/40 transition-colors cursor-pointer" onClick={() => onDetail(r.ip)}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span>{countryFlag(r.country_iso)}</span>
                      <span className="font-mono font-bold text-slate-800">{r.ip}</span>
                    </div>
                    {r.abuse_domain && <div className="text-slate-400 mt-0.5 truncate max-w-[160px]">{r.abuse_domain}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">
                    <div>{r.country_name ?? '—'}</div>
                    {r.asn_org && <div className="text-slate-400 truncate max-w-[140px]">{r.asn_org}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <div className="w-12 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${r.abuse_score}%`, backgroundColor: scoreColor(r.abuse_score) }} />
                      </div>
                      <span className="font-bold tabular-nums" style={{ color: scoreColor(r.abuse_score) }}>{r.abuse_score}</span>
                    </div>
                    {r.abuse_reports != null && <div className="text-slate-400">{r.abuse_reports} reports</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-600 tabular-nums">{fmtBytes(r.bytes_total)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500 tabular-nums">{fmtNum(r.flow_count)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500 tabular-nums">{r.unique_destinations}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-3 border-t border-slate-100 text-[10px] text-slate-400">
            Source: AbuseIPDB · Cached 24h · Configure API key in Settings → Platform
          </div>
        </div>
      )}
    </div>
  )
}

// ── Direction tab ─────────────────────────────────────────────────────────────

const DIR_COLOR: Record<string, string> = {
  inbound:  '#6366f1', outbound: '#f59e0b',
  internal: '#16a34a', transit:  '#94a3b8',
}
const DIR_LABEL: Record<string, string> = {
  inbound:  'Inbound',  outbound: 'Outbound',
  internal: 'Internal', transit:  'Transit',
}

function DirectionTab({ minutes, deviceId, onDetail }: { minutes: number; deviceId: string; onDetail: (ip: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey:        ['flow-direction', minutes, deviceId],
    queryFn:         () => fetchDirectionSummary(minutes, deviceId || undefined),
    refetchInterval: 60_000,
  })

  if (isLoading) return <div className="p-8"><SkeletonTable rows={4} cols={3} /></div>
  if (!data) return <EmptyFlow />

  const dirs = Object.entries(data.summary).sort((a, b) => b[1].bytes_total - a[1].bytes_total)
  const maxBytes = Math.max(...dirs.map(([, v]) => v.bytes_total), 1)

  return (
    <div className="space-y-5">
      {/* Direction breakdown bars */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-800 mb-4">Traffic direction breakdown</h3>
        <div className="space-y-3">
          {dirs.map(([dir, v]) => (
            <div key={dir}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-700">{DIR_LABEL[dir]}</span>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="tabular-nums">{fmtBytes(v.bytes_total)}</span>
                  <span className="tabular-nums w-8 text-right font-semibold" style={{ color: DIR_COLOR[dir] }}>{v.pct}%</span>
                </div>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{ width: `${(v.bytes_total / maxBytes) * 100}%`, backgroundColor: DIR_COLOR[dir] }} />
              </div>
              <div className="flex gap-4 mt-0.5 text-[10px] text-slate-400">
                <span>{fmtNum(v.flow_count)} flows</span>
                <span>{v.unique_src} src IPs</span>
                <span>{v.unique_dst} dst IPs</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top inbound sources */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-800">Top inbound sources</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">External IPs sending most traffic to your network</p>
          </div>
          {data.top_inbound_sources.length === 0 ? <EmptyFlow /> : (
            <div className="divide-y divide-slate-50">
              {data.top_inbound_sources.map(r => (
                <div key={r.ip} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50">
                  <span className="text-base">{countryFlag(null)}</span>
                  <button onClick={() => onDetail(r.ip)} className="font-mono text-xs text-blue-600 hover:underline w-32 shrink-0 text-left">{r.ip}</button>
                  <div className="flex-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(r.bytes_total / (data.top_inbound_sources[0]?.bytes_total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-xs text-slate-600 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top outbound destinations */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-800">Top outbound destinations</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">External IPs your network sends most traffic to</p>
          </div>
          {data.top_outbound_destinations.length === 0 ? <EmptyFlow /> : (
            <div className="divide-y divide-slate-50">
              {data.top_outbound_destinations.map(r => (
                <div key={r.ip} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50">
                  <span className="text-base">{countryFlag(null)}</span>
                  <button onClick={() => onDetail(r.ip)} className="font-mono text-xs text-blue-600 hover:underline w-32 shrink-0 text-left">{r.ip}</button>
                  <div className="flex-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${(r.bytes_total / (data.top_outbound_destinations[0]?.bytes_total || 1)) * 100}%` }} />
                  </div>
                  <span className="text-xs text-slate-600 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Networks tab (ASN + subnets) ───────────────────────────────────────────────

function NetworksTab({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const [asnDir, setAsnDir] = useState<'src'|'dst'>('src')
  const [subnetDir, setSubnetDir] = useState<'src'|'dst'>('src')

  const { data: asns = [] } = useQuery({
    queryKey:        ['flow-asn', minutes, deviceId, asnDir],
    queryFn:         () => fetchAsnSummary(minutes, asnDir, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const { data: subnets = [] } = useQuery({
    queryKey:        ['flow-subnet', minutes, deviceId, subnetDir],
    queryFn:         () => fetchSubnetSummary(minutes, subnetDir, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const maxAsnBytes    = Math.max(...asns.map(r => r.bytes_total), 1)
  const maxSubnetBytes = Math.max(...subnets.map(r => r.bytes_total), 1)

  const DirToggle = ({ value, onChange }: { value: string; onChange: (v: 'src'|'dst') => void }) => (
    <div className="flex rounded overflow-hidden border border-slate-200 text-[10px]">
      {(['src', 'dst'] as const).map(v => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-2 py-1 font-medium transition-colors ${value === v ? 'bg-slate-700 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
          {v === 'src' ? 'Senders' : 'Receivers'}
        </button>
      ))}
    </div>
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* ASN */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Autonomous Systems</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Who owns the IPs in your traffic</p>
          </div>
          <DirToggle value={asnDir} onChange={setAsnDir} />
        </div>
        {asns.length === 0 ? <EmptyFlow /> : (
          <div className="divide-y divide-slate-50">
            {asns.slice(0, 15).map(r => (
              <div key={r.asn} className="flex items-center gap-2 px-4 py-2 hover:bg-slate-50">
                <span className="text-[10px] font-mono text-slate-400 w-12 shrink-0">AS{r.asn}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <span className="text-xs text-slate-700 truncate">{r.asn_name}</span>
                    <span className="text-xs font-bold text-slate-700 tabular-nums shrink-0">{fmtBytes(r.bytes_total)}</span>
                  </div>
                  <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-blue-400" style={{ width: `${(r.bytes_total / maxAsnBytes) * 100}%` }} />
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{r.pct}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Subnets */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Subnets (/24)</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Traffic aggregated by /24 block</p>
          </div>
          <DirToggle value={subnetDir} onChange={setSubnetDir} />
        </div>
        {subnets.length === 0 ? <EmptyFlow /> : (
          <div className="divide-y divide-slate-50">
            {subnets.slice(0, 15).map(r => (
              <div key={r.subnet} className="flex items-center gap-2 px-4 py-2 hover:bg-slate-50">
                <span className="font-mono text-xs text-slate-700 w-28 shrink-0">{r.subnet}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <span className="text-[10px] text-slate-400">{r.unique_ips} IPs</span>
                    <span className="text-xs font-bold text-slate-700 tabular-nums">{fmtBytes(r.bytes_total)}</span>
                  </div>
                  <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-purple-400" style={{ width: `${(r.bytes_total / maxSubnetBytes) * 100}%` }} />
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{r.pct}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Applications tab ───────────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  Web: '#6366f1', DNS: '#06b6d4', Email: '#f59e0b', Remote: '#ef4444',
  File: '#8b5cf6', Database: '#0891b2', Network: '#64748b',
  Streaming: '#ec4899', VPN: '#d97706', P2P: '#71717a', Gaming: '#84cc16', Other: '#94a3b8',
}

function ApplicationsTab({ minutes, deviceId }: { minutes: number; deviceId: string }) {
  const [showPorts, setShowPorts] = useState(false)

  const { data = [], isLoading } = useQuery({
    queryKey:        ['flow-apps', minutes, deviceId],
    queryFn:         () => fetchApplicationSummary(minutes, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const categories = data.filter(d => d.type === 'category') as AppCategory[]
  const ports      = data.filter(d => d.type === 'port')     as AppPort[]
  const totalBytes = categories.reduce((s, c) => s + c.bytes_total, 0) || 1
  const maxBytes   = Math.max(...categories.map(c => c.bytes_total), 1)

  if (isLoading) return <div className="p-8"><SkeletonTable rows={5} cols={4} /></div>
  if (categories.length === 0) return <EmptyFlow />

  return (
    <div className="space-y-5">
      {/* Category summary */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">Application categories</h3>
          <button onClick={() => setShowPorts(!showPorts)}
            className="text-[10px] text-blue-600 hover:underline">
            {showPorts ? 'Hide ports' : 'Show ports'}
          </button>
        </div>

        {/* Stacked bar */}
        <div className="flex h-4 rounded-lg overflow-hidden gap-px mb-4">
          {categories.map(c => (
            <div key={c.category} style={{ width: `${c.pct}%`, backgroundColor: CAT_COLOR[c.category] ?? '#94a3b8' }}
              title={`${c.category}: ${c.pct}%`} className="min-w-[2px]" />
          ))}
        </div>

        <div className="space-y-2">
          {categories.map(c => (
            <div key={c.category}>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: CAT_COLOR[c.category] ?? '#94a3b8' }} />
                <span className="text-xs font-medium text-slate-700 w-24 shrink-0">{c.category}</span>
                <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(c.bytes_total / maxBytes) * 100}%`, backgroundColor: CAT_COLOR[c.category] ?? '#94a3b8' }} />
                </div>
                <span className="text-xs font-bold text-slate-700 tabular-nums w-16 text-right shrink-0">{fmtBytes(c.bytes_total)}</span>
                <span className="text-[10px] text-slate-400 w-8 text-right shrink-0">{c.pct}%</span>
              </div>
              {showPorts && (
                <div className="ml-4 flex flex-wrap gap-1 mb-1">
                  {c.services.map(s => (
                    <span key={s} className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                      style={{ backgroundColor: `${CAT_COLOR[c.category]}20`, color: CAT_COLOR[c.category] ?? '#94a3b8' }}>
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Port table */}
      {showPorts && ports.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Service</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Port</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Category</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Bytes</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Flows</th>
                <th className="text-right px-4 py-2.5 font-medium text-slate-600">Src IPs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {ports.slice(0, 30).map(p => (
                <tr key={`${p.port}-${p.protocol}`} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-700">{p.service}</td>
                  <td className="px-4 py-2 font-mono text-slate-500">{p.port}/{p.protocol}</td>
                  <td className="px-4 py-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                      style={{ backgroundColor: `${CAT_COLOR[p.category]}20`, color: CAT_COLOR[p.category] ?? '#94a3b8' }}>
                      {p.category}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">{fmtBytes(p.bytes_total)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtNum(p.flow_count)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{p.unique_src}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Connections helpers (module-scoped so IpDetailPanel can use them) ─────────

function fmtFlags(flags: number): string {
  const names = []
  if (flags & 1)  names.push('FIN')
  if (flags & 2)  names.push('SYN')
  if (flags & 4)  names.push('RST')
  if (flags & 8)  names.push('PSH')
  if (flags & 16) names.push('ACK')
  if (flags & 32) names.push('URG')
  return names.join('+') || '—'
}

function fmtDuration(s: number): string {
  if (s < 1)   return '<1s'
  if (s < 60)  return `${s}s`
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
}

function ConnectionsTab({ minutes, deviceId, onDetail }: { minutes: number; deviceId: string; onDetail: (ip: string) => void }) {
  const [minMb, setMinMb] = useState(5)

  const { data: elephants = [], isLoading: eLoading } = useQuery({
    queryKey:        ['flow-elephants', minutes, deviceId, minMb],
    queryFn:         () => fetchElephantFlows(minutes, minMb, deviceId || undefined),
    refetchInterval: 60_000,
  })

  const { data: tcpData, isLoading: tLoading } = useQuery({
    queryKey:        ['flow-tcp', minutes, deviceId],
    queryFn:         () => fetchTcpFlags(minutes, deviceId || undefined),
    refetchInterval: 60_000,
  })

  return (
    <div className="space-y-5">
      {/* TCP flag analysis */}
      {tcpData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-1">TCP flag breakdown</h3>
            <p className="text-[10px] text-slate-400 mb-4">{fmtNum(tcpData.total_tcp_flows)} TCP flows · {fmtBytes(tcpData.total_bytes)}</p>
            <div className="space-y-2">
              {Object.entries(tcpData.flags).map(([flag, v]) => {
                const labels: Record<string, { label: string; color: string }> = {
                  syn_only: { label: 'SYN only (attempts)',  color: '#f59e0b' },
                  syn_ack:  { label: 'SYN-ACK (established)',color: '#16a34a' },
                  rst:      { label: 'RST (resets)',          color: '#ef4444' },
                  fin:      { label: 'FIN (graceful close)',  color: '#6366f1' },
                  ack_only: { label: 'ACK (data transfer)',   color: '#06b6d4' },
                  psh_ack:  { label: 'PSH+ACK (data push)',   color: '#8b5cf6' },
                }
                const { label, color } = labels[flag] ?? { label: flag, color: '#94a3b8' }
                return (
                  <div key={flag} className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 w-40 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${v.pct}%`, backgroundColor: color }} />
                    </div>
                    <span className="text-[10px] tabular-nums text-slate-500 w-12 text-right shrink-0">{fmtNum(v.count)}</span>
                    <span className="text-[10px] font-semibold w-8 text-right shrink-0" style={{ color }}>{v.pct}%</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="space-y-3">
            {tcpData.scan_candidates.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <p className="text-xs font-semibold text-amber-700 mb-2">⚠ Scan candidates (SYN only, many ports/targets)</p>
                <div className="space-y-1">
                  {tcpData.scan_candidates.slice(0, 5).map(r => (
                    <div key={r.ip} className="flex items-center gap-2 text-xs">
                      <button onClick={() => onDetail(r.ip)} className="font-mono text-blue-600 hover:underline w-28 shrink-0">{r.ip}</button>
                      <span className="text-amber-600">{fmtNum(r.syn_count)} SYNs</span>
                      <span className="text-slate-500">{r.unique_targets} hosts · {r.unique_ports} ports</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {tcpData.top_rst_sources.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                <p className="text-xs font-semibold text-red-700 mb-2">Top RST sources (resets / refused)</p>
                <div className="space-y-1">
                  {tcpData.top_rst_sources.slice(0, 5).map(r => (
                    <div key={r.ip} className="flex items-center gap-2 text-xs">
                      <button onClick={() => onDetail(r.ip)} className="font-mono text-blue-600 hover:underline w-28 shrink-0">{r.ip}</button>
                      <span className="text-red-600">{fmtNum(r.rst_count)} RSTs</span>
                      <span className="text-slate-500">{r.unique_targets} hosts · {r.unique_ports} ports</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Elephant flows */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Elephant flows</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">Individual flows above threshold — sampling-rate corrected</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500">Min size:</span>
            <div className="flex rounded overflow-hidden border border-slate-200">
              {[1, 5, 10, 50, 100].map(v => (
                <button key={v} onClick={() => setMinMb(v)}
                  className={`px-2 py-1 text-[10px] font-medium transition-colors ${minMb === v ? 'bg-slate-700 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                  {v}MB
                </button>
              ))}
            </div>
          </div>
        </div>
        {eLoading ? (
          <SkeletonTable rows={6} cols={4} />
        ) : elephants.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">No flows above {minMb}MB in this window</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Source</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Destination</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Service</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Flags</th>
                  <th className="text-right px-4 py-2.5 font-medium text-slate-600">Size</th>
                  <th className="text-right px-4 py-2.5 font-medium text-slate-600">Rate</th>
                  <th className="text-right px-4 py-2.5 font-medium text-slate-600">Duration</th>
                  <th className="text-right px-4 py-2.5 font-medium text-slate-600">Sample</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {elephants.map((f, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <button onClick={() => onDetail(f.src_ip)} className="font-mono text-blue-600 hover:underline">{f.src_ip}</button>
                      {f.src_port > 0 && <span className="text-slate-400">:{f.src_port}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <button onClick={() => onDetail(f.dst_ip)} className="font-mono text-blue-600 hover:underline">{f.dst_ip}</button>
                      {f.dst_port > 0 && <span className="text-slate-400">:{f.dst_port}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-slate-600">{f.service}</span>
                      <span className="text-slate-400 ml-1 text-[10px]">{f.protocol}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[10px] text-slate-500">{fmtFlags(f.tcp_flags)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-bold text-slate-700">{fmtBytes(f.bytes_est)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtBytes(f.bps)}/s</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtDuration(f.duration_s)}</td>
                    <td className="px-4 py-2 text-right">
                      {f.sampling_rate > 1 && (
                        <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold">×{f.sampling_rate}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyFlow() {
  return (
    <div className="px-5 py-8 text-center">
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-slate-100 mb-3">
        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path d="M3 7h4l2 4h10l-2-9H9L7 7M3 7l2 10h14l2-4"/></svg>
      </div>
      <p className="text-sm text-slate-400">No flow data</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type FlowTab = 'traffic' | 'direction' | 'networks' | 'applications' | 'connections' | 'geo' | 'threats'

export default function FlowPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const deviceId   = searchParams.get('device') ?? ''
  const windowMins = Number(searchParams.get('window') ?? '60')
  const flowTab    = (searchParams.get('tab') as FlowTab | null) ?? 'traffic'
  const [detailIp, setDetailIp] = useState<string | null>(null)

  const filters: Filters = useMemo(() => {
    const f: Filters = {}
    const src = searchParams.get('src');   if (src) f.srcIp = src
    const dst = searchParams.get('dst');   if (dst) f.dstIp = dst
    const proto = searchParams.get('proto'); if (proto) f.protocol = Number(proto)
    const port = searchParams.get('port');   if (port) f.dstPort = Number(port)
    return f
  }, [searchParams])

  const { data: devicesResp } = useQuery({
    queryKey: ['devices-list'],
    queryFn:  () => fetchDevices({ limit: 500 }),
  })
  const devices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  const setDeviceId = (id: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id === '') next.delete('device'); else next.set('device', id)
      return next
    })
  }
  const setWindowMins = (m: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (m === 60) next.delete('window'); else next.set('window', String(m))
      return next
    })
  }
  const setFlowTab = (t: FlowTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (t === 'traffic') next.delete('tab'); else next.set('tab', t)
      return next
    })
  }
  const setFilters = (update: Filters | ((f: Filters) => Filters)) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const updated = typeof update === 'function' ? update(filters) : update
      if (updated.srcIp)            next.set('src', updated.srcIp);              else next.delete('src')
      if (updated.dstIp)            next.set('dst', updated.dstIp);              else next.delete('dst')
      if (updated.protocol != null) next.set('proto', String(updated.protocol)); else next.delete('proto')
      if (updated.dstPort != null)  next.set('port', String(updated.dstPort));   else next.delete('port')
      return next
    })
  }

  const setFilter = (role: 'src' | 'dst', ip: string) => {
    if (!ip) return
    setFilters(f => role === 'src' ? { ...f, srcIp: ip } : { ...f, dstIp: ip })
  }
  const setFilterProto = (p: number) => setFilters(f => ({ ...f, protocol: f.protocol === p ? undefined : p }))
  const setFilterPort  = (p: number) => setFilters(f => ({ ...f, dstPort:  f.dstPort  === p ? undefined : p }))
  const removeFilter   = (k: keyof Filters) => setFilters(f => { const n = { ...f }; delete n[k]; return n })
  const clearFilters   = () => setFilters({})

  const hasFilters = Object.keys(filters).some(k => filters[k as keyof Filters] != null)

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-slate-800">Flow</h1>
            <p className="text-xs text-slate-400 mt-0.5">NetFlow · sFlow · IPFIX</p>
          </div>

          <select value={deviceId} onChange={e => setDeviceId(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-600">
            <option value="">All devices</option>
            {devices.map((d: any) => <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>)}
          </select>

          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {TIME_WINDOWS.map(w => (
              <button key={w.minutes} onClick={() => setWindowMins(w.minutes)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${windowMins === w.minutes ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'} ${w.minutes !== 15 ? 'border-l border-slate-200' : ''}`}>
                {w.label}
              </button>
            ))}
          </div>

          <SavedViewsMenu page="flow" query={searchParams.toString()} onApply={q => setSearchParams(new URLSearchParams(q))} />
        </div>

        {/* Tab bar */}
        <div className="flex gap-0 border-b border-slate-100 mt-3 -mb-1 overflow-x-auto scrollbar-hide">
          {([
            { id: 'traffic',      label: 'Traffic',      icon: '📊' },
            { id: 'direction',    label: 'Direction',    icon: '↕' },
            { id: 'networks',     label: 'Networks',     icon: '🔗' },
            { id: 'applications', label: 'Applications', icon: '⚙️' },
            { id: 'connections',  label: 'Connections',  icon: '🐘' },
            { id: 'geo',          label: 'Geo',          icon: '🌍' },
            { id: 'threats',      label: 'Threats',      icon: '🛡️' },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setFlowTab(t.id)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${flowTab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Active filter chips */}
        {hasFilters && flowTab === 'traffic' && (
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <FilterChips filters={filters} onRemove={removeFilter} />
            <button onClick={clearFilters} className="text-[10px] text-slate-400 hover:text-slate-600 underline">Clear all</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6 space-y-4">
        {flowTab === 'geo' ? (
          <GeoTab minutes={windowMins} deviceId={deviceId} />
        ) : flowTab === 'threats' ? (
          <ThreatsTab minutes={windowMins} deviceId={deviceId} onDetail={setDetailIp} />
        ) : flowTab === 'direction' ? (
          <DirectionTab minutes={windowMins} deviceId={deviceId} onDetail={setDetailIp} />
        ) : flowTab === 'networks' ? (
          <NetworksTab minutes={windowMins} deviceId={deviceId} />
        ) : flowTab === 'applications' ? (
          <ApplicationsTab minutes={windowMins} deviceId={deviceId} />
        ) : flowTab === 'connections' ? (
          <ConnectionsTab minutes={windowMins} deviceId={deviceId} onDetail={setDetailIp} />
        ) : (<>
        <SummaryCards minutes={windowMins} deviceId={deviceId} filters={filters} />
        <FlowTimeSeries minutes={windowMins} deviceId={deviceId} filters={filters} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3">
            <TopTalkersTable
              minutes={windowMins} deviceId={deviceId} filters={filters}
              onFilter={setFilter} onDetail={setDetailIp}
            />
          </div>
          <div className="lg:col-span-2">
            <ProtocolBreakdown
              minutes={windowMins} deviceId={deviceId} filters={filters}
              onFilterProto={setFilterProto}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TopPortsTable
            minutes={windowMins} deviceId={deviceId} filters={filters}
            onFilterPort={setFilterPort}
          />
          <TopDevicesPanel minutes={windowMins} onSelectDevice={setDeviceId} />
        </div>

        <FlowSearch deviceId={deviceId} filters={filters} />
        </>)}
      </div>

      {/* IP detail slide-out */}
      {detailIp && (
        <IpDetailPanel
          ip={detailIp} minutes={windowMins} deviceId={deviceId}
          onClose={() => setDetailIp(null)}
          onFilter={(role, ip) => { setFilter(role, ip); setDetailIp(null) }}
        />
      )}
    </div>
  )
}
