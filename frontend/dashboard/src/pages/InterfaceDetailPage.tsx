import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate, Link } from 'react-router-dom'
import api from '../api/client'
import { fetchDevice } from '../api/devices'
import { fetchInterfaceFlowTimeseries, fetchInterfaceTopTalkers } from '../api/flow'
import StatusBadge from '../components/StatusBadge'
import TimeSeriesChart from '../components/TimeSeriesChart'
import type { Interface } from '../api/types'
import { SkeletonDetailPage, SkeletonChart, SkeletonTable } from '../components/Skeleton'

// ── Types ──────────────────────────────────────────────────────────────────

interface IfaceMetrics {
  if_name:      string
  speed_bps:    number | null
  in_bps:       [number, number][]
  out_bps:      [number, number][]
  in_errors:    [number, number][]
  out_errors:   [number, number][]
  in_discards:  [number, number][]
  out_discards: [number, number][]
}

interface LivePoint {
  ts:           number
  in_bps:       number | null
  out_bps:      number | null
  in_pps:       number | null
  out_pps:      number | null
  in_errors_ps: number | null
  out_errors_ps:number | null
  util_in_pct:  number | null
  util_out_pct: number | null
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtBps(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mbps`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} Kbps`
  return `${v.toFixed(0)} bps`
}

function fmtBpsShort(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v.toFixed(0)}`
}

function fmtRateShort(v: number): string {
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K/s`
  if (v >= 1)   return `${v.toFixed(1)}/s`
  return `${(v * 1000).toFixed(0)}m/s`
}

function fmtPps(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M pps`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K pps`
  return `${v.toFixed(0)} pps`
}

