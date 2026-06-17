import { useQuery } from '@tanstack/react-query'
import { fetchOverview } from '../../api/overview'

// 8. Alert timeline (hourly trend from overview data)
export function AlertTimelineWidget() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  const series = data?.alert_trend ?? []
  const max = Math.max(...series.map(p => p[1]), 1)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-1">Alert timeline</h3>
      <p className="text-[10px] text-slate-400 mb-4">Alerts triggered per hour — last 24 h</p>
      {series.length < 2 ? (
        <p className="text-xs text-slate-400">Not enough data yet</p>
      ) : (
        <div className="flex items-end gap-0.5 h-16">
          {series.map(([ts, n], i) => (
            <div key={i} className="flex-1 rounded-t" title={`${new Date(ts).toLocaleTimeString()}: ${n} alerts`}
              style={{ height: `${Math.max(2, (n / max) * 100)}%`, backgroundColor: n === 0 ? '#e2e8f0' : n > max * 0.8 ? '#dc2626' : '#f59e0b' }} />
          ))}
        </div>
      )}
    </div>
  )
}
