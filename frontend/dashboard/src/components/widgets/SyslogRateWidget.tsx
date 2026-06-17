import { useQuery } from '@tanstack/react-query'

// 7. Syslog rate (messages/hr sparkline)
export function SyslogRateWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['syslog-rate'],
    queryFn:  () => import('../../api/client').then(m => m.default.get('/syslog/summary?hours=24').then(r => r.data)),
    refetchInterval: 120_000, staleTime: 60_000,
  })
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-1">Syslog activity</h3>
      <p className="text-[10px] text-slate-400 mb-4">Messages in last 24 h</p>
      {isLoading ? <p className="text-xs text-slate-400">Loading…</p> : !data ? <p className="text-xs text-slate-400">No syslog data</p> : (
        <div className="grid grid-cols-3 gap-2">
          {['critical','error','warning','notice','info','debug'].map(sev => {
            const count = (data as any)?.[sev] ?? 0
            const colors: Record<string, string> = { critical: '#dc2626', error: '#f97316', warning: '#f59e0b', notice: '#6366f1', info: '#06b6d4', debug: '#94a3b8' }
            return count > 0 ? (
              <div key={sev} className="rounded-lg px-2 py-1.5 text-center" style={{ backgroundColor: `${colors[sev]}15` }}>
                <p className="text-lg font-bold tabular-nums" style={{ color: colors[sev] }}>{count > 9999 ? '9k+' : count}</p>
                <p className="text-[9px] font-medium capitalize" style={{ color: colors[sev] }}>{sev}</p>
              </div>
            ) : null
          }).filter(Boolean)}
        </div>
      )}
    </div>
  )
}
