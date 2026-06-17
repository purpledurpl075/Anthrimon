import { useWidgetData } from './shared'

// 5. Config changes (last 24h)
export function ConfigChangesWidget() {
  const { data } = useWidgetData()
  const changes = data?.config_changes ?? []
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <h3 className="text-sm font-semibold text-slate-800">Config changes</h3>
        <span className="text-[10px] text-slate-400">last 24 h</span>
      </div>
      {changes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-400">No changes in last 24h</div>
      ) : (
        <div className="overflow-y-auto flex-1 divide-y divide-slate-50">
          {changes.map(c => (
            <div key={`${c.device_id}-${c.collected_at}`} className="flex items-center gap-3 px-5 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-700 truncate">{c.hostname}</p>
                <p className="text-[10px] text-slate-400">{new Date(c.collected_at).toLocaleTimeString()}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {c.lines_added > 0 && <span className="text-[10px] font-semibold text-green-600 bg-green-50 px-1.5 py-0.5 rounded">+{c.lines_added}</span>}
                {c.lines_removed > 0 && <span className="text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">−{c.lines_removed}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
