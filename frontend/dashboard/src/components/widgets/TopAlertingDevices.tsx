import { Link } from 'react-router-dom'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR } from '../DeviceTypeIcon'
import { useOverviewData, WidgetStatus } from './shared'

// ── Top alerting devices ───────────────────────────────────────────────────────

export function TopAlertingDevices() {
  const { data, isLoading, isError, error } = useOverviewData()
  if (!data) return <WidgetStatus isLoading={isLoading} isError={isError} error={error} />

  const devices = data.top_alerting_devices
  const maxCount = devices[0]?.count ?? 1
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">Top alerting devices</h2>
        <Link to="/alerts" className="text-xs text-blue-600 hover:underline">View all</Link>
      </div>
      {devices.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-4">No open alerts</p>
      ) : (
        <div className="space-y-2.5">
          {devices.map(d => (
            <Link key={d.device_id} to={`/devices/${d.device_id}`} className="flex items-center gap-3 group">
              <span className="shrink-0" style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }}><DeviceTypeIcon type={d.device_type} size={14} /></span>
              <span className="w-32 text-xs font-medium text-slate-700 truncate group-hover:text-blue-600 transition-colors shrink-0">{d.hostname}</span>
              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-red-500 transition-all" style={{ width: `${(d.count / maxCount) * 100}%` }} />
              </div>
              <span className="text-xs font-bold text-slate-700 tabular-nums shrink-0 w-6 text-right">{d.count}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
