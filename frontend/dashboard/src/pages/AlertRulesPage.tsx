import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAlertRules, createAlertRule, updateAlertRule, deleteAlertRule } from '../api/alerts'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { fetchChannels } from '../api/channels'
import { fetchMaintenanceWindows } from '../api/maintenance'
import { fetchDevices, fetchDeviceRoutes } from '../api/devices'
import type { AlertRule } from '../api/types'

const METRICS = [
  { value: 'cpu_util_pct',      label: 'CPU utilisation %',          hasThreshold: true,  conditions: ['gt', 'lt'],  unit: '%',    thresholdLabel: 'Threshold %',        simple: true },
  { value: 'mem_util_pct',      label: 'Memory utilisation %',       hasThreshold: true,  conditions: ['gt', 'lt'],  unit: '%',    thresholdLabel: 'Threshold %',        simple: true },
  { value: 'device_down',       label: 'Device unreachable',         hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'interface_down',    label: 'Interface down (admin up)',   hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'interface_flap',    label: 'Interface flapping',         hasThreshold: true,  conditions: [],            unit: 'changes', thresholdLabel: 'Changes in window', simple: true },
  { value: 'uptime',            label: 'Device rebooted (low uptime)', hasThreshold: true, conditions: ['lt'],       unit: 's',    thresholdLabel: 'Uptime below (s)',   simple: true },
  { value: 'temperature',       label: 'Temperature sensor high',    hasThreshold: true,  conditions: ['gt'],        unit: '°C',   thresholdLabel: 'Threshold °C',       simple: true },
  { value: 'interface_errors',  label: 'Interface errors',           hasThreshold: true,  conditions: ['gt'],        unit: '',     thresholdLabel: 'Error count (5 min)', simple: true },
  { value: 'interface_util_pct', label: 'Interface utilisation',    hasThreshold: true,  conditions: ['gt'],        unit: '%',    thresholdLabel: 'Utilisation % (5 min)', simple: true },
  { value: 'ospf_state',        label: 'OSPF neighbor not full',    hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'route_missing',     label: 'Route prefix missing',       hasThreshold: false, conditions: [],            unit: '',     thresholdLabel: '',                   simple: true },
  { value: 'flow_bandwidth',   label: 'Flow bandwidth',              hasThreshold: true,  conditions: ['gt'],           unit: 'B/s', thresholdLabel: 'Threshold (bytes/s)', simple: true },
  { value: 'syslog_match',     label: 'Syslog pattern match',        hasThreshold: true,  conditions: ['gt'],           unit: 'matches', thresholdLabel: 'Min occurrences', simple: true },
  { value: 'config_change',   label: 'Config change detected',      hasThreshold: false, conditions: [],               unit: '',        thresholdLabel: '',               simple: true },
  { value: 'bgp_session_down',     label: 'BGP session down',         hasThreshold: false, conditions: [],           unit: '',    thresholdLabel: '',                         simple: true },
  { value: 'bgp_session_flapping', label: 'BGP session flapping',    hasThreshold: true,  conditions: ['gt','gte'], unit: 'flaps', thresholdLabel: 'Min flaps in window',       simple: false },
  { value: 'bgp_prefix_drop',      label: 'BGP prefix count drop',   hasThreshold: true,  conditions: ['gt','gte'], unit: '%',    thresholdLabel: 'Min drop % from 24h avg',   simple: true },
  { value: 'custom_oid',        label: 'Custom OID',                 hasThreshold: true,  conditions: ['gt','lt','eq'], unit: '', thresholdLabel: 'Threshold value',   simple: false },
]

const COND_LABEL: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' }

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-yellow-100 text-yellow-700',
  warning:  'bg-yellow-50 text-yellow-600',
  info:     'bg-blue-50 text-blue-600',
}

// ── Route prefix input ────────────────────────────────────────────────────────

const COMMON_PREFIXES = [
  { label: 'Default', value: '0.0.0.0/0' },
  { label: 'IPv6 default', value: '::/0' },
  { label: '10.0.0.0/8', value: '10.0.0.0/8' },
  { label: '172.16.0.0/12', value: '172.16.0.0/12' },
  { label: '192.168.0.0/16', value: '192.168.0.0/16' },
]

function RoutePrefixInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [showBrowser, setShowBrowser] = useState(false)
  const [browseDevice, setBrowseDevice] = useState('')

  const { data: devicesResp } = useQuery({
    queryKey: ['devices-list'],
    queryFn:  () => fetchDevices({ limit: 500 }),
    enabled:  showBrowser,
  })
  const devices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  const { data: routes = [], isFetching } = useQuery({
    queryKey: ['device-routes-browse', browseDevice],
    queryFn:  () => fetchDeviceRoutes(browseDevice),
    enabled:  showBrowser && !!browseDevice,
  })

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">
        Prefix to monitor <span className="text-slate-400 font-normal">— exact match on destination</span>
      </label>

      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="0.0.0.0/0"
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {/* Quick-pick chips */}
      <div className="flex flex-wrap gap-1.5">
        {COMMON_PREFIXES.map(p => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={`px-2 py-0.5 rounded-md text-[11px] font-mono border transition-colors ${
              value === p.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-blue-400 hover:text-blue-600'
            }`}
          >
            {p.value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowBrowser(b => !b)}
          className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors flex items-center gap-1 ${
            showBrowser
              ? 'bg-slate-800 text-white border-slate-800'
              : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-400'
          }`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z"/></svg>
          Browse routes
        </button>
      </div>

      {/* Route browser */}
      {showBrowser && (
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <select
              value={browseDevice}
              onChange={e => setBrowseDevice(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select a device to browse its routes…</option>
              {devices.map((d: any) => (
                <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>
              ))}
            </select>
          </div>

          {browseDevice && (
            isFetching ? (
              <div className="px-3 py-4 text-xs text-slate-400 text-center">Loading routes…</div>
            ) : routes.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 text-center">No routes found</div>
            ) : (
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-50">
                {routes.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { onChange(r.destination); setShowBrowser(false) }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-blue-50 transition-colors group ${
                      value === r.destination ? 'bg-blue-50' : ''
                    }`}
                  >
                    <span className="font-mono text-xs font-medium text-slate-700 group-hover:text-blue-600 w-36 shrink-0">
                      {r.destination}
                    </span>
                    {r.next_hop && (
                      <span className="text-[11px] text-slate-400 font-mono truncate">via {r.next_hop}</span>
                    )}
                    <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      r.protocol === 'ospf'      ? 'bg-orange-100 text-orange-600' :
                      r.protocol === 'static'    ? 'bg-blue-100 text-blue-600' :
                      r.protocol === 'connected' ? 'bg-green-100 text-green-600' :
                      'bg-slate-100 text-slate-500'
                    }`}>
                      {r.protocol}
                    </span>
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

// ── Flow bandwidth filter ─────────────────────────────────────────────────────

function FlowBandwidthFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // value is JSON: {"src_ip":"...","dst_ip":"...","protocol":6}
  let parsed: Record<string, string | number> = {}
  try { if (value) parsed = JSON.parse(value) } catch {}

  const update = (key: string, val: string) => {
    const next: Record<string, string | number> = { ...parsed }
    if (val) {
      next[key] = key === 'protocol' ? Number(val) : val
    } else {
      delete next[key]
    }
    onChange(Object.keys(next).length ? JSON.stringify(next) : '')
  }

  const inputCls = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">
        Flow filter <span className="text-slate-400 font-normal">— all optional, leave blank to alert on total device traffic</span>
      </label>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Src IP</label>
          <input value={String(parsed.src_ip ?? '')} onChange={e => update('src_ip', e.target.value)}
            placeholder="10.0.0.1" className={inputCls} />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Dst IP</label>
          <input value={String(parsed.dst_ip ?? '')} onChange={e => update('dst_ip', e.target.value)}
            placeholder="0.0.0.0" className={inputCls} />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Protocol</label>
          <select value={String(parsed.protocol ?? '')} onChange={e => update('protocol', e.target.value)} className={inputCls}>
            <option value="">Any</option>
            <option value="6">TCP (6)</option>
            <option value="17">UDP (17)</option>
            <option value="1">ICMP (1)</option>
            <option value="89">OSPF (89)</option>
          </select>
        </div>
      </div>
      <p className="text-[10px] text-slate-400">
        Threshold is in bytes/s — e.g. 10 Mbps = 1,250,000 B/s. Evaluated against 5-minute average from flow data.
      </p>
    </div>
  )
}

// ── Syslog match filter ────────────────────────────────────────────────────────

const SYSLOG_EXAMPLES = [
  { label: 'Interface down',  pattern: 'Interface.*down|link.*down' },
  { label: 'OSPF change',     pattern: 'OSPF.*[Nn]eighbor|OSPF.*[Ss]tate' },
  { label: 'Auth failure',    pattern: 'authentication.*fail|Invalid user|Failed password' },
  { label: 'Config change',   pattern: 'SYS-5-CONFIG_I|PARSER-5-CFG_SAVD' },
  { label: 'BGP change',      pattern: 'BGP.*[Dd]own|BGP.*[Cc]hange|BGP-5' },
]

function SyslogMatchFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  let parsed: Record<string, string | number> = {}
  try { if (value) parsed = JSON.parse(value) } catch {}

  const update = (key: string, val: string) => {
    const next: Record<string, string | number> = { ...parsed }
    if (val) {
      next[key] = key === 'severity_max' ? Number(val) : val
    } else {
      delete next[key]
    }
    onChange(Object.keys(next).length ? JSON.stringify(next) : '')
  }

  const inputCls = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-600">
        Pattern <span className="text-slate-400 font-normal">— RE2 regular expression matched against the message field</span>
      </label>
      <input
        value={String(parsed.pattern ?? '')}
        onChange={e => update('pattern', e.target.value)}
        placeholder="Interface.*down|link.*down"
        className={inputCls}
      />
      {/* Quick-pick examples */}
      <div className="flex flex-wrap gap-1.5">
        {SYSLOG_EXAMPLES.map(ex => (
          <button key={ex.label} type="button"
            onClick={() => update('pattern', ex.pattern)}
            className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors ${
              parsed.pattern === ex.pattern
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-blue-400 hover:text-blue-600'
            }`}>
            {ex.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Program filter (optional)</label>
          <input value={String(parsed.program ?? '')} onChange={e => update('program', e.target.value)}
            placeholder="sshd" className={inputCls} />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-1">Max severity</label>
          <select value={String(parsed.severity_max ?? '')} onChange={e => update('severity_max', e.target.value)}
            className={inputCls}>
            <option value="">Any</option>
            <option value="0">Emergency (0)</option>
            <option value="1">Alert (1)</option>
            <option value="2">Critical (2)</option>
            <option value="3">Error (3)</option>
            <option value="4">Warning (4)</option>
            <option value="5">Notice (5)</option>
          </select>
        </div>
      </div>
      <p className="text-[10px] text-slate-400">
        Threshold = minimum matches in the lookback window (duration field). E.g. threshold 1 + duration 300s fires if the pattern appears once in 5 minutes.
      </p>
    </div>
  )
}

