import { useQuery } from '@tanstack/react-query'
import { fetchSyslogHeatmap } from '../../api/overview'

// ── Syslog heatmap ────────────────────────────────────────────────────────────

export function SyslogHeatmapWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['syslog-heatmap'],
    queryFn:         fetchSyslogHeatmap,
    refetchInterval: 300_000,
    staleTime:       120_000,
  })

  const cellMap: Record<string, number> = {}
  let maxCount = 0
  for (const c of data) {
    const key = `${c.dow}-${c.hr}`
    cellMap[key] = c.count
    if (c.count > maxCount) maxCount = c.count
  }

  const days   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const hours  = Array.from({ length: 24 }, (_, i) => i)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-1">Syslog heatmap</h3>
      <p className="text-[10px] text-slate-400 mb-4">Messages per hour — last 7 days</p>
      {isLoading ? <p className="text-xs text-slate-400">Loading…</p> : (
        <div className="overflow-x-auto">
          <div className="flex gap-0.5 min-w-max">
            {/* Day labels */}
            <div className="flex flex-col gap-0.5 mr-1">
              <div className="w-7 h-3" /> {/* spacer for hour labels */}
              {days.map(d => (
                <div key={d} className="w-7 h-3 flex items-center justify-end">
                  <span className="text-[8px] text-slate-400">{d}</span>
                </div>
              ))}
            </div>
            {/* Hour columns */}
            {hours.map(hr => (
              <div key={hr} className="flex flex-col gap-0.5">
                <div className="w-3 h-3 flex items-center justify-center">
                  {hr % 6 === 0 && <span className="text-[8px] text-slate-400">{hr}</span>}
                </div>
                {days.map((_, dow) => {
                  const count = cellMap[`${dow}-${hr}`] ?? 0
                  const intensity = maxCount > 0 ? count / maxCount : 0
                  const alpha = intensity < 0.05 ? 0 : 0.1 + intensity * 0.9
                  return (
                    <div
                      key={dow}
                      className="w-3 h-3 rounded-sm"
                      title={`${days[dow]} ${hr}:00 — ${count} messages`}
                      style={{ backgroundColor: count === 0 ? '#f1f5f9' : `rgba(220,38,38,${alpha.toFixed(2)})` }}
                    />
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[9px] text-slate-400">Low</span>
            {[0.1, 0.3, 0.5, 0.7, 0.9, 1].map(v => (
              <div key={v} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `rgba(220,38,38,${v})` }} />
            ))}
            <span className="text-[9px] text-slate-400">High</span>
          </div>
        </div>
      )}
    </div>
  )
}
