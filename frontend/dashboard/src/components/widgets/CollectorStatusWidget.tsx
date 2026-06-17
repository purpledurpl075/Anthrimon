import { useWidgetData } from './shared'

// 6. Collector status
export function CollectorStatusWidget() {
  const { data } = useWidgetData()
  const collectors = data?.collector_status ?? []
  const DOT: Record<string, string> = { online: '#16a34a', offline: '#dc2626', pending: '#f59e0b' }
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">Collector status</h3>
      {collectors.length === 0 ? (
        <p className="text-xs text-slate-400">No remote collectors</p>
      ) : (
        <div className="space-y-2">
          {collectors.map(c => (
            <div key={c.name} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: DOT[c.status] ?? '#94a3b8' }} />
              <span className="text-xs text-slate-700 flex-1 truncate">{c.name}</span>
              <span className="text-[10px] font-semibold capitalize" style={{ color: DOT[c.status] ?? '#94a3b8' }}>{c.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
