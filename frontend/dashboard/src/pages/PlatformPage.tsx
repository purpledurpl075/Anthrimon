import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'
import { useCurrentUser } from '../hooks/useCurrentUser'

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
  wg_public_endpoint: string
  session_timeout_hours: number
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

function SettingsTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['platform-global-settings'], queryFn: fetchPlatformSettings })

  const [wgEndpoint, setWgEndpoint]   = useState('')
  const [sessionTtl, setSessionTtl]   = useState('24')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!data) return
    setWgEndpoint(data.wg_public_endpoint ?? '')
    setSessionTtl(String(data.session_timeout_hours ?? 24))
  }, [data])

  const save = useMutation({
    mutationFn: () => api.put('/platform/settings', {
      wg_public_endpoint:    wgEndpoint.trim(),
      session_timeout_hours: Number(sessionTtl),
    }),
    onMutate: () => { setStatus('saving'); setErrMsg('') },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['platform-global-settings'] }); setStatus('saved') },
    onError: (e: any) => { setStatus('error'); setErrMsg(e?.response?.data?.detail ?? 'Save failed') },
  })

  if (isLoading) return <div className="text-sm text-slate-500 p-4">Loading…</div>

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Platform-level settings</h3>
        <p className="text-xs text-slate-500 mb-5">
          These settings apply globally across all tenants and can only be changed by platform administrators.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            WireGuard public endpoint
          </label>
          <input value={wgEndpoint} onChange={e => setWgEndpoint(e.target.value)}
            placeholder="vpn.example.com:51820"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <p className="text-xs text-slate-400 mt-1">
            Public IP/hostname and port that remote collectors use to reach the hub.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Session timeout (hours)
          </label>
          <input type="number" min={1} max={8760} value={sessionTtl} onChange={e => setSessionTtl(e.target.value)}
            className="w-32 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <p className="text-xs text-slate-400 mt-1">
            JWT expiry. Changes take effect on next login.
          </p>
        </div>
      </div>

      {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="text-sm bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' && <span className="text-xs text-green-600">Saved</span>}
        {status === 'error' && <span className="text-xs text-red-600">Error</span>}
      </div>
    </div>
  )
}

// ── PlatformPage ───────────────────────────────────────────────────────────────

const TABS = ['Tenants', 'Settings'] as const
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
      </div>
    </div>
  )
}
