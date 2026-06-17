import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../../api/overview'
import StatusBadge from '../StatusBadge'
import VendorBadge from '../VendorBadge'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR } from '../DeviceTypeIcon'
import { Icons } from './icons'
import { formatAge } from './shared'

// ── Problem devices panel ─────────────────────────────────────────────────────

export function ProblemDevices() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>

  const devices = data.problem_devices
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold text-slate-800">Problem devices</h2>
        <Link to="/devices" className="text-xs text-blue-600 hover:underline flex items-center gap-1">All <Icons.ChevronRight /></Link>
      </div>
      {devices.length === 0 ? (
        <div className="px-5 py-8 text-center flex-1 flex flex-col items-center justify-center">
          <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 mb-2">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </div>
          <p className="text-sm text-slate-400">All devices reachable</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-50">
          {devices.map(d => (
            <li key={d.id}>
              <Link to={`/devices/${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
                <span style={{ color: DEVICE_TYPE_COLOR[d.device_type] ?? '#475569' }} className="shrink-0"><DeviceTypeIcon type={d.device_type} size={15} /></span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">{d.hostname}</span>
                    <VendorBadge vendor={d.vendor} />
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{d.mgmt_ip}</span>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <StatusBadge status={d.status} />
                  <span className="text-xs text-slate-400">{formatAge(d.last_seen)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
