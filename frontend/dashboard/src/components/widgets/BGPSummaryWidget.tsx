import { useQuery } from '@tanstack/react-query'
import { fetchBGPSummary } from '../../api/bgp'
import { STATE_COLOR } from './shared'

// ── BGP Summary Widget ────────────────────────────────────────────────────────

export function BGPSummaryWidget() {
  const { data, isLoading } = useQuery({
    queryKey:        ['bgp-summary'],
    queryFn:         fetchBGPSummary,
    refetchInterval: 30_000,
    staleTime:       20_000,
  })

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">BGP sessions</h2>
        {data && data.total > 0 && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
            data.down === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}>
            {data.established}/{data.total} established
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : !data || data.total === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No BGP sessions</p>
      ) : (
        <div className="space-y-4">
          {/* State breakdown bar */}
          <div>
            <div className="flex h-2 rounded-full overflow-hidden gap-px">
              {Object.entries(data.by_state)
                .sort(([a], [b]) => (a === 'established' ? -1 : b === 'established' ? 1 : 0))
                .map(([state, count]) => (
                  <div key={state}
                    style={{ width: `${(count / data.total) * 100}%`, backgroundColor: STATE_COLOR[state] ?? '#94a3b8' }}
                    title={`${state}: ${count}`}
                  />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
              {Object.entries(data.by_state).map(([state, count]) => (
                <span key={state} className="flex items-center gap-1 text-[10px] text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATE_COLOR[state] ?? '#94a3b8' }} />
                  <span className="capitalize">{state}</span>
                  <span className="font-semibold text-slate-700">{count}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Top flappers */}
          {data.top_flappers.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Top flappers</p>
              <div className="space-y-1.5">
                {data.top_flappers.map(f => (
                  <div key={f.session_id} className="flex items-center justify-between text-xs">
                    <span className="text-slate-600 truncate">{f.device_name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-slate-500">{f.peer_ip}</span>
                      <span className="font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded text-[10px]">
                        {f.flap_count}×
                      </span>
                    </div>
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
