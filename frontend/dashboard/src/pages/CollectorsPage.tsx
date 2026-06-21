import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCollectors, fetchCollectorDetails, fetchCollectorLogs, fetchCollectorOwnLogs,
  createCollector, deleteCollector, regenerateToken, patchCollector,
  downloadPackage, fetchBuildStatus, triggerBuild, triggerUpdate,
  type RemoteCollector, type CollectorDetails, type SyslogMessage,
  type CollectorLogEntry, type BuildStatus,
} from '../api/collectors'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { formatAge } from '../utils/time'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTs(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

const STATUS_DOT: Record<string, string> = {
  online:  'bg-green-500',
  offline: 'bg-slate-400',
  pending: 'bg-amber-400 animate-pulse',
  revoked: 'bg-red-400',
}
const STATUS_TEXT: Record<string, string> = {
  online:  'text-green-700 bg-green-100',
  offline: 'text-slate-600 bg-slate-100',
  pending: 'text-amber-700 bg-amber-100',
  revoked: 'text-red-700 bg-red-100',
}

const SEV_COLOR: Record<number, string> = {
  0: 'text-red-600',    // emergency
  1: 'text-red-600',    // alert
  2: 'text-red-600',    // critical
  3: 'text-orange-500', // error
  4: 'text-amber-500',  // warning
  5: 'text-blue-500',   // notice
  6: 'text-slate-500',  // info
  7: 'text-slate-400',  // debug
}
const SEV_NAME = ['EMERG','ALERT','CRIT','ERR','WARN','NOTICE','INFO','DEBUG']

const LEVEL_COLOR: Record<string, string> = {
  trace: 'text-slate-400',
  debug: 'text-slate-500',
  info:  'text-green-400',
  warn:  'text-amber-400',
  error: 'text-red-500',
  fatal: 'text-red-600',
  panic: 'text-red-600',
}

// ── Token modal ───────────────────────────────────────────────────────────────

function TokenModal({ collector, ca_cert, onClose }: {
  collector: RemoteCollector
  ca_cert:   string | null
  onClose:   () => void
}) {
  const [copied,      setCopied]      = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [dlError,     setDlError]     = useState<string | null>(null)

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleDownload = () => {
    setDownloading(true); setDlError(null)
    downloadPackage(collector.id, collector.registration_token ?? '')
      .catch(err => setDlError(err?.response?.data?.detail ?? 'Download failed'))
      .finally(() => setDownloading(false))
  }

  const envBlock = [
    `ANTHRIMON_HUB=https://${window.location.hostname}`,
    `ANTHRIMON_TOKEN=${collector.registration_token}`,
  ].join('\n')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Collector created — <span className="text-slate-600">{collector.name}</span></h2>
              <p className="text-xs text-slate-400 mt-0.5">Save the registration token now. It will not be shown again.</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
            <p className="text-xs text-amber-700">One-time secret — copy before closing. If lost, regenerate from the collector list.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Registration token (24h)</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-950 text-green-400 text-xs font-mono px-3 py-2.5 rounded-lg overflow-auto whitespace-nowrap">{collector.registration_token}</code>
              <button onClick={() => copy(collector.registration_token!, 'token')}
                className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                {copied === 'token' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Environment variables</label>
            <div className="flex items-start gap-2">
              <pre className="flex-1 bg-slate-950 text-green-400 text-xs font-mono px-3 py-2.5 rounded-lg leading-relaxed">{envBlock}</pre>
              <button onClick={() => copy(envBlock, 'env')}
                className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                {copied === 'env' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
          {ca_cert && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Hub CA certificate</label>
              <div className="flex items-start gap-2">
                <pre className="flex-1 bg-slate-950 text-green-400 text-[10px] font-mono px-3 py-2.5 rounded-lg leading-relaxed max-h-32 overflow-auto">{ca_cert}</pre>
                <button onClick={() => copy(ca_cert, 'cert')}
                  className="shrink-0 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                  {copied === 'cert' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
          <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-slate-700">Deployment package (linux/x64)</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Unzip and run <code className="bg-slate-200 px-1 rounded">sudo bash install.sh</code>.</p>
              </div>
              <button onClick={handleDownload} disabled={downloading}
                className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                {downloading ? 'Downloading…' : 'Download .zip'}
              </button>
            </div>
            {dlError && <p className="text-[11px] text-red-500">{dlError}</p>}
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-end">
          <button onClick={onClose}
            className="px-5 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors">
            I've saved the token
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Collector detail drawer ───────────────────────────────────────────────────

function CollectorDrawer({ collectorId, canEdit, onClose, onToken }: {
  collectorId: string
  canEdit:     boolean
  onClose:     () => void
  onToken:     (c: RemoteCollector, ca: string) => void
}) {
  const qc        = useQueryClient()
  const [tab, setTab] = useState<'overview' | 'logs'>('overview')
  const [logWindow, setLogWindow]   = useState(120)
  const [logSource, setLogSource]   = useState<'device' | 'collector'>('device')

  const { data: details, isLoading } = useQuery<CollectorDetails>({
    queryKey:        ['collector-details', collectorId],
    queryFn:         () => fetchCollectorDetails(collectorId),
    refetchInterval: 15_000,
  })

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey:        ['collector-logs', collectorId, logWindow],
    queryFn:         () => fetchCollectorLogs(collectorId, logWindow),
    enabled:         tab === 'logs' && logSource === 'device',
    refetchInterval: 30_000,
  })

  const { data: ownLogs, isLoading: ownLogsLoading } = useQuery({
    queryKey:        ['collector-own-logs', collectorId, logWindow],
    queryFn:         () => fetchCollectorOwnLogs(collectorId, logWindow),
    enabled:         tab === 'logs' && logSource === 'collector',
    refetchInterval: 30_000,
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteCollector(collectorId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['collectors'] }); onClose() },
  })

  const tokenMut = useMutation({
    mutationFn: () => regenerateToken(collectorId),
    onSuccess:  (data) => {
      if (details) onToken({ ...details, registration_token: data.registration_token }, data.ca_cert)
    },
  })

  const [updateResult, setUpdateResult] = useState<string | null>(null)
  const updateMut = useMutation({
    mutationFn: () => triggerUpdate(collectorId),
    onSuccess:  (data) => {
      setUpdateResult(
        data.status === 'update_triggered'
          ? 'Update triggered — collector is installing the new binary.'
          : data.status === 'offline'
          ? 'Collector is offline. Try again once it comes back online.'
          : (data.detail ?? 'Unknown error'),
      )
      setTimeout(() => setUpdateResult(null), 6000)
    },
  })

  const [confirmAction, setConfirmAction] = useState<'revoke' | 'delete' | null>(null)

  // ── Timezone ────────────────────────────────────────────────────────────────
  const [collectorTz, setCollectorTz] = useState('UTC')

  useEffect(() => {
    if (details) setCollectorTz(details.timezone ?? 'UTC')
  }, [details])

  const tzMut = useMutation({
    mutationFn: (tz: string) => patchCollector(collectorId, { timezone: tz }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['collector-details', collectorId] }),
  })

  // ── Poll intervals ───────────────────────────────────────────────────────────
  const [stateInterval, setStateInterval]     = useState<string>('')
  const [counterInterval, setCounterInterval] = useState<string>('')

  useEffect(() => {
    if (details) {
      setStateInterval(details.state_interval_s != null ? String(details.state_interval_s) : '')
      setCounterInterval(details.counter_interval_s != null ? String(details.counter_interval_s) : '')
    }
  }, [details])

  const intervalMut = useMutation({
    mutationFn: () => patchCollector(collectorId, {
      state_interval_s:   stateInterval   !== '' ? Number(stateInterval)   : null,
      counter_interval_s: counterInterval !== '' ? Number(counterInterval) : null,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collector-details', collectorId] }),
  })

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="w-[480px] bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="h-4 w-32 bg-slate-100 rounded animate-pulse" />
            ) : details ? (
              <>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[details.status] ?? STATUS_DOT.offline}`} />
                  <h2 className="text-sm font-semibold text-slate-800 truncate">{details.name}</h2>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${STATUS_TEXT[details.status] ?? STATUS_TEXT.offline}`}>
                    {details.status}
                  </span>
                </div>
                {details.hostname && (
                  <p className="text-xs text-slate-400 font-mono mt-0.5 truncate">{details.hostname}</p>
                )}
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 shrink-0">
          {(['overview', 'logs'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-slate-800 text-slate-800'
                  : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}>
              {t}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="p-5 space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-4 bg-slate-100 rounded animate-pulse" />)}
            </div>
          )}

          {details && tab === 'overview' && (
            <div className="p-5 space-y-5">
              {/* WireGuard / network */}
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Connection</h3>
                <div className="bg-slate-50 rounded-xl divide-y divide-slate-100">
                  {[
                    ['WireGuard IP', details.wg_ip ?? 'not bootstrapped'],
                    ['Public IP',    details.ip_address ?? '—'],
                    ['Version',      details.version ?? '—'],
                    ['Last seen',    details.last_seen ? formatAge(details.last_seen) : '—'],
                    ['Registered',   details.registered_at ? formatTs(details.registered_at) : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between px-3 py-2">
                      <span className="text-xs text-slate-500">{k}</span>
                      <span className="text-xs font-mono text-slate-700">{v}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Capabilities */}
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Capabilities</h3>
                <div className="flex gap-1.5 flex-wrap">
                  {(details.capabilities ?? []).map(cap => (
                    <span key={cap} className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium capitalize">{cap}</span>
                  ))}
                </div>
              </section>

              {/* Assigned devices */}
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
                  Assigned devices <span className="ml-1 text-slate-300 font-normal normal-case">({details.devices.length})</span>
                </h3>
                {details.devices.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No devices assigned to this collector.</p>
                ) : (
                  <div className="bg-slate-50 rounded-xl divide-y divide-slate-100">
                    {details.devices.map(d => (
                      <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-slate-700 truncate">{d.hostname}</p>
                          <p className="text-[11px] text-slate-400 font-mono">{d.mgmt_ip}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] text-slate-400 capitalize">{d.vendor} {d.device_type}</p>
                          <p className="text-[10px] text-slate-300">{d.last_polled ? formatAge(d.last_polled) : 'never polled'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Timezone */}
              {canEdit && (
                <section>
                  <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Syslog timezone</h3>
                  <p className="text-[11px] text-slate-400 mb-2">
                    RFC 3164 syslog timestamps carry no timezone. Set the local timezone for devices at this collector's site so messages are stored correctly in UTC.
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      value={collectorTz}
                      onChange={e => setCollectorTz(e.target.value)}
                      className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {[
                        'UTC',
                        'America/New_York',
                        'America/Chicago',
                        'America/Denver',
                        'America/Los_Angeles',
                        'America/Phoenix',
                        'America/Anchorage',
                        'Pacific/Honolulu',
                        'Europe/London',
                        'Europe/Paris',
                        'Europe/Berlin',
                        'Europe/Helsinki',
                        'Asia/Dubai',
                        'Asia/Kolkata',
                        'Asia/Singapore',
                        'Asia/Tokyo',
                        'Asia/Shanghai',
                        'Australia/Sydney',
                        'Australia/Perth',
                        'Pacific/Auckland',
                      ].map(tz => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => tzMut.mutate(collectorTz)}
                      disabled={tzMut.isPending || collectorTz === (details?.timezone ?? 'UTC')}
                      className="shrink-0 px-3 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-40 transition-colors">
                      {tzMut.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  {tzMut.isSuccess && (
                    <p className="text-[11px] text-green-600 mt-1">Timezone saved.</p>
                  )}
                </section>
              )}

              {/* Poll intervals */}
              {canEdit && (
                <section>
                  <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Poll intervals</h3>
                  <p className="text-[11px] text-slate-400 mb-2">
                    State interval controls BGP/OSPF/IS-IS polling cadence. Counter interval controls routes, VLANs, STP and ARP/MAC. Leave blank to use platform defaults (15s / 60s). Changes take effect after the collector restarts.
                  </p>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="text-[11px] text-slate-500 block mb-1">State interval (s)</label>
                      <input
                        type="number"
                        min={5}
                        placeholder="15"
                        value={stateInterval}
                        onChange={e => setStateInterval(e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500 block mb-1">Counter interval (s)</label>
                      <input
                        type="number"
                        min={5}
                        placeholder="60"
                        value={counterInterval}
                        onChange={e => setCounterInterval(e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => intervalMut.mutate()}
                    disabled={intervalMut.isPending}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-40 transition-colors">
                    {intervalMut.isPending ? 'Saving…' : 'Save'}
                  </button>
                  {intervalMut.isSuccess && (
                    <p className="text-[11px] text-green-600 mt-1">Intervals saved.</p>
                  )}
                </section>
              )}

              {/* Actions */}
              {canEdit && (
                <section className="border-t border-slate-100 pt-4 space-y-2">
                  {/* Hot-patch update */}
                  {details.is_active && details.status === 'online' && (
                    <button onClick={() => updateMut.mutate()} disabled={updateMut.isPending}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                      {updateMut.isPending ? 'Triggering…' : 'Deploy update'}
                    </button>
                  )}
                  {updateResult && (
                    <p className={`text-[11px] px-1 ${updateResult.startsWith('Update triggered') ? 'text-green-600' : 'text-amber-600'}`}>
                      {updateResult}
                    </p>
                  )}

                  {details.is_active && (
                    <button onClick={() => tokenMut.mutate()} disabled={tokenMut.isPending}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/></svg>
                      {tokenMut.isPending ? 'Regenerating…' : 'Regenerate registration token'}
                    </button>
                  )}

                  {confirmAction === 'revoke' ? (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                      <p className="flex-1 text-xs text-red-700">Revoke this collector? It will stop reporting and devices will fall back to hub polling.</p>
                      <button onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}
                        className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                        {deleteMut.isPending ? 'Revoking…' : 'Revoke'}
                      </button>
                      <button onClick={() => setConfirmAction(null)} className="shrink-0 text-xs text-slate-400 hover:underline px-1">Cancel</button>
                    </div>
                  ) : confirmAction === 'delete' ? (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                      <p className="flex-1 text-xs text-red-700">Permanently delete this record? This cannot be undone.</p>
                      <button onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}
                        className="shrink-0 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                        {deleteMut.isPending ? 'Deleting…' : 'Delete'}
                      </button>
                      <button onClick={() => setConfirmAction(null)} className="shrink-0 text-xs text-slate-400 hover:underline px-1">Cancel</button>
                    </div>
                  ) : details.is_active ? (
                    <button onClick={() => setConfirmAction('revoke')}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18.364 5.636 5.636 18.364m0-12.728 12.728 12.728"/></svg>
                      Revoke collector
                    </button>
                  ) : (
                    <button onClick={() => setConfirmAction('delete')}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                      Delete permanently
                    </button>
                  )}
                </section>
              )}
            </div>
          )}

          {tab === 'logs' && (
            <div className="flex flex-col h-full">
              {/* Log toolbar */}
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3 shrink-0 flex-wrap">
                {/* Source toggle */}
                <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
                  {([['device', 'Device syslog'], ['collector', 'Collector']] as const).map(([src, label]) => (
                    <button key={src} onClick={() => setLogSource(src)}
                      className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        logSource === src
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-500 hover:bg-slate-50'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>

                <span className="text-slate-300">|</span>
                <span className="text-xs text-slate-500">Window:</span>
                {[
                  [30, '30 min'], [120, '2 h'], [720, '12 h'], [1440, '24 h'],
                ].map(([mins, label]) => (
                  <button key={mins} onClick={() => setLogWindow(mins as number)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors ${
                      logWindow === mins ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
                    }`}>
                    {label}
                  </button>
                ))}
                {(logsLoading || ownLogsLoading) && (
                  <svg className="w-3.5 h-3.5 text-slate-400 animate-spin ml-auto" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                )}
              </div>

              {/* Log lines */}
              <div className="flex-1 overflow-y-auto bg-slate-950 p-3 font-mono text-[11px] leading-relaxed">
                {logSource === 'device' ? (
                  !logs || logs.messages.length === 0 ? (
                    <p className="text-slate-500 italic p-2">
                      {logsLoading ? 'Loading…' :
                       !details || details.devices.length === 0
                         ? 'No devices assigned to this collector yet.'
                         : 'No syslog messages in this window.'}
                    </p>
                  ) : (
                    logs.messages.map((msg: SyslogMessage, i: number) => (
                      <div key={i} className="flex gap-2 py-0.5 hover:bg-white/5 rounded px-1">
                        <span className="text-slate-600 shrink-0 w-[155px]">{formatTs(msg.received_at)}</span>
                        <span className={`shrink-0 w-12 font-semibold ${SEV_COLOR[msg.severity] ?? 'text-slate-400'}`}>
                          {SEV_NAME[msg.severity] ?? msg.severity}
                        </span>
                        <span className="text-slate-400 shrink-0 max-w-[80px] truncate">{msg.hostname || msg.device_ip}</span>
                        <span className="text-indigo-400 shrink-0 max-w-[80px] truncate">{msg.program}</span>
                        <span className="text-slate-200 flex-1 min-w-0 break-words">{msg.message}</span>
                      </div>
                    ))
                  )
                ) : (
                  !ownLogs || ownLogs.logs.length === 0 ? (
                    <p className="text-slate-500 italic p-2">
                      {ownLogsLoading ? 'Loading…' : 'No collector logs in this window.'}
                    </p>
                  ) : (
                    ownLogs.logs.map((entry: CollectorLogEntry, i: number) => (
                      <div key={i} className="flex gap-2 py-0.5 hover:bg-white/5 rounded px-1">
                        <span className="text-slate-600 shrink-0 w-[155px]">{formatTs(entry.ts)}</span>
                        <span className={`shrink-0 w-10 font-semibold uppercase ${LEVEL_COLOR[entry.level] ?? 'text-slate-400'}`}>
                          {entry.level}
                        </span>
                        <span className="text-slate-200 flex-1 min-w-0 break-words">{entry.message}</span>
                      </div>
                    ))
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Collector row ─────────────────────────────────────────────────────────────

function CollectorRow({ collector, canEdit, onClick, onToken }: {
  collector: RemoteCollector
  canEdit:   boolean
  onClick:   () => void
  onToken:   (c: RemoteCollector, ca: string) => void
}) {
  const qc = useQueryClient()
  const [confirmDel, setConfirmDel] = useState(false)

  const deleteMut = useMutation({
    mutationFn: () => deleteCollector(collector.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['collectors'] }),
  })

  const tokenMut = useMutation({
    mutationFn: () => regenerateToken(collector.id),
    onSuccess:  (data) => onToken(
      { ...collector, registration_token: data.registration_token }, data.ca_cert
    ),
  })

  const isRevoked = !collector.is_active

  return (
    <tr className="hover:bg-slate-50 transition-colors cursor-pointer" onClick={onClick}>
      {/* Status */}
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[collector.status] ?? STATUS_DOT.offline}`} />
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${STATUS_TEXT[collector.status] ?? STATUS_TEXT.offline}`}>
            {collector.status}
          </span>
        </div>
      </td>

      {/* Name + hostname */}
      <td className="px-4 py-3.5">
        <div className={`text-sm font-medium ${isRevoked ? 'text-slate-400' : 'text-slate-800'}`}>{collector.name}</div>
        {collector.hostname && (
          <div className="text-xs text-slate-400 font-mono mt-0.5">{collector.hostname}</div>
        )}
      </td>

      {/* WireGuard IP */}
      <td className="px-4 py-3.5">
        {collector.wg_ip
          ? <code className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{collector.wg_ip}</code>
          : <span className="text-xs text-slate-300">—</span>}
      </td>

      {/* Capabilities */}
      <td className="px-4 py-3.5">
        {!isRevoked && (
          <div className="flex gap-1 flex-wrap">
            {(collector.capabilities ?? []).map(c => (
              <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium capitalize">{c}</span>
            ))}
          </div>
        )}
      </td>

      {/* Last seen */}
      <td className="px-4 py-3.5 text-xs text-slate-500">
        {collector.last_seen ? formatAge(collector.last_seen) : '—'}
      </td>

      {/* Version */}
      <td className="px-4 py-3.5 text-xs text-slate-400 font-mono">
        {collector.version ?? '—'}
      </td>

      {/* Actions — stop click from opening drawer */}
      <td className="px-4 py-3.5 text-right" onClick={e => e.stopPropagation()}>
        {canEdit && (
          <div className="flex items-center justify-end gap-1">
            {/* Regenerate token — active only */}
            {!isRevoked && (
              <button onClick={() => tokenMut.mutate()} disabled={tokenMut.isPending}
                title="Regenerate registration token"
                className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/></svg>
              </button>
            )}

            {/* Revoke / delete */}
            {confirmDel ? (
              <>
                <button onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}
                  className="text-xs text-red-600 hover:underline font-medium px-1">
                  {isRevoked ? 'Delete' : 'Revoke'}
                </button>
                <button onClick={() => setConfirmDel(false)} className="text-xs text-slate-400 hover:underline px-1">Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirmDel(true)}
                title={isRevoked ? 'Delete permanently' : 'Revoke collector'}
                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                {isRevoked ? (
                  /* Trash icon for revoked */
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                ) : (
                  /* X icon for active */
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18.364 5.636 5.636 18.364m0-12.728 12.728 12.728"/></svg>
                )}
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

// ── Binary status panel ───────────────────────────────────────────────────────

function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function BinaryStatusPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const [buildErrors, setBuildErrors] = useState<Record<string, string>>({})

  const { data: status, isLoading } = useQuery<BuildStatus>({
    queryKey:        ['collector-build-status'],
    queryFn:         fetchBuildStatus,
    refetchInterval: 30_000,
  })

  const buildMut = useMutation({
    mutationFn: triggerBuild,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['collector-build-status'] })
      const errs: Record<string, string> = {}
      for (const [arch, r] of Object.entries(result.arches))
        if (!r.success && r.error) errs[arch] = r.error
      setBuildErrors(errs)
    },
    onError: () => setBuildErrors({ _: 'Build request failed — check API logs.' }),
  })

  const allBuilt   = status ? Object.values(status.arches).every(a => a.built) : false
  const anyMissing = status ? Object.values(status.arches).some(a => !a.built) : true
  const isBuilding = buildMut.isPending
  const archLabels: Record<string, string> = { amd64: 'linux/x64', arm64: 'linux/arm64' }

  return (
    <div className={`bg-white rounded-2xl border mb-5 overflow-hidden ${anyMissing && !isBuilding ? 'border-amber-200' : 'border-slate-200'}`}>
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isBuilding ? 'bg-blue-100' : allBuilt ? 'bg-green-100' : 'bg-amber-100'}`}>
            {isBuilding ? (
              <svg className="w-3.5 h-3.5 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            ) : (
              <svg className={`w-3.5 h-3.5 ${allBuilt ? 'text-green-600' : 'text-amber-600'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 12h.01"/>
              </svg>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-800">Collector binaries</p>
            <p className="text-[11px] text-slate-400">
              {isBuilding ? 'Building…' : allBuilt ? 'All binaries ready.' : 'One or more binaries missing.'}
            </p>
          </div>
        </div>
        {canEdit && (
          <button onClick={() => { setBuildErrors({}); buildMut.mutate() }}
            disabled={isBuilding || !status?.go_available || !status?.source_exists}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-slate-800 text-white hover:bg-slate-700">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            {isBuilding ? 'Building…' : allBuilt ? 'Rebuild' : 'Build now'}
          </button>
        )}
      </div>
      <div className="divide-y divide-slate-50">
        {isLoading && <div className="px-5 py-3 text-xs text-slate-400">Loading…</div>}
        {status && Object.entries(status.arches).map(([arch, info]) => (
          <div key={arch} className="px-5 py-2.5 flex items-center gap-3">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${info.built ? 'bg-green-500' : 'bg-amber-400'}`} />
            <span className="text-xs font-mono text-slate-700 w-28">{archLabels[arch] ?? arch}</span>
            {info.built ? (
              <>
                <span className="text-xs text-slate-500">{info.size_bytes ? fmtBytes(info.size_bytes) : ''}</span>
                <span className="text-xs text-slate-400 ml-auto">built {info.built_at ? formatAge(info.built_at) : ''}</span>
              </>
            ) : (
              <span className="text-xs text-amber-600 font-medium">not built</span>
            )}
            {buildErrors[arch] && (
              <span className="ml-auto text-[11px] text-red-500 truncate max-w-xs">{buildErrors[arch]}</span>
            )}
          </div>
        ))}
        {!status?.go_available && (
          <div className="px-5 py-2.5 text-xs text-red-500">Go toolchain not found — re-run the installer.</div>
        )}
        {buildErrors._ && <div className="px-5 py-2.5 text-xs text-red-500">{buildErrors._}</div>}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CollectorsPage() {
  const qc      = useQueryClient()
  const role    = useRole()
  const canEdit = hasRole(role, 'admin')

  const [showCreate,    setShowCreate]    = useState(false)
  const [newName,       setNewName]       = useState('')
  const [tokenData,     setTokenData]     = useState<{ collector: RemoteCollector; ca: string } | null>(null)
  const [drawerOpen,    setDrawerOpen]    = useState<string | null>(null)
  const [showRevoked,   setShowRevoked]   = useState(false)

  const { data: collectors = [], isLoading } = useQuery({
    queryKey:        ['collectors'],
    queryFn:         fetchCollectors,
    refetchInterval: 15_000,
  })

  const createMut = useMutation({
    mutationFn: () => createCollector({ name: newName.trim() }),
    onSuccess:  (c) => {
      qc.invalidateQueries({ queryKey: ['collectors'] })
      setShowCreate(false); setNewName('')
      setTokenData({ collector: c, ca: c.ca_cert ?? '' })
    },
  })

  const active  = collectors.filter(c => c.is_active)
  const revoked = collectors.filter(c => !c.is_active)
  const online  = active.filter(c => c.status === 'online').length
  const offline = active.filter(c => c.status === 'offline').length
  const pending = active.filter(c => c.status === 'pending').length

  const displayed = showRevoked ? collectors : active

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Remote Collectors</h1>
          <p className="text-xs text-slate-400 mt-0.5">WireGuard-tunnelled polling agents at remote sites</p>
        </div>
        <div className="flex items-center gap-4">
          {active.length > 0 && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-slate-500">
              {online  > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />{online} online</span>}
              {offline > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{offline} offline</span>}
              {pending > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{pending} pending</span>}
            </div>
          )}
          {revoked.length > 0 && (
            <button onClick={() => setShowRevoked(s => !s)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border transition-colors ${
                showRevoked
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
              }`}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>
              {revoked.length} revoked
            </button>
          )}
          {canEdit && (
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
              New collector
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {canEdit && <BinaryStatusPanel canEdit={canEdit} />}

        {!isLoading && displayed.length === 0 && !showRevoked && (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 mb-4">
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </div>
            <p className="text-sm font-medium text-slate-700">No remote collectors yet</p>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              Create a collector to deploy a polling agent at a remote site over WireGuard.
            </p>
            {canEdit && (
              <button onClick={() => setShowCreate(true)}
                className="mt-4 px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors">
                Create first collector
              </button>
            )}
          </div>
        )}

        {displayed.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {['Status', 'Name', 'WireGuard IP', 'Capabilities', 'Last seen', 'Version', ''].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {displayed.map(c => (
                  <CollectorRow
                    key={c.id}
                    collector={c}
                    canEdit={canEdit}
                    onClick={() => setDrawerOpen(c.id)}
                    onToken={(col, ca) => setTokenData({ collector: col, ca })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* WireGuard info */}
        <div className="mt-5 bg-slate-50 rounded-2xl border border-slate-200 p-5 flex items-start gap-4">
          <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">WireGuard overlay: 10.100.0.0/24</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Hub is <code className="bg-slate-200 px-1 rounded text-[10px]">10.100.0.1</code>.
              Collectors are assigned IPs automatically at bootstrap.
              Ensure UDP 51820 is open inbound on this server.
            </p>
          </div>
        </div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">New remote collector</h2>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Collector name *</label>
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && newName.trim() && createMut.mutate()}
                  placeholder="e.g. branch-london"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <p className="text-xs text-slate-400">A registration token will be generated valid for 24 hours.</p>
            </div>
            <div className="px-6 pb-5 flex justify-end gap-2">
              <button onClick={() => { setShowCreate(false); setNewName('') }}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
              <button onClick={() => createMut.mutate()} disabled={createMut.isPending || !newName.trim()}
                className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
                {createMut.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Token modal */}
      {tokenData && (
        <TokenModal collector={tokenData.collector} ca_cert={tokenData.ca} onClose={() => setTokenData(null)} />
      )}

      {/* Collector detail drawer */}
      {drawerOpen && (
        <CollectorDrawer
          collectorId={drawerOpen}
          canEdit={canEdit}
          onClose={() => setDrawerOpen(null)}
          onToken={(col, ca) => setTokenData({ collector: col, ca })}
        />
      )}
    </div>
  )
}
