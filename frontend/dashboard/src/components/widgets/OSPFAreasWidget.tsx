import { useQuery } from '@tanstack/react-query'
import { fetchOSPFAreas } from '../../api/bgp'

// ── OSPF area breakdown ───────────────────────────────────────────────────────

export function OSPFAreasWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['ospf-areas'],
    queryFn:         fetchOSPFAreas,
    refetchInterval: 60_000,
    staleTime:       30_000,
  })

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">OSPF areas</h3>
      {isLoading ? <p className="text-xs text-slate-400">Loading…</p>
        : data.length === 0 ? <p className="text-xs text-slate-400">No OSPF neighbors</p>
        : (
          <div className="space-y-2.5">
            {data.map((a, i) => {
              const pct = a.total > 0 ? Math.round((a.full / a.total) * 100) : 0
              return (
                <div key={i}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div>
                      <span className="font-semibold text-slate-700">Area {a.area}</span>
                      {a.vrf !== 'default' && <span className="ml-1.5 text-[10px] text-slate-400 font-mono">{a.vrf}</span>}
                    </div>
                    <span className={`font-semibold tabular-nums ${a.not_full > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                      {a.full}/{a.total} full
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: a.not_full > 0 ? '#f59e0b' : '#16a34a' }} />
                  </div>
                  {a.not_full > 0 && (
                    <p className="text-[10px] text-amber-600 mt-0.5">{a.not_full} neighbor{a.not_full !== 1 ? 's' : ''} not full</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
