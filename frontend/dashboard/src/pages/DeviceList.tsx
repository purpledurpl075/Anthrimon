import { useState, useMemo, useEffect } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchDevices, createDevice, fetchSites, bulkDeviceAction, exportDevicesCsv } from '../api/devices'
import type { BulkAction, BulkDeviceRequest } from '../api/devices'
import ErrorState from '../components/ErrorState'
import { fetchCredentials } from '../api/credentials'
import { fetchCollectors } from '../api/collectors'
import { fetchMaintenanceWindows } from '../api/maintenance'
import { fetchOverview } from '../api/overview'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'
import VendorBadge from '../components/VendorBadge'
import SavedViewsMenu from '../components/SavedViewsMenu'
import { SkeletonPage } from '../components/Skeleton'
import Pagination from '../components/Pagination'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import type { DeviceListItem } from '../api/types'
import { formatAge } from '../utils/time'

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  up:          '#16a34a',
  down:        '#dc2626',
  unreachable: '#f97316',
  unknown:     '#94a3b8',
}
const STATUS_BORDER: Record<string, string> = {
  up:          'border-green-400',
  down:        'border-red-400',
  unreachable: 'border-orange-400',
  unknown:     'border-slate-300',
}
const STATUS_LABEL: Record<string, string> = {
  up: 'Up', down: 'Down', unreachable: 'Unreachable', unknown: 'Unknown',
}

// ── Stat card ──────────────────────────────────────────────────────────────