function SelectorSummary({ sel }: { sel: Record<string, unknown> | null }) {
  if (!sel || Object.keys(sel).length === 0) return <span className="text-slate-400">All devices</span>
  const parts = []
  if (Array.isArray(sel.device_ids) && sel.device_ids.length) parts.push(`${sel.device_ids.length} device(s)`)
  if (Array.isArray(sel.vendors) && sel.vendors.length) parts.push(`vendors: ${sel.vendors.join(', ')}`)
  if (Array.isArray(sel.tags) && sel.tags.length) parts.push(`tags: ${sel.tags.join(', ')}`)
  return <span className="text-slate-600">{parts.join(' · ') || 'All devices'}</span>
}

const DEFAULT_FORM = {
  name: '', description: '', metric: 'cpu_util_pct', condition: 'gt',
  threshold: '90', duration_seconds: '300', severity: 'warning',
  escalation_severity: '', escalation_seconds: '',
  stable_for_seconds: '0',
  notify_on_resolve: 'true',
  suppress_if_parent_down: 'false',
  renotify_seconds: '3600',
  custom_oid: '',
  scope: 'all',
  vendors: '', tags: '',
  channel_ids: [] as string[],
  maintenance_window_ids: [] as string[],
}

function RuleModal({ editing, onClose }: { editing: AlertRule | null; onClose: () => void }) {
  const qc = useQueryClient()
  const meta = (m: string) => METRICS.find(x => x.value === m) ?? METRICS[0]

  const init = editing ? {
    name: editing.name,
    description: editing.description ?? '',
    metric: editing.metric,
    condition: editing.condition || 'gt',
    threshold: String(editing.threshold ?? ''),
    duration_seconds: String(editing.duration_seconds),
    severity: editing.severity,
    escalation_severity: editing.escalation_severity ?? '',
    escalation_seconds: String(editing.escalation_seconds ?? ''),
    stable_for_seconds: String(editing.stable_for_seconds ?? '0'),
    notify_on_resolve: String(editing.notify_on_resolve ?? true),
    suppress_if_parent_down: String(editing.suppress_if_parent_down ?? false),
    renotify_seconds: String(editing.renotify_seconds ?? 3600),
    custom_oid: editing.custom_oid ?? '',
    scope: !editing.device_selector || Object.keys(editing.device_selector).length === 0
      ? 'all'
      : (editing.device_selector.device_ids ? 'device' : editing.device_selector.vendors ? 'vendors' : editing.device_selector.tags ? 'tags' : 'all'),
    vendors: (editing.device_selector?.vendors as string[] ?? []).join(', '),
    tags: (editing.device_selector?.tags as string[] ?? []).join(', '),
    channel_ids: (editing.channel_ids ?? []).map(String),
    maintenance_window_ids: (editing.maintenance_window_ids ?? []).map(String),
  } : DEFAULT_FORM

  const [f, setF] = useState(init)
  const [advanced, setAdvanced] = useState(!!editing)
  const [error, setError] = useState('')

  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))
  const toggleId = (k: 'channel_ids' | 'maintenance_window_ids', id: string) =>
    setF(p => ({
      ...p,
      [k]: (p[k] as string[]).includes(id)
        ? (p[k] as string[]).filter(x => x !== id)
        : [...(p[k] as string[]), id],
    }))

  const { data: channels = [] } = useQuery({ queryKey: ['channels'], queryFn: fetchChannels })
  const { data: maintenanceWindows = [] } = useQuery({ queryKey: ['maintenance-windows-all'], queryFn: () => fetchMaintenanceWindows() })

  const buildSelector = () => {
    if (f.scope === 'all') return null
    if (f.scope === 'vendors') {
      const vendors = f.vendors.split(',').map(v => v.trim()).filter(Boolean)
      return vendors.length ? { vendors } : null
    }
    if (f.scope === 'tags') {
      const tags = f.tags.split(',').map(t => t.trim()).filter(Boolean)
      return tags.length ? { tags } : null
    }
    return null
  }

  const save = useMutation({
    mutationFn: () => {
      if (!f.name.trim()) throw new Error('Name is required')
      const m = meta(f.metric)
      if (m.hasThreshold) {
        const t = Number(f.threshold)
        if (f.threshold === '' || isNaN(t)) throw new Error('Threshold must be a number')
      }
      if (f.metric === 'custom_oid' && !f.custom_oid.trim()) throw new Error('OID is required for custom OID rules')
      if (f.metric === 'route_missing' && !f.custom_oid.trim()) throw new Error('Route prefix is required')
      if (f.metric === 'syslog_match' && !f.custom_oid.trim()) throw new Error('Syslog pattern is required')
      const body: Record<string, unknown> = {
        name: f.name,
        description: f.description || null,
        metric: f.metric,
        condition: m.conditions[0] ?? f.condition,
        threshold: m.hasThreshold ? Number(f.threshold) : null,
        custom_oid: (f.metric === 'custom_oid' || f.metric === 'route_missing') ? (f.custom_oid || null) : null,
        duration_seconds: Number(f.duration_seconds),
        severity: f.severity,
        escalation_severity: f.escalation_severity || null,
        escalation_seconds: f.escalation_seconds ? Number(f.escalation_seconds) : null,
        stable_for_seconds: Number(f.stable_for_seconds) || 0,
        notify_on_resolve: f.notify_on_resolve === 'true',
        suppress_if_parent_down: f.suppress_if_parent_down === 'true',
        renotify_seconds: Number(f.renotify_seconds) || 3600,
        device_selector: buildSelector(),
        channel_ids: f.channel_ids,
        maintenance_window_ids: f.maintenance_window_ids,
      }
      return editing
        ? updateAlertRule(editing.id, body)
        : createAlertRule(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      onClose()
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail
      setError(Array.isArray(detail) ? detail.map((d: any) => d?.msg ?? String(d)).join('; ') : typeof detail === 'string' ? detail : e?.message ?? 'Save failed')
    },
  })

  const m = meta(f.metric)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{editing ? 'Edit rule' : 'New alert rule'}</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setAdvanced(a => !a)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                advanced ? 'bg-slate-700 text-white border-slate-700' : 'text-slate-500 border-slate-200 hover:border-slate-400'
              }`}
            >
              {advanced ? 'Advanced' : 'Simple'}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rule name <span className="text-red-500">*</span></label>
            <input value={f.name} onChange={e => set('name', e.target.value)}
              placeholder="High CPU — core switches"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {/* Metric */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Metric</label>
            <select value={f.metric} onChange={e => set('metric', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {METRICS.filter(m => advanced || m.simple).map(m =>
                <option key={m.value} value={m.value}>{m.label}</option>
              )}
            </select>
          </div>

          {/* Custom OID / prefix input */}
          {f.metric === 'custom_oid' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                OID <span className="text-slate-400 font-normal">e.g. 1.3.6.1.2.1.1.3.0</span>
              </label>
              <input value={f.custom_oid} onChange={e => set('custom_oid', e.target.value)}
                placeholder="1.3.6.1.4.1.9.9.109.1.1.1.1.3.1"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}
          {f.metric === 'route_missing' && (
            <RoutePrefixInput value={f.custom_oid} onChange={v => set('custom_oid', v)} />
          )}
          {f.metric === 'flow_bandwidth' && (
            <FlowBandwidthFilter value={f.custom_oid} onChange={v => set('custom_oid', v)} />
          )}
          {f.metric === 'syslog_match' && (
            <SyslogMatchFilter value={f.custom_oid} onChange={v => set('custom_oid', v)} />
          )}

          {/* Threshold + condition */}
          {m.hasThreshold && (
            <div className="grid grid-cols-2 gap-3">
              {m.conditions.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Condition</label>
                  <select value={f.condition} onChange={e => set('condition', e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {m.conditions.map(c => <option key={c} value={c}>{COND_LABEL[c] ?? c}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {m.thresholdLabel || 'Threshold'}
                </label>
                <input type="number" value={f.threshold} onChange={e => set('threshold', e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}

          {/* Duration */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {f.metric === 'interface_flap' ? 'Detection window (s)' : 'Sustained duration (s)'}
              <span className="text-slate-400 font-normal ml-1">— 0 fires immediately</span>
            </label>
            <input type="number" value={f.duration_seconds} onChange={e => set('duration_seconds', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          {/* Severity */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Severity</label>
            <select value={f.severity} onChange={e => set('severity', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {['critical', 'major', 'minor', 'warning', 'info'].map(s =>
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>

          {/* Device scope — always visible */}
          <div className="border-t border-slate-100 pt-4">
            <label className="block text-xs font-medium text-slate-600 mb-2">Applies to</label>
            <div className="space-y-1.5">
              {[['all','All devices'],['vendors','Specific vendors'],['tags','Specific tags']].map(([val,lbl]) => (
                <label key={val} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="radio" value={val} checked={f.scope === val} onChange={() => set('scope', val)} className="text-blue-600" />
                  {lbl}
                </label>
              ))}
            </div>
            {f.scope === 'vendors' && (
              <input value={f.vendors} onChange={e => set('vendors', e.target.value)} placeholder="arista, cisco_ios, procurve"
                className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
            {f.scope === 'tags' && (
              <input value={f.tags} onChange={e => set('tags', e.target.value)} placeholder="core, edge, datacenter"
                className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
          </div>

          {/* Advanced fields */}
          {advanced && <>
            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Escalation</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Escalate to</label>
                  <select value={f.escalation_severity} onChange={e => set('escalation_severity', e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">No escalation</option>
                    {['critical','major','minor','warning'].map(s =>
                      <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">After (s)</label>
                  <input type="number" value={f.escalation_seconds} onChange={e => set('escalation_seconds', e.target.value)}
                    placeholder="e.g. 600" disabled={!f.escalation_severity}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Stable for (s) <span className="text-slate-400 font-normal">— wait this long after condition clears before resolving</span>
              </label>
              <input type="number" value={f.stable_for_seconds} onChange={e => set('stable_for_seconds', e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Re-notify after (s) <span className="text-slate-400 font-normal">— 0 = never</span></label>
              <input type="number" value={f.renotify_seconds ?? '3600'} onChange={e => set('renotify_seconds', e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={f.notify_on_resolve === 'true' || f.notify_on_resolve === true as any}
                  onChange={e => set('notify_on_resolve', String(e.target.checked))}
                  className="rounded border-slate-300 text-blue-600" />
                Notify when alert auto-resolves
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={f.suppress_if_parent_down === 'true' || f.suppress_if_parent_down === true as any}
                  onChange={e => set('suppress_if_parent_down', String(e.target.checked))}
                  className="rounded border-slate-300 text-blue-600" />
                Suppress if parent device is unreachable
              </label>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Notification Channels</p>
              {channels.length === 0 ? (
                <p className="text-xs text-slate-400">No channels configured — add them in Administration.</p>
              ) : (
                <div className="space-y-1.5">
                  {channels.map(ch => (
                    <label key={ch.id} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={(f.channel_ids as string[]).includes(ch.id)}
                        onChange={() => toggleId('channel_ids', ch.id)}
                        className="rounded border-slate-300 text-blue-600" />
                      {ch.name}
                      <span className="text-xs text-slate-400">{ch.type}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Maintenance Windows</p>
              {maintenanceWindows.length === 0 ? (
                <p className="text-xs text-slate-400">No maintenance windows — create them on the device page.</p>
              ) : (
                <div className="space-y-1.5">
                  {maintenanceWindows.map(w => (
                    <label key={w.id} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={(f.maintenance_window_ids as string[]).includes(w.id)}
                        onChange={() => toggleId('maintenance_window_ids', w.id)}
                        className="rounded border-slate-300 text-blue-600" />
                      {w.name}
                      {w.is_active && <span className="text-xs text-amber-600 font-medium">● Active</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Description <span className="text-slate-400 font-normal">(shown in alert)</span></label>
              <textarea value={f.description} onChange={e => set('description', e.target.value)} rows={2}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          </>}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!f.name || save.isPending}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {save.isPending ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AlertRulesPage() {
  const qc = useQueryClient()
  const canEdit = hasRole(useRole(), 'admin')
  const [modal, setModal] = useState<AlertRule | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data } = useQuery({ queryKey: ['alert-rules'], queryFn: fetchAlertRules })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateAlertRule(id, { is_enabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAlertRule,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); setConfirmDelete(null) },
  })

  const rules = data?.items ?? []

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <h1 className="text-base font-semibold text-slate-800">Alert Rules</h1>
        {canEdit && (
          <button onClick={() => setModal('new')}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            New rule
          </button>
        )}
      </div>

      <main className="p-6">
        {rules.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <p className="text-slate-400 text-sm mb-3">No alert rules yet.</p>
            <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Create your first rule</button>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Rule</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Metric</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Severity</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Scope</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Channels</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Enabled</th>
                  <th className="px-4 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((r: AlertRule) => {
                  const m = METRICS.find(x => x.value === r.metric)
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{r.name}</div>
                        {r.description && <div className="text-xs text-slate-400">{r.description}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{m?.label ?? r.metric}</div>
                        {r.threshold != null && (
                          <div className="text-xs text-slate-400">
                            {COND_LABEL[r.condition] ?? r.condition} {r.threshold}{r.metric.includes('pct') ? '%' : ''}
                            {r.duration_seconds > 0 && ` for ${r.duration_seconds}s`}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${SEVERITY_STYLE[r.severity] ?? 'bg-slate-100 text-slate-600'}`}>
                          {r.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs"><SelectorSummary sel={r.device_selector} /></td>
                      <td className="px-4 py-3">
                        {r.channel_ids?.length > 0
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">{r.channel_ids.length} channel{r.channel_ids.length !== 1 ? 's' : ''}</span>
                          : <span className="text-xs text-slate-300">None</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => canEdit && toggleMutation.mutate({ id: r.id, enabled: !r.is_enabled })}
                          disabled={!canEdit}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${r.is_enabled ? 'bg-blue-600' : 'bg-slate-200'}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${r.is_enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right space-x-3">
                        {canEdit && <button onClick={() => setModal(r)} className="text-xs text-blue-600 hover:underline">Edit</button>}
                        {canEdit && (confirmDelete === r.id ? (
                          <>
                            <button onClick={() => deleteMutation.mutate(r.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                            <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmDelete(r.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                        ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {modal && <RuleModal editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  )
}
