import { useQuery } from '@tanstack/react-query'
import { fetchTopResources } from '../../api/overview'

// 2. Top CPU devices
export function TopCpuWidget() {
  const { data, isLoading } = useQuery({ queryKey: ['top-resources'], queryFn: () => fetchTopResources(5), refetchInterval: 60_000, staleTime: 30_000 })
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">Top CPU</h3>
      {isLoading ? <p className="text-xs text-slate-400">Loading…</p> : !data?.cpu.length ? <p className="text-xs text-slate-400">No CPU data</p> : (
        <div className="space-y-2.5">
          {data.cpu.map(d => (
            <div key={d.device_id}>
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className="text-slate-700 font-medium truncate">{d.hostname}</span>
                <span className={`font-bold tabular-nums ${d.cpu_pct >= 90 ? 'text-red-600' : d.cpu_pct >= 70 ? 'text-amber-600' : 'text-slate-600'}`}>{d.cpu_pct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${d.cpu_pct}%`, backgroundColor: d.cpu_pct >= 90 ? '#dc2626' : d.cpu_pct >= 70 ? '#f59e0b' : '#3b82f6' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
