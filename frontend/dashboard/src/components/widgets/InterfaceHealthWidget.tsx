import type { ReactNode } from 'react'
import { useWidgetData } from './shared'

// 1. Interface health ring
export function InterfaceHealthWidget() {
  const { data } = useWidgetData()
  const d = data?.interface_health
  if (!d) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>
  const total = d.total || 1
  const segments = [
    { label: 'Up',         value: d.up,         color: '#16a34a' },
    { label: 'Down',       value: d.down,        color: '#dc2626' },
    { label: 'Admin down', value: d.admin_down,  color: '#94a3b8' },
  ]
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">Interface health</h3>
      <div className="flex items-center gap-6">
        <svg viewBox="0 0 80 80" className="w-20 h-20 shrink-0 -rotate-90">
          {segments.reduce((acc, seg, i) => {
            const pct = seg.value / total
            const prev = acc.offset
            const dash = pct * 251.2
            acc.offset += pct
            acc.els.push(
              <circle key={i} cx="40" cy="40" r="32" fill="none" stroke={seg.color}
                strokeWidth="14" strokeDasharray={`${dash} ${251.2 - dash}`}
                strokeDashoffset={-prev * 251.2} />
            )
            return acc
          }, { offset: 0, els: [] as ReactNode[] }).els}
          <circle cx="40" cy="40" r="25" fill="white" />
        </svg>
        <div className="space-y-2 flex-1">
          {segments.map(s => (
            <div key={s.label} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
              <span className="font-semibold tabular-nums" style={{ color: s.color }}>{s.value}</span>
            </div>
          ))}
          <div className="pt-1 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
            <span>Total</span><span className="font-semibold text-slate-700">{d.total}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
