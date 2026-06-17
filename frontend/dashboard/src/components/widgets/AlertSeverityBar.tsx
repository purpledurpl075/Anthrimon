import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../../api/overview'
import { SEV_ORDER, SEV_COLOR } from './shared'

// ── Alert severity bar ─────────────────────────────────────────────────────────

export function AlertSeverityBar() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>

  const bySeverity = data.alerts.by_severity
  const total = data.alerts.open
  const segments = SEV_ORDER.map(s => ({ sev: s, n: bySeverity[s] ?? 0 })).filter(s => s.n > 0)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">Alert severity</h2>
        <span className="text-xs text-slate-400">{total} open</span>
      </div>
      {total === 0 ? (
        <div className="flex flex-col items-center py-4 gap-2">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <p className="text-sm text-slate-400">No open alerts</p>
        </div>
      ) : (
        <>
          <div className="flex h-2.5 rounded-full overflow-hidden gap-px mb-4">
            {segments.map(s => (
              <div key={s.sev} style={{ width: `${(s.n / total) * 100}%`, backgroundColor: SEV_COLOR[s.sev] }} title={`${s.sev}: ${s.n}`} className="transition-all" />
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {SEV_ORDER.map(sev => {
              const n = bySeverity[sev] ?? 0
              return (
                <Link key={sev} to={`/alerts?severity=${sev}`}
                  className={`rounded-xl px-3 py-2.5 flex flex-col gap-0.5 border transition-all hover:scale-[1.02] ${n === 0 ? 'opacity-30 pointer-events-none' : ''}`}
                  style={{ borderColor: `${SEV_COLOR[sev]}30`, backgroundColor: `${SEV_COLOR[sev]}08` }}>
                  <span className="text-xl font-bold tabular-nums" style={{ color: SEV_COLOR[sev] }}>{n}</span>
                  <span className="text-[10px] capitalize text-slate-500">{sev}</span>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
