import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'
import { useCurrentUser } from '../hooks/useCurrentUser'
import { fetchLicense, downloadLicenseRequest, uploadLicense, deleteLicense } from '../api/license'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Tenant {
  id: string
  name: string
  slug: string
  is_active: boolean
  user_count: number
  created_at: string | null
}

interface PlatformSettings {
  base_url:                       string
  platform_name:                  string
  timezone:                       string
  device_down_stale_min_s:        number
  max_alerts_per_device_per_hour: number
  auto_close_stale_days:          number
  alert_retention_days:           number
  notifications_paused:           boolean
  notifications_paused_until:     string | null
  business_hours_enabled:         boolean
  business_hours_start:           number
  business_hours_end:             number
  business_days:                  number[]
  abuseipdb_api_key:              string
  wg_public_endpoint:             string
}


// ── API helpers ────────────────────────────────────────────────────────────────

const fetchTenants         = () => api.get<Tenant[]>('/platform/tenants').then(r => r.data)
const fetchPlatformSettings = () => api.get<PlatformSettings>('/platform/settings').then(r => r.data)

// ── Tenants tab ────────────────────────────────────────────────────────────────

function TenantsTab() {
  const qc = useQueryClient()
  const { data: tenants = [], isLoading } = useQuery({ queryKey: ['platform-tenants'], queryFn: fetchTenants })

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName]   = useState('')
  const [newSlug, setNewSlug]   = useState('')
  const [err, setErr]           = useState('')

  const create = useMutation({
    mutationFn: () => api.post('/platform/tenants', { name: newName.trim(), slug: newSlug.trim().toLowerCase() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['platform-tenants'] }); setShowCreate(false); setNewName(''); setNewSlug('') },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? 'Failed to create tenant'),
  })

  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/platform/tenants/${id}`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-tenants'] }),
  })

  if (isLoading) return <div className="text-sm text-slate-500 p-4">Loading…</div>

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Tenants ({tenants.length})</h3>
        <button
          onClick={() => { setShowCreate(true); setErr('') }}
          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
        >
          + New tenant
        </button>
      </div>

      {showCreate && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <h4 className="text-sm font-medium text-slate-700">Create tenant</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
              <input value={newName} onChange={e => { setNewName(e.target.value); setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')) }}
                placeholder="Acme Corp"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Slug</label>
              <input value={newSlug} onChange={e => setNewSlug(e.target.value.toLowerCase())}
                placeholder="acme-corp"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} disabled={!newName.trim() || !newSlug.trim() || create.isPending}
              className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => { setShowCreate(false); setErr('') }}
              className="text-xs border border-slate-300 text-slate-600 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-2 pr-4">Name</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-2 pr-4">Slug</th>
              <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wider py-2 pr-4">Users</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-2 pr-4">Status</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-2">Created</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tenants.map(t => (
              <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                <td className="py-2.5 pr-4 font-medium text-slate-800">{t.name}</td>
                <td className="py-2.5 pr-4 font-mono text-xs text-slate-500">{t.slug}</td>
                <td className="py-2.5 pr-4 text-right text-slate-600">{t.user_count}</td>
                <td className="py-2.5 pr-4">
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                    t.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${t.is_active ? 'bg-green-500' : 'bg-slate-400'}`} />
                    {t.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="py-2.5 text-xs text-slate-500">
                  {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                </td>
                <td className="py-2.5 text-right">
                  <button
                    onClick={() => toggle.mutate({ id: t.id, is_active: !t.is_active })}
                    className="text-xs text-slate-400 hover:text-slate-700 transition-colors"
                  >
                    {t.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Platform settings tab ──────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function SettingRow({ label, description, children, badge }: {
  label: string; description: string; children: React.ReactNode; badge?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-8 py-4 border-b border-slate-100 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-800">{label}</p>
          {badge}
        </div>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <div className="shrink-0 w-64">{children}</div>
    </div>
  )
}

function SettingsTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['platform-global-settings'], queryFn: fetchPlatformSettings })
  const [f, setF] = useState<PlatformSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (data) setF(data) }, [data])

  const save = useMutation({
    mutationFn: () => api.put<PlatformSettings>('/platform/settings', f),
    onSuccess: (res) => {
      qc.setQueryData(['platform-global-settings'], res.data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) =>
    setF(p => p ? { ...p, [k]: v } : p)

  if (isLoading || !f) return <div className="text-sm text-slate-500 p-4">Loading…</div>

  const txt = (k: keyof PlatformSettings, ph = '', type = 'text') => (
    <input type={type} value={String(f[k])} placeholder={ph}
      onChange={e => set(k as any, e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  )
  const num = (k: keyof PlatformSettings, ph = '') => (
    <input type="number" value={String(f[k])} placeholder={ph}
      onChange={e => set(k as any, Number(e.target.value))}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  )

  return (
    <div className="max-w-3xl">
      <p className="text-xs text-slate-500 mb-5">
        These settings apply platform-wide and can only be changed by platform administrators.
        The alerting and notification defaults below may be overridden per-tenant from
        Administration → Alerting.
      </p>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">General</h3>
        <SettingRow label="Application URL"
          description="Base URL for deep links in alert emails. Include protocol, no trailing slash.">
          {txt('base_url', 'https://anthrimon.lab.local', 'url')}
        </SettingRow>
        <SettingRow label="Platform name" description="Display name used in email notifications and templates.">
          {txt('platform_name', 'Anthrimon')}
        </SettingRow>
        <SettingRow label="Timezone"
          description="IANA timezone for timestamps in alert emails (e.g. Europe/London, America/New_York).">
          {txt('timezone', 'UTC')}
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Alerting Defaults</h3>
        <SettingRow label="Storm protection" description="Maximum new alerts per device per hour. Set to 0 to disable.">
          <div className="flex items-center gap-2">
            {num('max_alerts_per_device_per_hour', '0 = unlimited')}
            <span className="text-xs text-slate-400 shrink-0">/hr</span>
          </div>
        </SettingRow>
        <SettingRow label="Device-down stale floor"
          description="Minimum seconds without a successful poll before a device is considered unreachable. Actual threshold is max(this, 2.5× poll interval).">
          <div className="flex items-center gap-2">
            {num('device_down_stale_min_s')}
            <span className="text-xs text-slate-400 shrink-0">seconds</span>
          </div>
        </SettingRow>
        <SettingRow label="Stale alert auto-close"
          description="Auto-close open/acknowledged alerts with no activity after this many days. Set to 0 to disable.">
          <div className="flex items-center gap-2">
            {num('auto_close_stale_days', '0 = disabled')}
            <span className="text-xs text-slate-400 shrink-0">days</span>
          </div>
        </SettingRow>
        <SettingRow label="Alert retention" description="How long resolved/expired/suppressed alerts are kept before being purged.">
          <div className="flex items-center gap-2">
            {num('alert_retention_days')}
            <span className="text-xs text-slate-400 shrink-0">days</span>
          </div>
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Notification Schedule</h3>
        <SettingRow label="Pause all notifications"
          badge={f.notifications_paused ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Active</span> : undefined}
          description="Temporarily silence all outgoing alert notifications platform-wide.">
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={f.notifications_paused}
                onChange={e => set('notifications_paused', e.target.checked)}
                className="rounded border-slate-300 text-blue-600" />
              <span className="text-sm text-slate-600">Paused</span>
            </label>
            {f.notifications_paused && (
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Auto-resume at (leave blank = indefinite)</p>
                <input type="datetime-local"
                  value={f.notifications_paused_until ?? ''}
                  onChange={e => set('notifications_paused_until', e.target.value || null)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Business hours only" description="Send notifications only during configured hours. Resolved alerts always send.">
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={f.business_hours_enabled}
                onChange={e => set('business_hours_enabled', e.target.checked)}
                className="rounded border-slate-300 text-blue-600" />
              <span className="text-sm text-slate-600">Enabled</span>
            </label>
            {f.business_hours_enabled && (
              <>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={23} value={f.business_hours_start}
                    onChange={e => set('business_hours_start', Number(e.target.value))}
                    className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <span className="text-xs text-slate-400">to</span>
                  <input type="number" min={0} max={23} value={f.business_hours_end}
                    onChange={e => set('business_hours_end', Number(e.target.value))}
                    className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <span className="text-xs text-slate-400">h (24h)</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {DAY_LABELS.map((day, i) => (
                    <button key={i} type="button"
                      onClick={() => {
                        const days = f.business_days.includes(i)
                          ? f.business_days.filter(x => x !== i)
                          : [...f.business_days, i].sort()
                        set('business_days', days)
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                        f.business_days.includes(i) ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}>
                      {day}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Threat Intelligence</h3>
        <SettingRow label="AbuseIPDB API key"
          description="Used to score IPs in flow data. Free key at abuseipdb.com — 1 000 checks/day. Leave blank to disable.">
          {txt('abuseipdb_api_key', 'Paste API key here', 'password')}
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Remote Collectors</h3>
        <SettingRow label="WireGuard public endpoint"
          description="Override the endpoint given to remote collectors during bootstrap. Required when this hub is behind NAT — external collectors cannot reach a private LAN address. Use your public IP or hostname, e.g. 203.0.113.5:51820. Leave blank to auto-detect.">
          {txt('wg_public_endpoint', 'e.g. 203.0.113.5 or 203.0.113.5:51820')}
        </SettingRow>
      </div>

      <div className="flex items-center justify-end gap-3 mb-6">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className={`px-4 py-2 text-xs font-medium rounded-xl transition-colors disabled:opacity-50 ${
            saved ? 'bg-green-600 text-white' : 'bg-slate-800 text-white hover:bg-slate-700'
          }`}>
          {saved ? 'Saved!' : save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {save.isError && (
          <p className="text-xs text-red-500">{(save.error as any)?.response?.data?.detail ?? 'Failed to save'}</p>
        )}
      </div>
    </div>
  )
}

// ── PlatformPage ───────────────────────────────────────────────────────────────

// ── License tab ─────────────────────────────────────────────────────────────

function LicenseTab() {
  const qc = useQueryClient()
  const { data: lic, isLoading } = useQuery({ queryKey: ['license'], queryFn: fetchLicense })
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const upload = useMutation({
    mutationFn: (f: File) => uploadLicense(f),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['license'] })
      setMsg({ kind: 'ok', text: d.valid ? `License applied — modules: ${d.modules.join(', ') || 'none'}` : 'License processed' })
    },
    onError: (e: any) => setMsg({ kind: 'err', text: e?.message || 'Upload failed' }),
  })
  const remove = useMutation({
    mutationFn: () => deleteLicense(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['license'] }); setMsg({ kind: 'ok', text: 'License removed — reverted to free tier' }) },
    onError: (e: any) => setMsg({ kind: 'err', text: e?.message || 'Remove failed' }),
  })

  if (isLoading || !lic) return <div className="text-sm text-slate-500">Loading…</div>

  const tierBadge = lic.valid
    ? <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">Licensed</span>
    : <span className="px-2 py-0.5 rounded text-xs font-semibold bg-slate-200 text-slate-600">Free tier</span>

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-800">License status</h3>
          {tierBadge}
        </div>
        {lic.valid ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-slate-500">Modules</dt><dd className="text-slate-800">{lic.modules.includes('*') ? 'All features (*)' : (lic.modules.join(', ') || '—')}</dd>
            <dt className="text-slate-500">Expires</dt><dd className="text-slate-800">{lic.expires_at?.slice(0, 10) || '—'}</dd>
            <dt className="text-slate-500">Max devices</dt><dd className="text-slate-800">{lic.max_devices || 'Unlimited'}</dd>
            <dt className="text-slate-500">License ID</dt><dd className="text-slate-800 font-mono text-xs">{lic.lic_id}</dd>
            <dt className="text-slate-500">Machine-locked</dt><dd className="text-slate-800">{lic.machine_bound ? (lic.machine_match ? 'Yes ✓' : 'Yes — MISMATCH') : 'No (floating)'}</dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">
            Running on the free tier{lic.reason && lic.reason !== 'free_tier' ? ` — ${lic.reason}` : ''}.
            All free features are available. Apply a license to unlock paid modules.
          </p>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 mb-1">Get a license</h3>
          <p className="text-xs text-slate-500">
            Download this server's license request and send it to Anthrimon. You'll receive a
            license file bound to this machine, which you upload below.
          </p>
          <div className="mt-2 text-xs font-mono text-slate-400 break-all">{lic.machine_fingerprint}</div>
        </div>
        <button
          onClick={() => downloadLicenseRequest().catch(() => setMsg({ kind: 'err', text: 'Download failed' }))}
          className="px-3 py-2 text-sm font-medium rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200"
        >
          Download license request
        </button>

        <div className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-1">Apply a license</h3>
          <input
            ref={fileRef}
            type="file"
            accept=".key,.lic,application/json,text/plain"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.currentTarget.value = '' }}
            className="block text-sm text-slate-600 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-blue-600 file:text-white file:text-sm file:font-medium hover:file:bg-blue-700"
          />
          {lic.valid && (
            <button
              onClick={() => { if (confirm('Remove the license and revert to the free tier?')) remove.mutate() }}
              className="mt-3 px-3 py-2 text-sm font-medium rounded-md text-red-600 hover:bg-red-50"
            >
              Remove license
            </button>
          )}
        </div>

        {msg && (
          <div className={`text-sm rounded-md px-3 py-2 ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  )
}

const TABS = ['Tenants', 'Settings', 'License'] as const
type Tab = typeof TABS[number]

export default function PlatformPage() {
  const { data: me } = useCurrentUser()
  const [tab, setTab] = useState<Tab>('Tenants')

  if (!me) return null

  if (!me.is_platform_admin) {
    return (
      <div className="p-8 text-center">
        <div className="text-2xl font-bold text-slate-300 mb-2">Access denied</div>
        <p className="text-slate-500">Platform administration requires the platform_admin role.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Platform Administration</h1>
        <p className="text-sm text-slate-500 mt-0.5">Manage tenants, global settings, and platform users.</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="flex gap-1 -mb-px">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div>
        {tab === 'Tenants'  && <TenantsTab />}
        {tab === 'Settings' && <SettingsTab />}
        {tab === 'License'  && <LicenseTab />}
      </div>
    </div>
  )
}
