import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchOverview } from '../../api/overview'
import { Icons } from './icons'
import { AlertTrendSparkline } from './sparklines'
import { formatAge } from './shared'

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accentColor, icon, to, footer }: {
  label: string; value: number | string; sub?: string; accentColor: string
  icon: ReactNode; to?: string; footer?: ReactNode
}) {
  const inner = (
    <div className={`relative bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col h-full transition-all duration-150 ${to ? 'hover:shadow-md hover:-translate-y-px cursor-pointer' : ''}`}>
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl" style={{ backgroundColor: accentColor }} />
      <div className="pl-5 pr-4 pt-4 pb-3 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}18` }}>
            <span style={{ color: accentColor }}>{icon}</span>
          </div>
          {sub && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accentColor}15`, color: accentColor }}>{sub}</span>}
        </div>
        <div className="flex-1">
          <div className="text-2xl md:text-3xl font-bold text-slate-800 tabular-nums leading-none">{value}</div>
          <p className="text-xs text-slate-400 mt-1 font-medium">{label}</p>
        </div>
        {footer && <div className="border-t border-slate-100 pt-2.5">{footer}</div>}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block h-full">{inner}</Link> : inner
}

// ── Stat cards row ────────────────────────────────────────────────────────────

export function StatCardsRow() {
  const { data } = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000, staleTime: 25_000 })
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>

  const pollPct = data.poll_health.total_active > 0
    ? Math.round((data.poll_health.polled_recently / data.poll_health.total_active) * 100)
    : 100

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4">
      <StatCard label="Total devices" value={data.devices.total}
        sub={data.last_polled_at ? `polled ${formatAge(data.last_polled_at)}` : undefined}
        accentColor="#6366f1" to="/devices" icon={<Icons.Servers />}
        footer={
          <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
            {([
              { v: data.devices.up,         c: '#16a34a' },
              { v: data.devices.unreachable, c: '#f97316' },
              { v: data.devices.down,        c: '#dc2626' },
              { v: data.devices.unknown,     c: '#e2e8f0' },
            ] as const).filter(s => s.v > 0).map((s, i) => (
              <div key={i} style={{ width: `${(s.v / data.devices.total) * 100}%`, backgroundColor: s.c }} />
            ))}
          </div>
        }
      />
      <StatCard label="Devices down" value={data.devices.down + data.devices.unreachable}
        sub={data.devices.unreachable > 0 ? `${data.devices.unreachable} unreachable` : undefined}
        accentColor={data.devices.down + data.devices.unreachable > 0 ? '#dc2626' : '#94a3b8'}
        to="/devices?status=down" icon={<Icons.XCircle />}
      />
      <StatCard label="Interfaces down" value={data.interfaces_down}
        accentColor={data.interfaces_down > 0 ? '#f97316' : '#94a3b8'}
        icon={<Icons.LinkIcon />}
      />
      <StatCard label="Open alerts" value={data.alerts.open}
        sub={data.alerts.critical > 0 ? `${data.alerts.critical} critical` : data.alerts.major > 0 ? `${data.alerts.major} major` : undefined}
        accentColor={data.alerts.critical > 0 ? '#dc2626' : data.alerts.open > 0 ? '#f97316' : '#16a34a'}
        to="/alerts" icon={<Icons.Bell />}
        footer={
          data.alert_trend.length >= 2 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-slate-400">24h trend</span>
              <AlertTrendSparkline series={data.alert_trend} w={120} h={20} />
            </div>
          ) : undefined
        }
      />
      <StatCard label="Poll health" value={`${pollPct ?? 0}%`}
        sub={`${data.poll_health.polled_recently}/${data.poll_health.total_active} devices`}
        accentColor={(pollPct ?? 0) >= 90 ? '#16a34a' : (pollPct ?? 0) >= 60 ? '#d97706' : '#dc2626'}
        icon={<Icons.Signal />}
        footer={
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full transition-all"
              style={{
                width: `${pollPct ?? 0}%`,
                backgroundColor: (pollPct ?? 0) >= 90 ? '#16a34a' : (pollPct ?? 0) >= 60 ? '#d97706' : '#dc2626',
              }}
            />
          </div>
        }
      />
    </div>
  )
}
