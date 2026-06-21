import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAudit, downloadAuditCsv, type AuditFilters } from '../api/audit'
import ErrorState from '../components/ErrorState'
import { SkeletonTable } from '../components/Skeleton'

const ACTION_OPTIONS = [
  '', 'create', 'update', 'delete', 'login', 'logout', 'login_failed',
  'ack_alert', 'resolve_alert', 'config_push', 'config_backup', 'discovery_run',
]

const RESOURCE_OPTIONS = [
  '', 'credential', 'user', 'alert', 'alert_rule', 'device', 'policy',
  'notification_channel', 'maintenance_window',
]

const ACTION_STYLE: Record<string, string> = {
  create:        'bg-green-100 text-green-700',
  update:        'bg-blue-100 text-blue-700',
  delete:        'bg-red-100 text-red-700',
  login:         'bg-slate-100 text-slate-700',
  logout:        'bg-slate-100 text-slate-500',
  login_failed:  'bg-amber-100 text-amber-700',
  ack_alert:     'bg-amber-50 text-amber-600',
  resolve_alert: 'bg-emerald-50 text-emerald-700',
  config_push:   'bg-purple-100 text-purple-700',
  config_backup: 'bg-slate-100 text-slate-600',
  discovery_run: 'bg-indigo-100 text-indigo-700',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export default function AuditPage() {
  const [action, setAction]         = useState('')
  const [resourceType, setResource] = useState('')
  const [since, setSince]           = useState('')
  const [until, setUntil]           = useState('')
  const [search, setSearch]         = useState('')
  const [offset, setOffset]         = useState(0)
  const limit = 100

  const filters: AuditFilters = useMemo(() => ({
    action:         action        || undefined,
    resource_type:  resourceType  || undefined,
    since:          since         || undefined,
    until:          until         || undefined,
    search:         search        || undefined,
    limit, offset,
  }), [action, resourceType, since, until, search, offset])

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', filters],
    queryFn:  () => fetchAudit(filters),
  })

  const [downloading, setDownloading] = useState(false)
  async function handleExport() {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadAuditCsv({
        action:        action        || undefined,
        resource_type: resourceType  || undefined,
        since:         since         || undefined,
        until:         until         || undefined,
        search:        search        || undefined,
      })
    } catch (err) {
      alert(`Export failed: ${(err as Error).message}`)
    } finally {
      setDownloading(false)
    }
  }

  function reset() {
    setAction(''); setResource(''); setSince(''); setUntil(''); setSearch(''); setOffset(0)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
          <p className="text-sm text-slate-500 mt-1">
            Who-changed-what trail. Append-only — entries cannot be edited or deleted.
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={downloading}
          className="text-sm font-semibold text-slate-700 border border-slate-200 bg-white rounded-lg px-4 py-2 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
          title="Download filtered audit log as CSV (capped at 30 days unless explicit window given)"
        >
          {downloading ? 'Exporting…' : '⤓ Export CSV'}
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 grid grid-cols-1 md:grid-cols-6 gap-3">
        <select value={action} onChange={e => { setAction(e.target.value); setOffset(0) }}
                className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white">
          {ACTION_OPTIONS.map(a => <option key={a} value={a}>{a || 'Any action'}</option>)}
        </select>
        <select value={resourceType} onChange={e => { setResource(e.target.value); setOffset(0) }}
                className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white">
          {RESOURCE_OPTIONS.map(r => <option key={r} value={r}>{r || 'Any resource'}</option>)}
        </select>
        <input type="datetime-local" value={since} onChange={e => { setSince(e.target.value); setOffset(0) }}
               className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
               placeholder="From" />
        <input type="datetime-local" value={until} onChange={e => { setUntil(e.target.value); setOffset(0) }}
               className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
               placeholder="To" />
        <input type="text" value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }}
               placeholder="Search action / resource / IP"
               className="md:col-span-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white" />
        <button onClick={reset}
                className="px-3 py-2 text-sm font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg hover:bg-slate-50">
          Reset
        </button>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {isLoading && (
          <div className="px-4"><SkeletonTable rows={8} cols={5} /></div>
        )}
        {error && (
          <ErrorState message="Failed to load audit log." onRetry={() => refetch()} inline />
        )}
        {data && data.items.length === 0 && (
          <div className="px-6 py-8 text-center text-sm text-slate-400">No audit entries match the current filters.</div>
        )}
        {data && data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">IP</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(e => (
                <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors align-top">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">{fmtTime(e.created_at)}</td>
                  <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">{e.user_name || 'system'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${ACTION_STYLE[e.action] ?? 'bg-slate-100 text-slate-600'}`}>
                      {e.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    <div>
                      {e.summary || (
                        e.resource_type ? (
                          <>
                            <span className="font-medium">{e.resource_type}</span>
                            {e.resource_name && <span className="text-slate-400"> · {e.resource_name}</span>}
                          </>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )
                      )}
                    </div>
                    {e.changes.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {e.changes.map((c, i) => (
                          <span key={i} className="text-[10px] font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">{e.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {data && data.total > limit && (
        <div className="flex items-center justify-between mt-4 text-xs text-slate-500">
          <span>
            Showing {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              className="px-3 py-1.5 border border-slate-200 bg-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50">
              Previous
            </button>
            <button
              disabled={offset + limit >= data.total}
              onClick={() => setOffset(offset + limit)}
              className="px-3 py-1.5 border border-slate-200 bg-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
