import { useQuery } from '@tanstack/react-query'
import { fetchBGPFlapLog } from '../../api/bgp'
import { BGP_STATE_COLOR } from './shared'

// ── BGP flap log ──────────────────────────────────────────────────────────────

export function BGPFlapLogWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey:        ['bgp-flap-log'],
    queryFn:         () => fetchBGPFlapLog(15),
    refetchInterval: 30_000,
    staleTime:       20_000,
  })

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 shrink-0">
        <h3 className="text-sm font-semibold text-slate-800">BGP state transitions</h3>
        <p className="text-[10px] text-slate-400 mt-0.5">Recent changes observed during polling</p>
      </div>
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-400">Loading…</div>
      ) : data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-green-600 font-medium">✓ No transitions recorded</p>
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 divide-y divide-slate-50">
          {data.map((e, i) => (
            <div key={i} className="px-4 py-2.5 hover:bg-slate-50">
              <div className="flex items-center gap-2 text-xs">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-700 truncate">{e.device}</p>
                  <p className="font-mono text-[10px] text-slate-400">{e.peer_ip}{e.peer_asn ? ` · AS${e.peer_asn}` : ''}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-semibold capitalize px-1.5 py-0.5 rounded"
                    style={{ color: BGP_STATE_COLOR[e.prev_state], backgroundColor: `${BGP_STATE_COLOR[e.prev_state]}18` }}>
                    {e.prev_state}
                  </span>
                  <span className="text-slate-300">→</span>
                  <span className="text-[10px] font-semibold capitalize px-1.5 py-0.5 rounded"
                    style={{ color: BGP_STATE_COLOR[e.new_state], backgroundColor: `${BGP_STATE_COLOR[e.new_state]}18` }}>
                    {e.new_state}
                  </span>
                </div>
              </div>
              <p className="text-[9px] text-slate-300 mt-0.5">{new Date(e.recorded_at).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
