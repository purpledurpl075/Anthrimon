import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../../api/overview'
import { Icons } from './icons'
import { SEV_BG, formatAge } from './shared'

// ── Recently resolved ─────────────────────────────────────────────────────────

export function RecentlyResolved() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>

  const alerts = data.recently_resolved
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-green-600"><Icons.CheckCircle /></span>
          <h2 className="text-sm font-semibold text-slate-800">Recently resolved</h2>
          <span className="text-[10px] text-slate-400 font-medium">last hour</span>
        </div>
        <Link to="/alerts?status=resolved" className="text-xs text-blue-600 hover:underline flex items-center gap-1">All resolved <Icons.ChevronRight /></Link>
      </div>
      {alerts.length === 0 ? (
        <div className="px-5 py-6 text-center text-sm text-slate-400">No alerts resolved in the last hour</div>
      ) : (
        <div className="divide-y divide-slate-50">
          {alerts.map(a => (
            <Link key={a.id} to={`/alerts/${a.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50 transition-colors group">
              <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium shrink-0 ${SEV_BG[a.severity] ?? SEV_BG.info}`}>{a.severity}</span>
              <p className="flex-1 text-sm text-slate-600 truncate group-hover:text-blue-600 transition-colors">{a.title}</p>
              <span className="text-xs text-slate-400 shrink-0">{formatAge(a.resolved_at)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