function fmtSpeed(bps: number | null): string {
  if (!bps) return '—'
  if (bps >= 1e9) return `${bps / 1e9} Gbps`
  if (bps >= 1e6) return `${bps / 1e6} Mbps`
  return `${bps} bps`
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function utilColor(pct: number): string {
  if (pct > 90) return '#dc2626'
  if (pct > 70) return '#f59e0b'
  return '#0891b2'
}

// ── Info card ──────────────────────────────────────────────────────────────

function InfoCard({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="bg-slate-50 rounded-xl px-4 py-3">
      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-sm font-medium text-slate-800 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}

// ── Live stat tile ─────────────────────────────────────────────────────────

function LiveTile({ label, value, sub, color }: {
  label: string; value: string | null; sub?: string; color: string
}) {
  return (
    <div className="flex flex-col px-5 py-3">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-xl font-bold text-slate-800">
        {value ?? <span className="text-slate-300 text-sm animate-pulse">—</span>}
      </div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5 font-mono">{sub}</div>}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

const RANGES = [
  { label: '1h',  hours: 1   },
  { label: '6h',  hours: 6   },
  { label: '24h', hours: 24  },
  { label: '7d',  hours: 168 },
  { label: '30d', hours: 720 },
]

const LIVE_WINDOW_S = 180  // 3-minute rolling window

export default function InterfaceDetailPage() {
  const { id: deviceId, ifaceId } = useParams<{ id: string; ifaceId: string }>()
  const navigate  = useNavigate()
  const [hours, setHours] = useState(1)

  // ── Live mode state ─────────────────────────────────────────────────────
  const [liveMode,   setLiveMode]   = useState(false)
  const [livePoints, setLivePoints] = useState<LivePoint[]>([])
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle')
  const [liveError,  setLiveError]  = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const stopLive = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    setLiveMode(false)
    setLiveStatus('idle')
  }, [])

  const startLive = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    setLiveMode(true)
    setLivePoints([])
    setLiveStatus('connecting')
    setLiveError(null)

    const token = localStorage.getItem('token') ?? ''
    const url   = `/api/v1/interfaces/${ifaceId}/live?token=${encodeURIComponent(token)}`
    const es    = new EventSource(url)

    es.onopen = () => setLiveStatus('live')

    es.onmessage = (evt) => {
      try {
        const point = JSON.parse(evt.data) as LivePoint & { done?: boolean; error?: string }
        if (point.done)  { stopLive(); return }
        if (point.error) {
          setLiveStatus('error')
          setLiveError(point.error)
          es.close()
          esRef.current = null
          return
        }
        setLiveStatus('live')
        setLivePoints(prev => {
          const cutoff = Date.now() / 1000 - LIVE_WINDOW_S
          return [...prev.filter(p => p.ts > cutoff), point]
        })
      } catch { /* ignore malformed events */ }
    }

    es.onerror = () => {
      setLiveStatus('error')
      setLiveError('Connection interrupted')
      es.close()
      esRef.current = null
    }

    esRef.current = es
  }, [ifaceId, stopLive])

  // Clean up SSE on unmount
  useEffect(() => () => { esRef.current?.close() }, [])

  // ── Data queries ────────────────────────────────────────────────────────
  const { data: device } = useQuery({
    queryKey: ['device', deviceId],
    queryFn:  () => fetchDevice(deviceId!),
    enabled:  !!deviceId,
  })

  const { data: iface, isLoading: ifaceLoading } = useQuery<Interface>({
    queryKey: ['interface', ifaceId],
    queryFn:  () => api.get<Interface>(`/interfaces/${ifaceId}`).then(r => r.data),
    enabled:  !!ifaceId,
  })

  const { data: metrics, isLoading: metricsLoading } = useQuery<IfaceMetrics>({
    queryKey:        ['iface-metrics', ifaceId, hours],
    queryFn:         () => api.get<IfaceMetrics>(`/interfaces/${ifaceId}/utilisation`, { params: { hours } }).then(r => r.data),
    enabled:         !!ifaceId && !liveMode,
    staleTime:       0,
    refetchInterval: 30_000,
  })

  if (ifaceLoading) {
    return <SkeletonDetailPage />
  }
  if (!iface) {
    return <div className="flex items-center justify-center h-full text-slate-400 text-sm">Interface not found</div>
  }

  const speed     = metrics?.speed_bps ?? iface.speed_bps
  const hostname  = device?.fqdn ?? device?.hostname ?? deviceId
  const ipAddresses: string[] = Array.isArray((iface as any).ip_addresses)
    ? (iface as any).ip_addresses.map((a: any) => (typeof a === 'string' ? a : a?.address ?? String(a)))
    : []

  // Historical stats (non-live)
  const inLast      = metrics?.in_bps?.at(-1)?.[1]      ?? null
  const outLast     = metrics?.out_bps?.at(-1)?.[1]     ?? null
  const inPct       = speed && inLast  != null ? inLast  / speed * 100 : null
  const outPct      = speed && outLast != null ? outLast / speed * 100 : null
  const inErrLast   = metrics?.in_errors?.at(-1)?.[1]   ?? null
  const outErrLast  = metrics?.out_errors?.at(-1)?.[1]  ?? null
  const inDiscLast  = metrics?.in_discards?.at(-1)?.[1] ?? null
  const outDiscLast = metrics?.out_discards?.at(-1)?.[1] ?? null

  // Period aggregates over selected window
  const inVals     = metrics?.in_bps?.map(([, v]) => v)  ?? []
  const outVals    = metrics?.out_bps?.map(([, v]) => v) ?? []
  const avgInBps   = inVals.length  ? inVals.reduce((a, b) => a + b, 0) / inVals.length  : null
  const avgOutBps  = outVals.length ? outVals.reduce((a, b) => a + b, 0) / outVals.length : null
  const peakInBps  = inVals.length  ? Math.max(...inVals)  : null
  const peakOutBps = outVals.length ? Math.max(...outVals) : null
  const peakInPct  = speed && peakInBps  != null ? peakInBps  / speed * 100 : null
  const peakOutPct = speed && peakOutBps != null ? peakOutBps / speed * 100 : null

  // Live stats
  const lastLive    = livePoints.at(-1)
  const liveInBps   = lastLive?.in_bps   ?? null
  const liveOutBps  = lastLive?.out_bps  ?? null
  const liveInPps   = lastLive?.in_pps   ?? null
  const liveOutPps  = lastLive?.out_pps  ?? null
  const liveInPct   = lastLive?.util_in_pct  ?? null
  const liveOutPct  = lastLive?.util_out_pct ?? null
  const liveInErrPs = lastLive?.in_errors_ps  ?? null
  const liveOutErrPs= lastLive?.out_errors_ps ?? null

  const liveInSeries:  [number, number][] = livePoints.filter(p => p.in_bps  != null).map(p => [p.ts, p.in_bps!])
  const liveOutSeries: [number, number][] = livePoints.filter(p => p.out_bps != null).map(p => [p.ts, p.out_bps!])

  const adminUp = iface.admin_status === 'up'
  const operUp  = iface.oper_status  === 'up'

  return (
    <div className="flex flex-col min-h-full bg-slate-50">

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <nav className="flex items-center gap-1.5 text-xs text-slate-400 mb-3">
          <button onClick={() => navigate(`/devices/${deviceId}`)} className="hover:text-slate-600 transition-colors">
            {hostname}
          </button>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          <button onClick={() => navigate(`/devices/${deviceId}`)} className="hover:text-slate-600 transition-colors">
            Interfaces
          </button>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          <span className="text-slate-600 font-medium">{iface.name}</span>
        </nav>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-bold text-slate-900 font-mono">{iface.name}</h1>
              <StatusBadge status={iface.admin_status} />
              {iface.admin_status !== iface.oper_status && <StatusBadge status={iface.oper_status} />}
            </div>
            {iface.description && <p className="text-sm text-slate-500">{iface.description}</p>}
            {!adminUp && <p className="text-xs text-amber-600 mt-0.5">Interface is administratively down</p>}
            {adminUp && !operUp && <p className="text-xs text-red-500 mt-0.5">Interface is down — link may be disconnected</p>}
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold text-slate-800">{fmtSpeed(speed)}</div>
            <div className="text-xs text-slate-400 mt-0.5">{iface.if_type ?? 'Unknown type'}</div>
          </div>
        </div>
      </div>

      {/* Info cards */}
      <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <InfoCard label="Speed"       value={fmtSpeed(iface.speed_bps)} />
        <InfoCard label="MTU"         value={iface.mtu ?? '—'} />
        <InfoCard label="Index"       value={iface.if_index} />
        <InfoCard label="MAC"         value={iface.mac_address ?? '—'} mono />
        <InfoCard label="Last change" value={fmtAge(iface.last_change)} />
        <InfoCard
          label="IP addresses"
          value={ipAddresses.length > 0
            ? <div className="space-y-0.5">{ipAddresses.map(a => <div key={a} className="font-mono text-xs">{a}</div>)}</div>
            : '—'
          }
        />
      </div>

      {/* Metrics */}
      <div className="px-6 pb-6 space-y-5 flex-1">

        {/* Header row: title + time range + Live button */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-700">Interface metrics</h2>

          <div className="flex items-center gap-2">
            {/* Historical time range — disabled in live mode */}
            <div className={`flex rounded-lg overflow-hidden border border-slate-200 bg-white transition-opacity ${liveMode ? 'opacity-40 pointer-events-none' : ''}`}>
              {RANGES.map(r => (
                <button
                  key={r.hours}
                  onClick={() => setHours(r.hours)}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    hours === r.hours ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                  } ${r.hours !== 1 ? 'border-l border-slate-200' : ''}`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-slate-200" />

            {/* Live button */}
            {!liveMode ? (
              <button
                onClick={startLive}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                Live
              </button>
            ) : (
              <div className="flex items-center gap-2">
                {/* Live status badge */}
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${
                  liveStatus === 'live'       ? 'bg-red-50 text-red-600 border border-red-200' :
                  liveStatus === 'connecting' ? 'bg-amber-50 text-amber-600 border border-amber-200' :
                  liveStatus === 'error'      ? 'bg-slate-100 text-slate-500 border border-slate-200' : ''
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    liveStatus === 'live'       ? 'bg-red-500 animate-pulse' :
                    liveStatus === 'connecting' ? 'bg-amber-500 animate-pulse' :
                    'bg-slate-400'
                  }`} />
                  {liveStatus === 'connecting' ? 'Connecting…' :
                   liveStatus === 'live'       ? 'LIVE' :
                   liveStatus === 'error'      ? 'Error' : 'Live'}
                </div>
                <button
                  onClick={stopLive}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-500 hover:border-slate-400 transition-colors"
                >
                  Stop
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Error message */}
        {liveStatus === 'error' && liveError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 flex items-center justify-between">
            <span>Live poll failed: {liveError}</span>
            <button onClick={startLive} className="ml-4 text-red-600 font-semibold hover:underline shrink-0">Retry</button>
          </div>
        )}

        {/* ── Bandwidth chart ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Bandwidth</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {liveMode
                  ? `Live SNMP — 3 min rolling window · ${livePoints.filter(p => p.in_bps != null).length} samples`
                  : hours <= 1
                    ? `15 s resolution · last ${RANGES.find(r => r.hours === hours)?.label}`
                    : `Traffic rate · last ${RANGES.find(r => r.hours === hours)?.label}`
                }
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-cyan-500 inline-block" />In</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-amber-400 inline-block" />Out</span>
            </div>
          </div>

          <div className="px-4 pt-3 pb-1">
            {liveMode ? (
              liveInSeries.length < 2 && liveOutSeries.length < 2 ? (
                <div className="flex items-center justify-center h-44 gap-2 text-slate-300 text-sm">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  Waiting for first sample…
                </div>
              ) : (
                <TimeSeriesChart
                  height={180}
                  yFmt={fmtBpsShort}
                  live
                  series={[
                    { name: 'In',  color: '#0891b2', data: liveInSeries  },
                    { name: 'Out', color: '#f59e0b', data: liveOutSeries },
                  ]}
                />
              )
            ) : metricsLoading ? (
              <div className="flex items-center justify-center h-44 text-slate-300 text-sm">Loading…</div>
            ) : (
              <TimeSeriesChart
                height={180}
                yFmt={fmtBpsShort}
                series={[
                  { name: 'In',  color: '#0891b2', data: (metrics?.in_bps  ?? []) as [number, number][] },
                  { name: 'Out', color: '#f59e0b', data: (metrics?.out_bps ?? []) as [number, number][] },
                ]}
              />
            )}
          </div>

          {/* Stats row */}
          <div className={`grid divide-x divide-slate-100 border-t border-slate-100 ${
            liveMode ? 'grid-cols-2 sm:grid-cols-4' :
            operUp   ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6' :
                       'grid-cols-2 sm:grid-cols-4'
          }`}>
            {liveMode ? (
              <>
                <LiveTile label="In"      value={liveInBps  != null ? fmtBps(liveInBps)  : null} color="#0891b2"
                  sub={liveInPct != null ? `${liveInPct.toFixed(2)}% util` : undefined} />
                <LiveTile label="Out"     value={liveOutBps != null ? fmtBps(liveOutBps) : null} color="#f59e0b"
                  sub={liveOutPct != null ? `${liveOutPct.toFixed(2)}% util` : undefined} />
                <LiveTile label="PPS in"  value={liveInPps  != null ? fmtPps(liveInPps)  : null} color="#0891b2" />
                <LiveTile label="PPS out" value={liveOutPps != null ? fmtPps(liveOutPps) : null} color="#f59e0b" />
              </>
            ) : operUp ? (
              /* UP: current traffic (with util bars) + period avg + period peak */
              <>
                {[
                  { label: 'In',       val: inLast,     pct: inPct,      color: '#0891b2', showUtil: true  },
                  { label: 'Out',      val: outLast,    pct: outPct,     color: '#f59e0b', showUtil: true  },
                  { label: 'Avg In',   val: avgInBps,   pct: null,       color: '#0891b2', showUtil: false },
                  { label: 'Avg Out',  val: avgOutBps,  pct: null,       color: '#f59e0b', showUtil: false },
                  { label: 'Peak In',  val: peakInBps,  pct: peakInPct,  color: '#0891b2', showUtil: false },
                  { label: 'Peak Out', val: peakOutBps, pct: peakOutPct, color: '#f59e0b', showUtil: false },
                ].map(({ label, val, pct, color, showUtil }) => (
                  <div key={label} className="px-5 py-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
                    </div>
                    <div className="text-lg font-bold text-slate-800">
                      {val != null ? fmtBps(val) : <span className="text-slate-300 text-sm">No data</span>}
                    </div>
                    {showUtil && pct != null && (
                      <div className="mt-1.5">
                        <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                          <span>Utilisation</span><span>{pct.toFixed(2)}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: utilColor(pct) }} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </>
            ) : (
              /* DOWN: show avg and peak from historical data — current is always 0 */
              <>
                {[
                  { label: 'Avg In',   val: avgInBps,   pct: null,       color: '#0891b2' },
                  { label: 'Avg Out',  val: avgOutBps,  pct: null,       color: '#f59e0b' },
                  { label: 'Peak In',  val: peakInBps,  pct: peakInPct,  color: '#0891b2' },
                  { label: 'Peak Out', val: peakOutBps, pct: peakOutPct, color: '#f59e0b' },
                ].map(({ label, val, pct, color }) => (
                  <div key={label} className="px-5 py-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
                    </div>
                    <div className="text-lg font-bold text-slate-800">
                      {val != null ? fmtBps(val) : <span className="text-slate-300 text-sm">No data</span>}
                    </div>
                    {pct != null && (
                      <div className="mt-1.5">
                        <div className="flex justify-between text-[10px] text-slate-400 mb-0.5">
                          <span>Util</span><span>{pct.toFixed(1)}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: utilColor(pct) }} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Live utilisation bars */}
          {liveMode && (liveInPct != null || liveOutPct != null) && (
            <div className="px-5 pb-3 space-y-1.5">
              {[
                { label: 'In',  pct: liveInPct,  color: '#0891b2' },
                { label: 'Out', pct: liveOutPct, color: '#f59e0b' },
              ].filter(x => x.pct != null).map(({ label, pct, color: _c2 }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400 w-6 shrink-0">{label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${Math.min(pct!, 100)}%`, backgroundColor: utilColor(pct!) }} />
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0 w-12 text-right">
                    {pct!.toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Errors & Discards ────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Errors & Discards</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {liveMode ? 'Live SNMP error rates' : `Rate per second over the last ${RANGES.find(r => r.hours === hours)?.label}`}
              </p>
            </div>
            {!liveMode && (
              <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap justify-end">
                {[
                  { label: 'In errors',    color: '#dc2626' },
                  { label: 'Out errors',   color: '#f97316' },
                  { label: 'In discards',  color: '#7c3aed' },
                  { label: 'Out discards', color: '#0891b2' },
                ].map(({ label, color }) => (
                  <span key={label} className="flex items-center gap-1.5">
                    <span className="w-3 h-0.5 rounded inline-block" style={{ backgroundColor: color }} />
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {liveMode ? (
            /* Live error stats */
            <div className="grid grid-cols-2 divide-x divide-slate-100">
              <LiveTile label="In errors/s"  value={liveInErrPs  != null ? liveInErrPs.toFixed(2)  : null} color="#dc2626" />
              <LiveTile label="Out errors/s" value={liveOutErrPs != null ? liveOutErrPs.toFixed(2) : null} color="#f97316" />
            </div>
          ) : (
            <>
              <div className="px-4 pt-3 pb-1">
                {metricsLoading ? (
                  <div className="flex items-center justify-center h-32 text-slate-300 text-sm">Loading…</div>
                ) : (
                  <TimeSeriesChart
                    height={140}
                    yFmt={fmtRateShort}
                    empty="No errors or discards recorded"
                    series={[
                      { name: 'In errors',    color: '#dc2626', data: (metrics?.in_errors    ?? []) as [number, number][] },
                      { name: 'Out errors',   color: '#f97316', data: (metrics?.out_errors   ?? []) as [number, number][] },
                      { name: 'In discards',  color: '#7c3aed', data: (metrics?.in_discards  ?? []) as [number, number][] },
                      { name: 'Out discards', color: '#0891b2', data: (metrics?.out_discards ?? []) as [number, number][] },
                    ]}
                  />
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-100 border-t border-slate-100 text-center">
                {[
                  { label: 'In errors',    val: inErrLast,   color: '#dc2626' },
                  { label: 'Out errors',   val: outErrLast,  color: '#f97316' },
                  { label: 'In discards',  val: inDiscLast,  color: '#7c3aed' },
                  { label: 'Out discards', val: outDiscLast, color: '#0891b2' },
                ].map(({ label, val, color: errorColor }) => (
                  <div key={label} className="px-3 py-2.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide mb-1" style={{ color: errorColor }}>{label}</div>
                    <div className={`text-sm font-bold ${val ? 'text-slate-800' : 'text-slate-300'}`}>
                      {val != null ? (val === 0 ? '0' : fmtRateShort(val)) : '—'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Flow section ─────────────────────────────────────────────── */}
        {deviceId && iface?.if_index != null && (
          <InterfaceFlowSection deviceId={deviceId} ifIndex={iface.if_index} />
        )}

      </div>
    </div>
  )
}

// ── Interface flow section ────────────────────────────────────────────────────

const FLOW_PROTO_COLOR: Record<string, string> = {
  TCP: '#3b82f6', UDP: '#f59e0b', ICMP: '#10b981', OSPF: '#8b5cf6', GRE: '#ec4899',
}
function flowProtoColor(name: string) { return FLOW_PROTO_COLOR[name] ?? '#94a3b8' }

function fmtFlowBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

function InterfaceFlowSection({ deviceId, ifIndex }: { deviceId: string; ifIndex: number }) {
  const [flowHours, setFlowHours] = useState(1)
  const minutes = flowHours * 60

  const { data: tsData = [], isLoading: tsLoading } = useQuery({
    queryKey:        ['iface-flow-ts', deviceId, ifIndex, minutes],
    queryFn:         () => fetchInterfaceFlowTimeseries(deviceId, ifIndex, minutes),
    refetchInterval: 60_000,
  })

  const { data: talkers = [], isLoading: talkersLoading } = useQuery({
    queryKey:        ['iface-flow-talkers', deviceId, ifIndex, minutes],
    queryFn:         () => fetchInterfaceTopTalkers(deviceId, ifIndex, minutes, 10),
    refetchInterval: 60_000,
  })

  const hasData = tsData.length > 0 || talkers.length > 0

  const inSeries:  [number, number][] = tsData.map(p => [p.ts_ms, p.bytes_in  / 60])
  const outSeries: [number, number][] = tsData.map(p => [p.ts_ms, p.bytes_out / 60])
  const maxTalkerBytes = Math.max(...talkers.map(t => t.bytes_total), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Flow data</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">From NetFlow / sFlow exports</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Time range pills */}
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {([1, 6, 24] as const).map(h => (
              <button key={h} onClick={() => setFlowHours(h)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  flowHours === h ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
                } ${h !== 1 ? 'border-l border-slate-200' : ''}`}>
                {h === 1 ? '1h' : h === 6 ? '6h' : '24h'}
              </button>
            ))}
          </div>
          <Link to="/flow" className="text-xs text-blue-600 hover:underline">Flow explorer →</Link>
        </div>
      </div>

      {tsLoading && talkersLoading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-400">Loading flow data…</div>
      ) : !hasData ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-slate-400">No flow data for this interface</p>
          <p className="text-xs text-slate-300 mt-1">Configure NetFlow/sFlow export on this device targeting port 2055</p>
        </div>
      ) : (
        <div>
          {/* Traffic chart */}
          {inSeries.length >= 2 && (
            <div className="px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-4 mb-2 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-indigo-500 inline-block"/>In (flow)</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-amber-400 inline-block"/>Out (flow)</span>
              </div>
              <TimeSeriesChart
                height={120}
                yFmt={(v: number) => fmtFlowBytes(v) + '/s'}
                series={[
                  { name: 'In',  color: '#6366f1', data: inSeries  },
                  { name: 'Out', color: '#f59e0b', data: outSeries },
                ]}
              />
            </div>
          )}

          {/* Top talkers */}
          {talkers.length > 0 && (
            <div className="px-5 py-4">
              <p className="text-xs font-semibold text-slate-500 mb-3">Top talkers through this interface</p>
              <div className="space-y-2">
                {talkers.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-600 w-28 shrink-0 truncate">{t.src_ip}</span>
                    <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14m-4-4 4 4-4 4"/></svg>
                    <span className="font-mono text-[11px] text-slate-600 w-28 shrink-0 truncate">{t.dst_ip}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
                      style={{ backgroundColor: `${flowProtoColor(t.protocol_name)}18`, color: flowProtoColor(t.protocol_name) }}>
                      {t.protocol_name}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${(t.bytes_total / maxTalkerBytes) * 100}%`, backgroundColor: flowProtoColor(t.protocol_name) }} />
                    </div>
                    <span className="text-xs font-bold text-slate-600 tabular-nums w-16 text-right shrink-0">{fmtFlowBytes(t.bytes_total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