function StatPill({ label, count, color, active, onClick }: {
  label: string; count: number; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
        active
          ? 'border-transparent text-white'
          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
      }`}
      style={active ? { backgroundColor: color, borderColor: color } : {}}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active ? 'rgba(255,255,255,0.7)' : color }} />
      <span>{count}</span>
      <span className={active ? 'text-white/80' : 'text-slate-400'}>{label}</span>
    </button>
  )
}

// ── Device card ────────────────────────────────────────────────────────────

function DeviceCard({ device, inMaintenance, selectable, selected, onToggle }: {
  device: DeviceListItem
  inMaintenance: boolean
  selectable?: boolean
  selected?: boolean
  onToggle?: (id: string) => void
}) {
  const navigate = useNavigate()
  const color   = DEVICE_TYPE_COLOR[device.device_type] ?? '#475569'
  const sc      = STATUS_COLOR[device.status]  ?? '#94a3b8'
  const border  = STATUS_BORDER[device.status] ?? 'border-slate-200'

  return (
    <div
      onClick={() => navigate(`/devices/${device.id}`)}
      className={`group relative bg-white border-l-4 ${border} rounded-xl border border-l-[4px] border-slate-200 px-5 py-4 cursor-pointer hover:shadow-md hover:-translate-y-px transition-all duration-150 flex items-center gap-4`}
      style={{ borderLeftColor: sc }}
    >
      {/* Select checkbox */}
      {selectable && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggle?.(device.id)}
          onClick={e => e.stopPropagation()}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 shrink-0"
        />
      )}

      {/* Icon */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <span style={{ color }}><DeviceTypeIcon type={device.device_type} size={20} /></span>
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-semibold text-slate-800 truncate">
            {device.fqdn ?? device.hostname}
          </span>
          {device.fqdn && device.fqdn !== device.hostname && (
            <span className="text-xs text-slate-400 truncate hidden sm:block">{device.hostname}</span>
          )}
          {inMaintenance && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Maintenance
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="font-mono">{device.mgmt_ip}</span>
          <span className="text-slate-300">·</span>
          <span style={{ color }} className="font-medium">
            {DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}
          </span>
          <span className="text-slate-300 hidden sm:block">·</span>
          <span className="hidden sm:block">{formatAge(device.last_seen)}</span>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="hidden md:block">
          <VendorBadge vendor={device.vendor} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: sc }} />
          <span className="text-xs font-medium" style={{ color: sc }}>
            {STATUS_LABEL[device.status] ?? device.status}
          </span>
        </div>
        <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </div>
  )
}

// ── Add device modal ───────────────────────────────────────────────────────

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9a-fA-F:]+$/

function isValidIP(v: string) {
  if (IPV4_RE.test(v)) {
    return v.split('.').every(n => +n >= 0 && +n <= 255)
  }
  return IPV6_RE.test(v) && v.includes(':')
}

interface AddDeviceModalProps {
  onClose: () => void
}

function AddDeviceModal({ onClose }: AddDeviceModalProps) {
  const queryClient = useQueryClient()

  const [mgmtIp,        setMgmtIp]        = useState('')
  const [snmpPort,      setSnmpPort]      = useState(161)
  const [selectedCreds, setSelectedCreds] = useState<string[]>([])
  const [collectorId,   setCollectorId]   = useState('')

  const [errors,     setErrors]     = useState<Record<string, string>>({})
  const [apiError,   setApiError]   = useState('')
  const [submitting, setSubmitting] = useState(false)

  const { data: credentials = [] } = useQuery({
    queryKey: ['credentials', 'all'],
    queryFn:  () => fetchCredentials(true),
  })

  const { data: collectors = [] } = useQuery({
    queryKey: ['collectors'],
    queryFn:  () => fetchCollectors(),
  })

  const snmpCreds = credentials.filter(c => c.type === 'snmp_v2c' || c.type === 'snmp_v3')
  const otherCreds = credentials.filter(c => c.type !== 'snmp_v2c' && c.type !== 'snmp_v3')

  const toggleCred = (id: string) => {
    setSelectedCreds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  function validate() {
    const errs: Record<string, string> = {}
    const ip = mgmtIp.trim()
    if (!ip) errs.mgmtIp = 'Management IP is required'
    else if (!isValidIP(ip)) errs.mgmtIp = 'Enter a valid IPv4 or IPv6 address'

    if (snmpPort < 1 || snmpPort > 65535) errs.snmpPort = 'Must be 1–65535'

    return errs
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length > 0) { setErrors(errs); return }
    setErrors({})
    setApiError('')
    setSubmitting(true)
    try {
      await createDevice({
        mgmt_ip:        mgmtIp.trim(),
        snmp_port:      snmpPort,
        credential_ids: selectedCreds.length > 0 ? selectedCreds : undefined,
        collector_id:   collectorId || undefined,
      })
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail
      setApiError(msg ?? 'Failed to create device')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-slate-800">Add device</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Management IP <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={mgmtIp}
              onChange={e => setMgmtIp(e.target.value)}
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono ${errors.mgmtIp ? 'border-red-400' : 'border-slate-200'}`}
              placeholder="192.168.1.1"
            />
            {errors.mgmtIp && <p className="mt-1 text-xs text-red-600">{errors.mgmtIp}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">SNMP port</label>
            <input
              type="number"
              value={snmpPort}
              onChange={e => setSnmpPort(Number(e.target.value))}
              className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.snmpPort ? 'border-red-400' : 'border-slate-200'}`}
            />
            {errors.snmpPort && <p className="mt-1 text-xs text-red-600">{errors.snmpPort}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Credentials
              {selectedCreds.length > 0 && <span className="ml-1.5 text-blue-600">({selectedCreds.length} selected)</span>}
            </label>
            <p className="text-[10px] text-slate-400 mb-2">Select one or more — SNMP credentials are tried in order during the probe.</p>
            <div className="border border-slate-200 rounded-lg max-h-40 overflow-y-auto">
              {snmpCreds.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide bg-slate-50">SNMP</div>
                  {snmpCreds.map(c => (
                    <label key={c.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCreds.includes(c.id)}
                        onChange={() => toggleCred(c.id)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs text-slate-700 flex-1 truncate">{c.name}</span>
                      <span className="text-[10px] text-slate-400">{c.type}</span>
                    </label>
                  ))}
                </>
              )}
              {otherCreds.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide bg-slate-50 border-t border-slate-100">SSH / API / Other</div>
                  {otherCreds.map(c => (
                    <label key={c.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCreds.includes(c.id)}
                        onChange={() => toggleCred(c.id)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs text-slate-700 flex-1 truncate">{c.name}</span>
                      <span className="text-[10px] text-slate-400">{c.type}</span>
                    </label>
                  ))}
                </>
              )}
              {credentials.length === 0 && (
                <div className="px-3 py-3 text-xs text-slate-400 text-center">No credentials configured</div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Collector</label>
            <select
              value={collectorId}
              onChange={e => setCollectorId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Hub (local)</option>
              {collectors.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {collectorId && (
              <p className="mt-1 text-[10px] text-slate-400">Device will be probed by the remote collector on its next poll cycle.</p>
            )}
          </div>

          {apiError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{apiError}</p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Adding…' : 'Add device'}
            </button>
          </div>

        </form>
      </div>
    </div>
  )
}

// ── Bulk action modal ──────────────────────────────────────────────────────

const BULK_ACTION_TITLE: Record<BulkAction, string> = {
  add_tag:              'Add tag',
  remove_tag:           'Remove tag',
  set_site:             'Change site',
  set_collector:        'Change collector',
  set_credential:       'Apply credential',
  set_polling_interval: 'Set polling interval',
  delete:               'Delete devices',
}

interface BulkActionModalProps {
  action: BulkAction
  deviceIds: string[]
  onClose: () => void
  onDone: () => void
}

function BulkActionModal({ action, deviceIds, onClose, onDone }: BulkActionModalProps) {
  const queryClient = useQueryClient()
  const count = deviceIds.length
  const isDelete = action === 'delete'

  const [tag, setTag]                   = useState('')
  const [siteId, setSiteId]             = useState('')
  const [collectorId, setCollectorId]   = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [pollingInterval, setPollingInterval] = useState(60)
  const [formError, setFormError]       = useState('')

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn:  () => fetchSites(),
    enabled:  action === 'set_site',
  })
  const { data: collectors = [] } = useQuery({
    queryKey: ['collectors'],
    queryFn:  () => fetchCollectors(),
    enabled:  action === 'set_collector',
  })
  const { data: credentials = [] } = useQuery({
    queryKey: ['credentials'],
    queryFn:  () => fetchCredentials(),
    enabled:  action === 'set_credential',
  })

  const mutation = useMutation({
    mutationFn: (body: BulkDeviceRequest) => bulkDeviceAction(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      onDone()
    },
  })

  const apiError = (mutation.error as { response?: { data?: { detail?: string } } })
    ?.response?.data?.detail

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')

    const body: BulkDeviceRequest = { device_ids: deviceIds, action }
    switch (action) {
      case 'add_tag':
      case 'remove_tag':
        if (!tag.trim()) { setFormError('Tag is required'); return }
        body.tag = tag.trim()
        break
      case 'set_site':
        body.site_id = siteId || null
        break
      case 'set_collector':
        body.collector_id = collectorId || null
        break
      case 'set_credential':
        if (!credentialId) { setFormError('Select a credential'); return }
        body.credential_id = credentialId
        break
      case 'set_polling_interval':
        body.polling_interval_s = pollingInterval
        break
    }
    mutation.mutate(body)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-slate-800">
            {BULK_ACTION_TITLE[action]} &mdash; {count} device{count === 1 ? '' : 's'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">

          {(action === 'add_tag' || action === 'remove_tag') && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tag</label>
              <input
                type="text"
                autoFocus
                value={tag}
                onChange={e => setTag(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. prod"
              />
            </div>
          )}

          {action === 'set_site' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Site</label>
              <select
                value={siteId}
                onChange={e => setSiteId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Unassigned</option>
                {sites.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {action === 'set_collector' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Collector</label>
              <select
                value={collectorId}
                onChange={e => setCollectorId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Hub (local)</option>
                {collectors.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {action === 'set_credential' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Credential</label>
              <select
                value={credentialId}
                onChange={e => setCredentialId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select a credential…</option>
                {credentials.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                ))}
              </select>
            </div>
          )}

          {action === 'set_polling_interval' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Polling interval (seconds)</label>
              <input
                type="number"
                min={10}
                max={86400}
                value={pollingInterval}
                onChange={e => setPollingInterval(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-[10px] text-slate-400">Between 10 and 86400 seconds.</p>
            </div>
          )}

          {isDelete && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              This will permanently delete {count} device{count === 1 ? '' : 's'} and all their history.
              This cannot be undone.
            </p>
          )}

          {(formError || apiError) && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError || apiError}</p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-colors ${
                isDelete ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {mutation.isPending
                ? 'Applying…'
                : isDelete
                  ? `Delete ${count} device${count === 1 ? '' : 's'}`
                  : `Apply to ${count} device${count === 1 ? '' : 's'}`}
            </button>
          </div>

        </form>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'up' | 'down' | 'unreachable' | 'unknown'

export default function DeviceList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const search       = searchParams.get('q') ?? ''
  const statusFilter = (searchParams.get('status') as StatusFilter | null) ?? 'all'
  const pageOffset   = parseInt(searchParams.get('offset') ?? '0', 10) || 0
  const PAGE_SIZE    = 100
  const [showAddModal,  setShowAddModal]  = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null)

  const role = useRole()
  const canBulk   = hasRole(role, 'operator')
  const canDelete = hasRole(role, 'admin')

  const setSearch = (q: string) => {
    setSelected(new Set())
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (q === '') next.delete('q'); else next.set('q', q)
      return next
    })
  }
  const setStatusFilter = (s: StatusFilter) => {
    setSelected(new Set())
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (s === 'all') next.delete('status'); else next.set('status', s)
      next.delete('offset')
      return next
    })
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['devices', statusFilter === 'all' ? undefined : statusFilter, pageOffset],
    queryFn:  () => fetchDevices({
      limit: PAGE_SIZE,
      offset: pageOffset,
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
    }),
    refetchInterval: 30_000,
  })

  const { data: activeWindows = [] } = useQuery({
    queryKey: ['maintenance-active'],
    queryFn:  () => fetchMaintenanceWindows({ active_only: true }),
    refetchInterval: 60_000,
  })

  const inMaintenance = new Set<string>(
    activeWindows.flatMap(w =>
      (w.device_selector?.device_ids as string[] | undefined) ?? []
    )
  )

  const { data: overview } = useQuery({
    queryKey: ['overview-counts'],
    queryFn: fetchOverview,
    refetchInterval: 30_000,
  })

  const devices = data?.items ?? []

  const counts = useMemo(() => ({
    all:         overview?.devices.total ?? data?.total ?? 0,
    up:          overview?.devices.up ?? 0,
    down:        overview?.devices.down ?? 0,
    unreachable: overview?.devices.unreachable ?? 0,
    unknown:     overview?.devices.unknown ?? 0,
  }), [overview, data?.total])

  const setPage = (newOffset: number) => {
    setSelected(new Set())
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newOffset === 0) next.delete('offset'); else next.set('offset', String(newOffset))
      return next
    })
  }

  useEffect(() => {
    if (data && pageOffset > 0 && pageOffset >= data.total) setPage(0)
  }, [data?.total])

  const filtered = useMemo(() => {
    return devices.filter(d => {
      if (search) {
        const q = search.toLowerCase()
        return (
          (d.fqdn ?? d.hostname).toLowerCase().includes(q) ||
          d.mgmt_ip.includes(q) ||
          (d.vendor ?? '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [devices, search])

  const toggle = (id: string) => setSelected(s => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const toggleAll = () => setSelected(s =>
    s.size === filtered.length ? new Set() : new Set(filtered.map(d => d.id))
  )
  const clearSelection = () => setSelected(new Set())

  if (isLoading) return <SkeletonPage />
  if (error) {
    return <ErrorState message="Failed to load devices." onRetry={() => refetch()} />
  }

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-900">

      {showAddModal && <AddDeviceModal onClose={() => setShowAddModal(false)} />}

      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Devices</h1>
          <p className="text-xs text-slate-400 mt-0.5">{data?.total ?? 0} in inventory</p>
        </div>
        <div className="flex items-center gap-2">
        <SavedViewsMenu page="devices" query={searchParams.toString()} onApply={q => setSearchParams(new URLSearchParams(q))} />
        <button
          onClick={() => exportDevicesCsv()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border text-slate-500 border-slate-200 hover:border-slate-400 transition-colors"
          title="Export devices as CSV"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0-3-3m3 3 3-3M3 17V7a2 2 0 0 1 2-2h6l2 2h4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
          Export
        </button>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add device
        </button>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4 max-w-5xl">

        {/* Stats + search row */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Select all */}
          {canBulk && filtered.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === filtered.length}
                onChange={toggleAll}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              Select all
            </label>
          )}

          {/* Status filter pills */}
          <div className="flex items-center gap-2 flex-wrap">
            <StatPill label="All"         count={counts.all}         color="#475569" active={statusFilter === 'all'}         onClick={() => setStatusFilter('all')} />
            <StatPill label="Up"          count={counts.up}          color="#16a34a" active={statusFilter === 'up'}          onClick={() => setStatusFilter('up')} />
            {counts.down > 0 && (
              <StatPill label="Down"      count={counts.down}        color="#dc2626" active={statusFilter === 'down'}        onClick={() => setStatusFilter('down')} />
            )}
            {counts.unreachable > 0 && (
              <StatPill label="Unreachable" count={counts.unreachable} color="#f97316" active={statusFilter === 'unreachable'} onClick={() => setStatusFilter('unreachable')} />
            )}
            {counts.unknown > 0 && (
              <StatPill label="Unknown"   count={counts.unknown}     color="#94a3b8" active={statusFilter === 'unknown'}     onClick={() => setStatusFilter('unknown')} />
            )}
          </div>

          <div className="flex-1" />

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search hostname, IP, vendor…"
              className="pl-9 pr-4 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
            />
          </div>
        </div>

        {/* Bulk action bar */}
        {canBulk && selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 sticky top-0 z-10">
            <span className="text-xs font-semibold text-blue-800">{selected.size} selected</span>
            <button onClick={clearSelection} className="text-xs text-blue-600 hover:underline">Clear</button>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={() => setBulkAction('add_tag')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Add tag</button>
              <button onClick={() => setBulkAction('remove_tag')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Remove tag</button>
              <button onClick={() => setBulkAction('set_site')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Change site</button>
              <button onClick={() => setBulkAction('set_collector')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Change collector</button>
              <button onClick={() => setBulkAction('set_credential')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Apply credential</button>
              <button onClick={() => setBulkAction('set_polling_interval')} className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors">Set polling interval</button>
              {canDelete && (
                <button onClick={() => setBulkAction('delete')} className="px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors">Delete</button>
              )}
            </div>
          </div>
        )}

        {bulkAction && (
          <BulkActionModal
            action={bulkAction}
            deviceIds={Array.from(selected)}
            onClose={() => setBulkAction(null)}
            onDone={() => { setBulkAction(null); clearSelection() }}
          />
        )}

        {/* Device cards */}
        {filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center">
            <p className="text-slate-400 text-sm">
              {search ? `No devices match "${search}"` : 'No devices found.'}
            </p>
            {search && (
              <button onClick={() => setSearch('')} className="mt-2 text-xs text-blue-600 hover:underline">
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(d => (
              <DeviceCard
                key={d.id}
                device={d}
                inMaintenance={inMaintenance.has(d.id)}
                selectable={canBulk}
                selected={selected.has(d.id)}
                onToggle={toggle}
              />
            ))}
          </div>
        )}

        {data && <Pagination total={data.total} limit={PAGE_SIZE} offset={pageOffset} onChange={setPage} />}

      </div>
    </div>
  )
}
