import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchClient } from '../api/clients'

function fmtTime(iso: string) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2)   return 'just now'
  if (mins < 60)  return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

function AbuseBar({ score }: { score: number }) {
  const color = score === 0 ? 'bg-green-500' : score < 25 ? 'bg-yellow-400' : score < 75 ? 'bg-orange-500' : 'bg-red-600'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(score, 2)}%` }} />
      </div>
      <span className="text-xs font-medium text-slate-600 w-8 text-right">{score}</span>
    </div>
  )
}

export default function ClientPage() {
  const { mac } = useParams<{ mac: string }>()
  const navigate = useNavigate()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['client', mac],
    queryFn: () => fetchClient(mac!),
    retry: false,
    enabled: !!mac,
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading client…</div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-500 text-sm mb-3">Client not found in ARP or MAC tables.</p>
          <button onClick={() => navigate(-1)} className="text-blue-600 text-sm hover:underline">Go back</button>
        </div>
      </div>
    )
  }

  const nonPrivateIPs = data.ips.filter(ip => {
    const intel = data.ip_intel[ip.ip]
    return intel && !intel.is_private
  })

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
          <Link to="/addresses" className="hover:text-slate-600">Addresses</Link>
          <span>/</span>
          <span className="text-slate-600 font-mono">{data.mac}</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-base font-semibold text-slate-800 font-mono">{data.mac}</h1>
          {data.vendor && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
              {data.vendor}
            </span>
          )}
          {data.ips.length > 0 && (
            <span className="font-mono text-sm text-slate-500">{data.ips[0].ip}</span>
          )}
        </div>
      </div>

      <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-5 max-w-6xl">

        {/* Left column — presence + IPs */}
        <div className="lg:col-span-2 space-y-5">

          {/* Physical presence */}
          {data.presences.length === 0 && data.ips.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
              <p className="text-xs text-slate-400">No physical port data — device seen via L3 ARP only. MAC table entries may not have reached this host's access port yet.</p>
            </div>
          )}
          {data.presences.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">Seen on</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Device</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Port</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">VLAN</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {data.presences.map((p, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <Link to={`/devices/${p.device_id}`}
                          className="text-blue-600 hover:underline text-xs font-medium">
                          {p.device_name ?? p.device_id}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs font-mono text-slate-600">
                        {p.port
                          ? p.port_iface_id
                            ? <Link to={`/devices/${p.device_id}/interfaces/${p.port_iface_id}`}
                                className="text-blue-600 hover:underline">{p.port}</Link>
                            : p.port
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">
                        {p.vlan_id ?? <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{fmtTime(p.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* IP addresses */}
          {data.ips.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">IP addresses</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">IP</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Device</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Interface</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {data.ips.map((ip, i) => {
                    const intel = data.ip_intel[ip.ip]
                    return (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-xs text-slate-800">{ip.ip}</span>
                          {intel?.country_iso && (
                            <span className="ml-2 text-[10px] text-slate-400">{intel.country_iso}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Link to={`/devices/${ip.device_id}`}
                            className="text-blue-600 hover:underline text-xs">{ip.device_name}</Link>
                        </td>
                        <td className="px-4 py-2.5 text-xs font-mono text-slate-500">
                          {ip.interface_name ?? <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{fmtTime(ip.last_seen)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right column — IP intelligence */}
        <div className="space-y-5">
          {nonPrivateIPs.map(ip => {
            const intel = data.ip_intel[ip.ip]
            if (!intel) return null
            return (
              <div key={ip.ip} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-700">IP Intelligence</h2>
                  <span className="font-mono text-xs text-slate-400">{ip.ip}</span>
                </div>
                <div className="px-4 py-3 space-y-3">
                  {intel.country_name && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Location</span>
                      <span className="text-xs font-medium text-slate-700">
                        {[intel.city, intel.country_name].filter(Boolean).join(', ')}
                      </span>
                    </div>
                  )}
                  {intel.asn && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">ASN</span>
                      <span className="text-xs font-medium text-slate-700">
                        AS{intel.asn}{intel.asn_org ? ` — ${intel.asn_org}` : ''}
                      </span>
                    </div>
                  )}
                  {intel.abuse_score !== null && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">Abuse score</span>
                        {intel.abuse_reports != null && intel.abuse_reports > 0 && (
                          <span className="text-[10px] text-slate-400">{intel.abuse_reports} reports</span>
                        )}
                      </div>
                      <AbuseBar score={intel.abuse_score} />
                    </div>
                  )}
                  {intel.abuse_isp && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">ISP</span>
                      <span className="text-xs text-slate-600 text-right max-w-[160px] truncate">{intel.abuse_isp}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* MAC info card */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-700">MAC details</h2>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs text-slate-500 shrink-0">Address</span>
                <span className="font-mono text-xs text-slate-800 text-right">{data.mac}</span>
              </div>
              {data.vendor && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-slate-500 shrink-0">Vendor (OUI)</span>
                  <span className="text-xs text-slate-700 text-right">{data.vendor}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Known IPs</span>
                <span className="text-xs font-medium text-slate-700">{data.ips.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Devices seen on</span>
                <span className="text-xs font-medium text-slate-700">{data.presences.length}</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
