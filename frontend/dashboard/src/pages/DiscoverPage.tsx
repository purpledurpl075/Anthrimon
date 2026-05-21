import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCredentials, startSweep, getSweepJob, listSweepJobs, cancelSweepJob,
  type DiscoveredDevice, type SweepJob, type SweepJobSummary,
} from '../api/discovery'
import api from '../api/client'
import VendorBadge from '../components/VendorBadge'
import { useRole, hasRole } from '../hooks/useCurrentUser'

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{value} / {max} hosts scanned</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function summaryToPartialJob(s: SweepJobSummary): SweepJob {
  return {
    job_id: s.job_id, status: s.status as SweepJob['status'],
    cidr: s.cidr, total: s.total, scanned: s.scanned,
    found: [], error: null,
    started_at: s.started_at, finished_at: s.finished_at,
  }
}

const STATUS_STYLE: Record<string, string> = {
  pending:   'bg-slate-100 text-slate-600',
  running:   'bg-blue-100 text-blue-700',
  done:      'bg-green-100 text-green-700',
  cancelled: 'bg-amber-100 text-amber-700',
  error:     'bg-red-100 text-red-700',
}

function formatAge(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function CredentialPicker({
  credentials,
  selected,
  onChange,
  disabled,
}: {
  credentials: { id: string; name: string; type: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
  disabled: boolean
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  }
  return (
    <div className="flex flex-col gap-1.5">
      {credentials.length === 0 && (
        <p className="text-xs text-slate-400">No SNMP credentials configured.</p>
      )}
      {credentials.map(c => (
        <label key={c.id}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors select-none ${
            disabled ? 'opacity-50 cursor-not-allowed' :
            selected.includes(c.id)
              ? 'border-blue-400 bg-blue-50'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}>
          <input
            type="checkbox"
            checked={selected.includes(c.id)}
            onChange={() => !disabled && toggle(c.id)}
            disabled={disabled}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          <span className="text-xs font-medium text-slate-700">{c.name}</span>
          <span className="text-[10px] text-slate-400 font-mono ml-auto">{c.type}</span>
        </label>
      ))}
    </div>
  )
}

export default function DiscoverPage() {
  const queryClient = useQueryClient()
  const canAct = hasRole(useRole(), 'operator')

  const [cidr,       setCidr]      = useState('')
  const [credIds,    setCredIds]   = useState<string[]>([])
  const [sshCredIds, setSshCredIds]= useState<string[]>([])
  const [timeout,    setTimeout_]  = useState(3)
  const [jobId,      setJobId]     = useState<string | null>(null)
  const [job,        setJob]       = useState<SweepJob | null>(null)
  const [adding,     setAdding]    = useState<Set<string>>(new Set())
  const [added,      setAdded]     = useState<Set<string>>(new Set())
  const [addError,   setAddError]  = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: allCredentials = [] } = useQuery({ queryKey: ['credentials'], queryFn: fetchCredentials })
  const snmpCreds = allCredentials.filter(c => c.type === 'snmp_v2c' || c.type === 'snmp_v3')
  const sshCreds  = allCredentials.filter(c => c.type === 'ssh' || c.type === 'netconf')

  // Auto-select all SNMP creds on first load
  useEffect(() => {
    if (snmpCreds.length > 0 && credIds.length === 0) {
      setCredIds(snmpCreds.map(c => c.id))
    }
  }, [snmpCreds])

  const { data: jobList = [], refetch: refetchJobs } = useQuery({
    queryKey:        ['sweep-jobs'],
    queryFn:         listSweepJobs,
    refetchInterval: 3_000,
  })

  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(async () => {
      try {
        const j = await getSweepJob(jobId)
        setJob(j)
        if (j.status === 'done' || j.status === 'cancelled' || j.status === 'error') {
          clearInterval(pollRef.current!)
          refetchJobs()
        }
      } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(pollRef.current!)
  }, [jobId])

  const sweepMutation = useMutation({
    mutationFn: () => startSweep(cidr, credIds, timeout),
    onSuccess: (j) => { setJob(j); setJobId(j.job_id); setAdded(new Set()); refetchJobs() },
  })

  const cancelMutation = useMutation({
    mutationFn: (jid: string) => cancelSweepJob(jid),
    onSuccess: (_, jid) => {
      if (jid === jobId) {
        clearInterval(pollRef.current!)
        setJob(j => j ? { ...j, status: 'cancelled' } : null)
      }
      refetchJobs()
    },
  })

  async function handleAddDevice(d: DiscoveredDevice) {
    setAdding(prev => new Set(prev).add(d.ip))
    setAddError(null)
    try {
      const credType = allCredentials.find(c => c.id === d.credential_id)?.type
      const res = await api.post<{ id: string }>('/devices', {
        hostname:          d.hostname,
        mgmt_ip:           d.ip,
        vendor:            d.vendor,
        collection_method: 'snmp',
        snmp_version:      credType === 'snmp_v3' ? 'v3' : 'v2c',
        credential_id:     d.credential_id ?? undefined,
      })
      // Link any selected SSH/netconf credentials
      if (res.data?.id && sshCredIds.length > 0) {
        await Promise.all(
          sshCredIds.map(cid =>
            api.post(`/devices/${res.data.id}/credentials`, { credential_id: cid }).catch(() => {})
          )
        )
      }
      setAdded(prev => new Set(prev).add(d.ip))
      queryClient.invalidateQueries({ queryKey: ['devices'] })
    } catch (e: any) {
      setAddError(e?.response?.data?.detail ?? 'Failed to add device')
    } finally {
      setAdding(prev => { const s = new Set(prev); s.delete(d.ip); return s })
    }
  }

  const isRunning  = job?.status === 'pending' || job?.status === 'running'
  const activeJobs = jobList.filter(j => j.status === 'pending' || j.status === 'running')

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Discover</h1>
      </div>

      <main className="p-6 max-w-4xl mx-auto space-y-5">

        {activeJobs.length > 0 && !jobId && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-blue-700">
              <span className="font-semibold">{activeJobs.length}</span> sweep{activeJobs.length !== 1 ? 's' : ''} running in background
            </span>
            <button onClick={() => {
                const s = activeJobs[0]
                setJob(summaryToPartialJob(s))
                setJobId(s.job_id)
                getSweepJob(s.job_id).then(setJob)
              }}
              className="text-xs text-blue-600 hover:underline font-medium">
              View →
            </button>
          </div>
        )}

        {/* Sweep form */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">SNMP Sweep</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {/* Left col: CIDR + timeout */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">CIDR Range</label>
                <input type="text" value={cidr} onChange={e => setCidr(e.target.value)}
                  placeholder="10.0.2.0/24" disabled={isRunning}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Timeout per host (s)</label>
                <input type="number" value={timeout} onChange={e => setTimeout_(Number(e.target.value))}
                  min={1} max={10} disabled={isRunning}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {/* SNMP credentials */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-slate-600">
                  SNMP credentials
                  {credIds.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-blue-600 font-semibold">({credIds.length})</span>
                  )}
                </label>
                {snmpCreds.length > 1 && (
                  <div className="flex gap-2">
                    <button onClick={() => setCredIds(snmpCreds.map(c => c.id))} disabled={isRunning}
                      className="text-[10px] text-blue-600 hover:underline disabled:opacity-50">all</button>
                    <button onClick={() => setCredIds([])} disabled={isRunning}
                      className="text-[10px] text-slate-400 hover:underline disabled:opacity-50">clear</button>
                  </div>
                )}
              </div>
              <CredentialPicker credentials={snmpCreds} selected={credIds} onChange={setCredIds} disabled={isRunning} />
              <p className="text-[10px] text-slate-400 mt-1.5">Used to probe — first to respond wins per host.</p>
            </div>

            {/* SSH credentials */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-slate-600">
                  SSH / Netconf credentials
                  {sshCredIds.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-green-600 font-semibold">({sshCredIds.length})</span>
                  )}
                </label>
                {sshCreds.length > 1 && (
                  <div className="flex gap-2">
                    <button onClick={() => setSshCredIds(sshCreds.map(c => c.id))} disabled={isRunning}
                      className="text-[10px] text-blue-600 hover:underline disabled:opacity-50">all</button>
                    <button onClick={() => setSshCredIds([])} disabled={isRunning}
                      className="text-[10px] text-slate-400 hover:underline disabled:opacity-50">clear</button>
                  </div>
                )}
              </div>
              {sshCreds.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No SSH credentials configured.</p>
              ) : (
                <CredentialPicker credentials={sshCreds} selected={sshCredIds} onChange={setSshCredIds} disabled={isRunning} />
              )}
              <p className="text-[10px] text-slate-400 mt-1.5">Linked to every device you add from results.</p>
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button onClick={() => sweepMutation.mutate()}
              disabled={!cidr || credIds.length === 0 || isRunning || !canAct}
              title={credIds.length === 0 ? 'Select at least one SNMP credential' : undefined}
              className="bg-blue-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {isRunning ? 'Scanning…' : 'Start sweep'}
            </button>
            {isRunning && (
              <button onClick={() => cancelMutation.mutate(jobId!)} disabled={cancelMutation.isPending}
                className="text-xs border border-red-200 text-red-600 hover:bg-red-50 rounded-lg px-3 py-2 transition-colors disabled:opacity-50">
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel sweep'}
              </button>
            )}
            {job && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded capitalize ${STATUS_STYLE[job.status] ?? ''}`}>
                {job.status}
              </span>
            )}
            {sweepMutation.isError && <span className="text-xs text-red-600">Failed to start sweep</span>}
          </div>

          {job && isRunning && <div className="mt-4"><ProgressBar value={job.scanned} max={job.total} /></div>}
          {job?.status === 'done' && (
            <p className="mt-3 text-xs text-slate-500">
              Scan complete — {job.found.length} device{job.found.length !== 1 ? 's' : ''} found in {job.cidr}
            </p>
          )}
          {job?.status === 'cancelled' && (
            <p className="mt-3 text-xs text-amber-600">
              Sweep cancelled — {job.found.length} device{job.found.length !== 1 ? 's' : ''} found before cancellation
            </p>
          )}
        </div>

        {/* Results */}
        {job && job.found.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Discovered Devices</h3>
              <div className="flex items-center gap-3">
                {addError && <span className="text-xs text-red-500">{addError}</span>}
                <span className="text-xs text-slate-400">{job.found.length} found</span>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">IP</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Hostname</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Vendor</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600">Credential</th>
                  <th className="text-left px-4 py-2.5 font-medium text-slate-600 max-w-xs">Description</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {job.found.map(d => {
                  const credName = allCredentials.find(c => c.id === d.credential_id)?.name
                  return (
                    <tr key={d.ip} className={`hover:bg-slate-50 ${d.already_in_db ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{d.ip}</td>
                      <td className="px-4 py-2.5 text-slate-700">{d.hostname}</td>
                      <td className="px-4 py-2.5"><VendorBadge vendor={d.vendor} /></td>
                      <td className="px-4 py-2.5">
                        {credName
                          ? <span className="text-xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-mono">{credName}</span>
                          : <span className="text-xs text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400 max-w-xs truncate">{d.sys_descr}</td>
                      <td className="px-4 py-2.5 text-right">
                        {d.already_in_db ? (
                          <Link to={`/devices/${d.device_id}`} className="text-xs text-slate-500 hover:text-blue-600 transition-colors">
                            Already monitored →
                          </Link>
                        ) : added.has(d.ip) ? (
                          <span className="text-xs text-green-600 font-medium">Added ✓</span>
                        ) : canAct ? (
                          <button onClick={() => handleAddDevice(d)} disabled={adding.has(d.ip)}
                            className="text-xs bg-green-600 text-white rounded px-3 py-1 hover:bg-green-700 disabled:opacity-50 transition-colors">
                            {adding.has(d.ip) ? 'Adding…' : 'Add'}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {job?.status === 'done' && job.found.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
            No SNMP-responding devices found in {job.cidr}.
          </div>
        )}

        {/* Job history */}
        {jobList.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-800">Sweep history</h3>
            </div>
            <div className="divide-y divide-slate-50">
              {jobList.map(j => (
                <div key={j.job_id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded capitalize shrink-0 ${STATUS_STYLE[j.status] ?? ''}`}>
                    {j.status}
                  </span>
                  <span className="font-mono text-xs text-slate-700 w-28 shrink-0">{j.cidr}</span>
                  <div className="flex-1 min-w-0">
                    {j.status === 'running' || j.status === 'pending' ? (
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden w-32">
                        <div className="h-full bg-blue-400 rounded-full transition-all"
                          style={{ width: `${j.total > 0 ? (j.scanned / j.total) * 100 : 0}%` }} />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">{j.found} device{j.found !== 1 ? 's' : ''} found</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 shrink-0">{formatAge(j.started_at)}</span>
                  {(j.status === 'pending' || j.status === 'running') && canAct && (
                    <button onClick={() => cancelMutation.mutate(j.job_id)}
                      className="shrink-0 text-[10px] border border-red-200 text-red-500 hover:bg-red-50 rounded px-2 py-0.5 transition-colors">
                      Cancel
                    </button>
                  )}
                  {(j.status === 'done' || j.status === 'cancelled') && (
                    <button onClick={() => {
                        setJob(summaryToPartialJob(j))
                        setJobId(j.job_id)
                        getSweepJob(j.job_id).then(setJob)
                      }}
                      className="shrink-0 text-[10px] text-blue-600 hover:underline">
                      Results
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
