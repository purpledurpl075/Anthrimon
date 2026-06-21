import { useState, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchAllAddresses, fetchDevices } from '../api/devices'
import { macToUrl } from '../api/clients'
import { SkeletonTable } from '../components/Skeleton'

export default function AddressesPage() {
  const [search, setSearch]         = useState('')
  const [debouncedSearch, setDb]    = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'arp' | 'mac'>('all')
  const [deviceFilter, setDevice]   = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = (v: string) => {
    setSearch(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDb(v), 300)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['addresses-global', debouncedSearch, typeFilter, deviceFilter],
    queryFn: () => fetchAllAddresses({
      search: debouncedSearch || undefined,
      type: typeFilter === 'all' ? undefined : typeFilter,
      device_id: deviceFilter || undefined,
      limit: 1000,
    }),
    staleTime: 60_000,
  })

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices({ limit: 200 }),
  })

  const devices = devicesData?.items ?? []
  const items = data?.items ?? []

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Addresses</h1>
          <p className="text-xs text-slate-400 mt-0.5">ARP and MAC forwarding tables across all devices</p>
        </div>
        {data && <span className="text-sm text-slate-400">{data.total.toLocaleString()} entries</span>}
      </div>

      {/* Toolbar */}
      <div className="px-6 py-3 bg-white border-b border-slate-100 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <svg className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search by MAC address or IP…"
            className="w-full pl-9 pr-4 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        {/* Device filter */}
        <select value={deviceFilter} onChange={e => setDevice(e.target.value)}
          className="text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[200px]">
          <option value="">All devices</option>
          {devices.map(d => (
            <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>
          ))}
        </select>

        {/* Type toggle */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          {(['all', 'arp', 'mac'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-4 py-2 transition-colors ${
                typeFilter === t ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
              }`}>
              {t === 'all' ? 'All' : t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="p-6">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {isLoading ? (
            <div className="p-4"><SkeletonTable rows={8} cols={5} /></div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-slate-400 text-sm">
                {debouncedSearch || deviceFilter || typeFilter !== 'all'
                  ? 'No matches — try a different search.'
                  : 'No address data yet. Restart the SNMP collector and wait for a health poll cycle.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 font-medium text-slate-600 w-16">Type</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">MAC</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">IP</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Device</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Port</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 w-20">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600 w-32">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((e, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full text-white ${
                          e.type === 'arp' ? 'bg-cyan-600' : 'bg-violet-600'
                        }`}>{e.type.toUpperCase()}</span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        <Link to={`/clients/${macToUrl(e.mac)}`}
                          className="text-blue-600 hover:underline">{e.mac}</Link>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {e.ip
                          ? <Link to={`/clients/${macToUrl(e.mac)}`}
                              className="text-slate-700 hover:text-blue-600 hover:underline">{e.ip}</Link>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <Link to={`/devices/${e.device_id}`}
                          className="text-blue-600 hover:underline">{e.device_name}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 text-xs">
                        {e.port
                          ? e.port_iface_id
                            ? <Link to={`/devices/${e.device_id}/interfaces/${e.port_iface_id}`} className="font-mono text-blue-600 hover:underline">{e.port}</Link>
                            : <span className="font-mono">{e.port}</span>
                          : <span className="text-slate-300">—</span>}
                        {e.vlan_interface && (
                          <span className="ml-1.5 text-[10px] text-slate-400 font-mono">({e.vlan_interface})</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">{e.entry_type}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">{new Date(e.updated_at).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
