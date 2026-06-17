import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../../api/overview'
import { Icons } from './icons'
import { SEV_BG, formatAge } from './shared'

// ── Open alerts panel ─────────────────────────────────────────────────────────

export function OpenAlerts() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>

  const alerts = data.recent_alerts
  const total = data.alerts.open
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold text-slate-800">Open alerts</h2>
        <Link to="/alerts" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
          {total > 0 ? `${total} total` : 'View all'} <Icons.ChevronRight />
        </Link>
      </div>
      {alerts.length === 0 ? (
        <div className="px-5 py-8 text-center flex-1 flex flex-col items-center justify-center">
          <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <p className="text-sm text-slate-400">No open alerts</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-50">
          {alerts.map(a => (
            <li key={a.id}>
              <Link to={`/alerts/${a.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors group">
                <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium shrink-0 ${SEV_BG[a.severity] ?? SEV_BG.info}`}>{a.severity}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 truncate group-hover:text-blue-600 transition-colors">{a.title}</p>
                  <p className="text-xs text-slate-400">{formatAge(a.triggered_at)}</p>
                </div>
                <span className="text-slate-300 group-hover:text-blue-400 shrink-0 transition-colors"><Icons.ChevronRight /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
