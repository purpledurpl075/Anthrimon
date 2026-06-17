import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchTopBandwidth } from '../../api/overview'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR } from '../DeviceTypeIcon'
import { Icons } from './icons'
import { MiniSparkline } from './sparklines'
import { fmtBps, utilColor } from './shared'

// ── Top bandwidth ─────────────────────────────────────────────────────────────

const BW_WINDOWS = [
  { label: '5m',  minutes: 5   },
  { label: '30m', minutes: 30  },
  { label: '6h',  minutes: 360 },
] as const

export function TopBandwidthSection() {
  const [tab, setTab]              = useState<'interfaces' | 'devices'>('interfaces')
  const [windowMinutes, setWindow] = useState<5 | 30 | 360>(30)

  const { data, isLoading } = useQuery({
    queryKey:        ['top-bandwidth', windowMinutes],
    queryFn:         () => fetchTopBandwidth(8, windowMinutes),
    staleTime:       25_000,
    refetchInterval: 30_000,
  })

  const maxBps    = Math.max(...(data?.top_interfaces ?? []).map(i => i.current_in_bps + i.current_out_bps), 1)
  const maxDevBps = Math.max(...(data?.top_devices    ?? []).map(d => d.total_bps), 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-800">Top bandwidth</h2>
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {BW_WINDOWS.map(w => (
              <button key={w.minutes} onClick={() => setWindow(w.minutes as 5 | 30 | 360)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${windowMinutes === w.minutes ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'} ${w.minutes !== 5 ? 'border-l border-slate-200' : ''}`}>
                {w.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            {(['interfaces', 'devices'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs font-medium transition-colors capitalize ${tab === t ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'} ${t === 'devices' ? 'border-l border-slate-200' : ''}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      {isLoading ? (
        <div className="px-5 py-8 text-center text-xs text-slate-400">Loading…</div>
      ) : tab === 'interfaces' ? (
        !data?.top_interfaces.length ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">No bandwidth data yet — metrics appear after the first poll cycle.</div>
        ) : (
          <div className="divide-y divide-slate-50">
            {data.top_interfaces.map(iface => {
              const combined = iface.current_in_bps + iface.current_out_bps
              const uc = utilColor(iface.util_pct)
              return (
                <div key={iface.iface_id} className="px-5 py-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[iface.device_type] ?? '#475569' }}>
                      <DeviceTypeIcon type={iface.device_type} size={15} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <Link to={`/devices/${iface.device_id}`} className="text-sm font-semibold text-slate-800 hover:text-blue-600 transition-colors truncate">{iface.device_name}</Link>
                        <span className="text-slate-300 text-xs shrink-0">/</span>
                        <Link to={`/devices/${iface.device_id}/interfaces/${iface.iface_id}`} className="text-xs font-mono text-slate-500 hover:text-blue-600 transition-colors truncate">{iface.iface_name}</Link>
                        {iface.util_pct !== null && <span className="ml-auto text-xs font-bold shrink-0" style={{ color: uc }}>{iface.util_pct.toFixed(1)}%</span>}
                      </div>
                      <div className="mt-1.5 mb-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${(combined / maxBps) * 100}%`, backgroundColor: uc }} />
                      </div>
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="flex items-center gap-1 text-cyan-600 font-medium"><Icons.ArrowDown />{fmtBps(iface.current_in_bps)}</span>
                        <span className="flex items-center gap-1 text-amber-500 font-medium"><Icons.ArrowUp />{fmtBps(iface.current_out_bps)}</span>
                        {iface.speed_bps && <span className="text-slate-300 ml-auto">of {fmtBps(iface.speed_bps)}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 hidden sm:block">
                      <MiniSparkline inSeries={iface.in_series as [number,number][]} outSeries={iface.out_series as [number,number][]} w={96} h={34} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        !data?.top_devices.length ? (
          <div className="px-5 py-8 text-center text-xs text-slate-400">No bandwidth data yet.</div>
        ) : (
          <div className="divide-y divide-slate-50">
            {data.top_devices.map(dev => (
              <Link key={dev.device_id} to={`/devices/${dev.device_id}`}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors group">
                <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[dev.device_type] ?? '#475569' }}><DeviceTypeIcon type={dev.device_type} size={15} /></span>
                <span className="w-40 text-sm font-semibold text-slate-800 truncate group-hover:text-blue-600 transition-colors shrink-0">{dev.device_name}</span>
                <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full bg-cyan-500 transition-all" style={{ width: `${(dev.total_bps / maxDevBps) * 100}%` }} />
                </div>
                <span className="text-sm font-bold text-slate-700 tabular-nums shrink-0 w-24 text-right">{fmtBps(dev.total_bps)}</span>
              </Link>
            ))}
          </div>
        )
      )}
    </div>
  )
}
