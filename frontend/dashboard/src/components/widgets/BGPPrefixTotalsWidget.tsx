import { useQuery } from '@tanstack/react-query'
import { fetchBGPPrefixTotals } from '../../api/bgp'

// ── BGP prefix totals ─────────────────────────────────────────────────────────

export function BGPPrefixTotalsWidget() {
  const { data, isLoading } = useQuery({
    queryKey:        ['bgp-prefix-totals'],
    queryFn:         fetchBGPPrefixTotals,
    refetchInterval: 60_000,
    staleTime:       30_000,
  })

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">BGP prefix totals</h3>
      {isLoading ? <p className="text-xs text-slate-400">Loading…</p> : !data ? null : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-indigo-50 border border-indigo-100 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-indigo-700 tabular-nums">{data.total_rx.toLocaleString()}</p>
              <p className="text-[10px] text-indigo-400 mt-0.5">Prefixes received</p>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-slate-700 tabular-nums">
                {data.total_tx > 0 ? data.total_tx.toLocaleString() : '—'}
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">Prefixes advertised</p>
            </div>
          </div>
          {data.top_receivers.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Top receivers</p>
              <div className="space-y-1.5">
                {data.top_receivers.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500 truncate flex-1">{r.device}</span>
                    <span className="font-mono text-slate-400 text-[10px]">{r.peer_ip}</span>
                    <span className="font-bold tabular-nums text-indigo-600 w-12 text-right">{r.prefixes_rx?.toLocaleString()}</span>
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
