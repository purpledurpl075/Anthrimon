import { useWidgetData } from './shared'

// 4. Routing health (BGP + OSPF combined)
export function RoutingHealthWidget() {
  const { data } = useWidgetData()
  if (!data) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>
  const r = data.routing_health
  if (!r?.bgp || !r?.ospf) return <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">No routing protocols</div>
  const bgpDown  = r.bgp.total  - r.bgp.established
  const ospfDown = r.ospf.total - r.ospf.full
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">Routing protocols</h3>
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'BGP sessions', total: r.bgp.total, ok: r.bgp.established, bad: bgpDown, okLabel: 'Established', badLabel: 'Down', okColor: '#16a34a', badColor: '#dc2626' },
          { label: 'OSPF neighbors', total: r.ospf.total, ok: r.ospf.full, bad: ospfDown, okLabel: 'Full', badLabel: 'Not full', okColor: '#16a34a', badColor: '#f59e0b' },
        ].map(p => (
          <div key={p.label} className={`rounded-xl p-3 ${p.bad > 0 ? 'bg-red-50 border border-red-100' : 'bg-green-50 border border-green-100'}`}>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">{p.label}</p>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold" style={{ color: p.bad > 0 ? '#dc2626' : '#16a34a' }}>{p.ok}</span>
              <span className="text-xs text-slate-400 pb-0.5">/ {p.total}</span>
            </div>
            {p.bad > 0 && <p className="text-[10px] text-red-600 mt-1 font-medium">{p.bad} {p.badLabel.toLowerCase()}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
