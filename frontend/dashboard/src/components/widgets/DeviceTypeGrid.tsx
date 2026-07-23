import { Link } from 'react-router-dom'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../DeviceTypeIcon'
import { useOverviewData, WidgetStatus } from './shared'

// ── Device type breakdown ─────────────────────────────────────────────────────

const TYPE_ORDER = ['router', 'switch', 'firewall', 'access_point', 'wireless_controller', 'load_balancer', 'unknown']

export function DeviceTypeGrid() {
  const { data, isLoading, isError, error } = useOverviewData()
  if (!data) return <WidgetStatus isLoading={isLoading} isError={isError} error={error} />

  const byType = data.devices.by_type
  const entries = [
    ...TYPE_ORDER.filter(t => byType[t] > 0).map(t => ({ type: t, n: byType[t] })),
    ...Object.entries(byType).filter(([t, n]) => n > 0 && !TYPE_ORDER.includes(t)).map(([t, n]) => ({ type: t, n })),
  ]
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h2 className="text-sm font-semibold text-slate-800 mb-4">Device types</h2>
      <div className="grid grid-cols-2 gap-2">
        {entries.map(({ type, n }) => {
          const color = DEVICE_TYPE_COLOR[type] ?? '#475569'
          return (
            <Link key={type} to={`/devices?type=${type}`}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all hover:shadow-sm hover:scale-[1.02]"
              style={{ borderColor: `${color}25`, backgroundColor: `${color}08` }}>
              <span style={{ color }}><DeviceTypeIcon type={type} size={16} /></span>
              <div className="min-w-0">
                <span className="text-lg font-bold text-slate-800 tabular-nums block leading-tight">{n}</span>
                <span className="text-[10px] text-slate-500 capitalize truncate block">{DEVICE_TYPE_LABEL[type] ?? type.replace('_', ' ')}</span>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
