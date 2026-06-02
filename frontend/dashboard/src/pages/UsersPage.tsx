import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../api/client'
import { hasRole } from '../hooks/useCurrentUser'

// ── Types ──────────────────────────────────────────────────────────────────────

interface MeData {
  id: string
  role: string
  tenant_id: string
  tenant_name: string
  is_platform_admin: boolean
}

interface UserRow {
  id: string
  username: string
  email: string
  full_name: string | null
  role: string
  is_active: boolean
  is_platform_admin: boolean
  platform_role: string | null
  tenant_id: string
  tenant_name: string
  last_login: string | null
}

interface TenantSummary {
  id: string
  name: string
  is_active: boolean
}

interface TenantGrant {
  tenant_id: string
  tenant_name: string
  role: string
  is_home: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────────

const ROLES          = ['readonly', 'operator', 'admin']
const PLATFORM_ROLES = ['platform_admin', 'platform_support']

const ROLE_CHIP: Record<string, string> = {
  admin:      'bg-blue-100 text-blue-700',
  operator:   'bg-cyan-100 text-cyan-700',
  readonly:   'bg-slate-100 text-slate-600',
  superadmin: 'bg-purple-100 text-purple-700',
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtAge(iso: string | null): string {
  if (!iso) return 'Never'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return 'Just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Shared input styles ────────────────────────────────────────────────────────

const cls = {
  input:  'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500',
  select: 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

// ── UserModal ──────────────────────────────────────────────────────────────────

interface UserModalProps {
  editing:         UserRow | null
  onClose:         () => void
  me:              MeData
  tenants:         TenantSummary[]
  defaultTenantId: string
}

function UserModal({ editing, onClose, me, tenants, defaultTenantId }: UserModalProps) {
  const qc          = useQueryClient()
  const isNew       = editing === null
  const isSelf      = editing?.id === me.id
  const isPlatAdmin = me.is_platform_admin

  // Profile state
  const [tenantId,     setTenantId]     = useState(editing?.tenant_id ?? defaultTenantId)
  const [username,     setUsername]     = useState(editing?.username   ?? '')
  const [email,        setEmail]        = useState(editing?.email      ?? '')
  const [fullName,     setFullName]     = useState(editing?.full_name  ?? '')
  const [role,         setRole]         = useState(
    editing?.role && ROLES.includes(editing.role) ? editing.role : 'readonly'
  )
  const [isActive,     setIsActive]     = useState(editing?.is_active  ?? true)
  const [isPlatUser,   setIsPlatUser]   = useState(editing?.is_platform_admin  ?? false)
  const [platformRole, setPlatformRole] = useState(editing?.platform_role ?? '')
  const [password,     setPassword]     = useState('')
  const [error,        setError]        = useState<string | null>(null)

  // Tenant access state (platform admin + edit mode only)
  const [tab,          setTab]          = useState<'profile' | 'tenants'>('profile')
  const [tenantGrants, setTenantGrants] = useState<TenantGrant[]>([])
  const [addTenantId,  setAddTenantId]  = useState('')

  const showTenantTab = isPlatAdmin && !isNew

  const { data: existingGrants = [] } = useQuery<TenantGrant[]>({
    queryKey: ['user-tenant-access', editing?.id],
    queryFn:  () => api.get<TenantGrant[]>(`/platform/users/${editing!.id}/tenant-access`).then(r => r.data),
    enabled:  showTenantTab,
  })
  useEffect(() => { setTenantGrants(existingGrants) }, [existingGrants])

  const assignedIds      = new Set(tenantGrants.map(g => g.tenant_id))
  const availableTenants = tenants.filter(t => !assignedIds.has(t.id) && t.is_active)

  // ── Save ──────────────────────────────────────────────────────────────────────

  const saveMut = useMutation({
    mutationFn: async () => {
      if (isNew) {
        if (password.length < 8) throw new Error('Password must be at least 8 characters')
        if (isPlatAdmin) {
          await api.post('/platform/users', {
            tenant_id: tenantId, username, email, password,
            full_name: fullName || null, role,
            is_platform_admin: isPlatUser,
            platform_role: isPlatUser && platformRole ? platformRole : null,
          })
        } else {
          await api.post('/users', { username, email, password, full_name: fullName || null, role })
        }
      } else {
        if (isPlatAdmin) {
          await api.patch(`/platform/users/${editing!.id}`, {
            email, full_name: fullName || null,
            ...(!isSelf && { role, is_active: isActive }),
            is_platform_admin: isPlatUser,
            platform_role: isPlatUser && platformRole ? platformRole : null,
          })
          await api.put(`/platform/users/${editing!.id}/tenant-access`,
            tenantGrants.filter(g => !g.is_home).map(g => ({ tenant_id: g.tenant_id, role: g.role }))
          )
        } else {
          const patch: Record<string, unknown> = { email, full_name: fullName || null }
          if (!isSelf) { patch.role = role; patch.is_active = isActive }
          await api.patch(`/users/${editing!.id}`, patch)
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users-page'] })
      qc.invalidateQueries({ queryKey: ['user-tenant-access', editing?.id] })
      onClose()
    },
    onError: (e: any) => setError(e?.message ?? e?.response?.data?.detail ?? 'Save failed'),
  })

  const resetMut = useMutation({
    mutationFn: () => api.post(
      isPlatAdmin
        ? `/platform/users/${editing!.id}/reset-password`
        : `/users/${editing!.id}/reset-password`,
      { new_password: password }
    ),
    onSuccess: () => { setPassword(''); setError(null) },
    onError:   (e: any) => setError(e?.response?.data?.detail ?? 'Reset failed'),
  })

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-slate-800">
            {isNew ? 'New user' : `Edit ${editing!.username}`}
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Tabs — platform admin + edit mode only */}
        {showTenantTab && (
          <div className="flex border-b border-slate-100 shrink-0">
            {(['profile', 'tenants'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {t === 'profile' ? 'Profile' : 'Customer access'}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4">

          {/* ── Profile tab ─────────────────────────────────────────────────── */}
          {(isNew || tab === 'profile') && (
            <div className="space-y-3">

              {/* Customer picker — platform admin creating a new user */}
              {isNew && isPlatAdmin && (
                <Field label="Customer">
                  <select value={tenantId} onChange={e => setTenantId(e.target.value)} className={cls.select}>
                    {tenants.filter(t => t.is_active).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </Field>
              )}

              {/* Username — new user only, read-only on edit */}
              {isNew && (
                <Field label="Username">
                  <input value={username} onChange={e => setUsername(e.target.value)}
                    placeholder="jsmith" className={cls.input}/>
                </Field>
              )}

              <Field label="Email">
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="j.smith@example.com" className={cls.input}/>
              </Field>

              <Field label="Full name">
                <input value={fullName} onChange={e => setFullName(e.target.value)}
                  placeholder="Jane Smith" className={cls.input}/>
              </Field>

              <Field label="Access level">
                <select value={role} onChange={e => setRole(e.target.value)} disabled={isSelf}
                  className={`${cls.select} disabled:opacity-50 disabled:cursor-not-allowed`}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  {editing?.role === 'superadmin' && <option value="superadmin">superadmin (legacy)</option>}
                </select>
                {isSelf && <p className="text-[10px] text-slate-400 mt-1">Cannot change your own role</p>}
              </Field>

              {/* Account status — edit mode, not self */}
              {!isNew && !isSelf && (
                <Field label="Account status">
                  <select value={isActive ? 'active' : 'inactive'}
                    onChange={e => setIsActive(e.target.value === 'active')} className={cls.select}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </Field>
              )}

              {/* Platform admin section — visible to platform admins only */}
              {isPlatAdmin && (
                <div className="pt-2 mt-1 border-t border-slate-100 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={isPlatUser} onChange={e => setIsPlatUser(e.target.checked)}
                      className="rounded accent-blue-600"/>
                    <span className="text-sm text-slate-700 font-medium">Platform administrator</span>
                  </label>
                  {isPlatUser && (
                    <Field label="Platform role">
                      <select value={platformRole} onChange={e => setPlatformRole(e.target.value)} className={cls.select}>
                        <option value="">— none —</option>
                        {PLATFORM_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </Field>
                  )}
                </div>
              )}

              {/* Password — required on create */}
              {isNew && (
                <Field label="Password">
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters" className={cls.input}/>
                </Field>
              )}

              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}

          {/* ── Customer access tab ─────────────────────────────────────────── */}
          {tab === 'tenants' && showTenantTab && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                Grant this user access to additional customers. Their home customer is always included and cannot be removed here.
              </p>

              {tenantGrants.length > 0 ? (
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <th className="text-left px-3 py-2 text-xs font-medium text-slate-600">Customer</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-slate-600">Access level</th>
                        <th className="px-3 py-2 w-8"/>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {tenantGrants.map(g => (
                        <tr key={g.tenant_id}>
                          <td className="px-3 py-2.5 text-slate-700 text-xs">
                            {g.tenant_name}
                            {g.is_home && (
                              <span className="ml-1.5 text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-medium">
                                home
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {g.is_home
                              ? <span className="text-xs text-slate-400">{g.role}</span>
                              : (
                                <select value={g.role}
                                  onChange={e => setTenantGrants(prev =>
                                    prev.map(x => x.tenant_id === g.tenant_id ? { ...x, role: e.target.value } : x)
                                  )}
                                  className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                              )
                            }
                          </td>
                          <td className="px-3 py-2.5">
                            {!g.is_home && (
                              <button
                                onClick={() => setTenantGrants(prev => prev.filter(x => x.tenant_id !== g.tenant_id))}
                                className="p-1 text-slate-300 hover:text-red-500 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-slate-400 py-2">No customer access configured yet.</p>
              )}

              {availableTenants.length > 0 && (
                <div className="flex gap-2">
                  <select value={addTenantId} onChange={e => setAddTenantId(e.target.value)}
                    className={`flex-1 ${cls.select}`}>
                    <option value="">Add customer access…</option>
                    {availableTenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <button onClick={() => {
                    const t = tenants.find(t => t.id === addTenantId)
                    if (!t) return
                    setTenantGrants(prev => [...prev, { tenant_id: t.id, tenant_name: t.name, role: 'readonly', is_home: false }])
                    setAddTenantId('')
                  }} disabled={!addTenantId}
                    className="px-3 py-2 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50">
                    Add
                  </button>
                </div>
              )}

              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3 shrink-0">
          {/* Password reset — edit + profile tab only */}
          {!isNew && tab === 'profile' && (
            <div className="flex items-center gap-2 flex-1">
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="New password…"
                className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              <button
                onClick={() => password.length >= 8 ? resetMut.mutate() : setError('Password must be at least 8 characters')}
                disabled={resetMut.isPending}
                className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition-colors disabled:opacity-50">
                {resetMut.isPending ? '…' : resetMut.isSuccess ? 'Done' : 'Reset'}
              </button>
            </div>
          )}
          <div className="flex gap-2 ml-auto shrink-0">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">
              Cancel
            </button>
            <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
              className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
              {saveMut.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── UsersPage ──────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const qc = useQueryClient()

  const { data: me, isLoading: meLoading } = useQuery<MeData>({
    queryKey: ['me'],
    queryFn:  () => api.get<MeData>('/auth/me').then(r => r.data),
  })

  const isPlatAdmin = me?.is_platform_admin ?? false

  // Tenant list for platform admins (filter dropdown + modal picker)
  const { data: tenants = [] } = useQuery<TenantSummary[]>({
    queryKey: ['platform-tenants'],
    queryFn:  () => api.get<TenantSummary[]>('/platform/tenants').then(r => r.data),
    enabled:  isPlatAdmin,
  })

  // Filters
  const [filterTenantId, setFilterTenantId] = useState('')
  const [platformOnly,   setPlatformOnly]   = useState(false)
  const [search,         setSearch]         = useState('')

  // Users — different endpoint per role
  const { data: rawUsers = [], isLoading: usersLoading } = useQuery<UserRow[]>({
    queryKey: ['users-page', isPlatAdmin, filterTenantId, platformOnly],
    queryFn: async () => {
      if (!me) return []
      if (isPlatAdmin) {
        const params = new URLSearchParams()
        if (filterTenantId) params.set('tenant_id', filterTenantId)
        if (platformOnly)   params.set('platform_only', 'true')
        const qs = params.toString()
        return api.get<UserRow[]>(`/platform/users${qs ? '?' + qs : ''}`).then(r => r.data)
      } else {
        const rows = await api.get<Omit<UserRow, 'tenant_id' | 'tenant_name'>[]>('/users').then(r => r.data)
        return rows.map(u => ({ ...u, tenant_id: me.tenant_id, tenant_name: me.tenant_name, platform_role: null }))
      }
    },
    enabled: !!me,
  })

  const users = rawUsers.filter(u => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      u.username.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.full_name ?? '').toLowerCase().includes(q) ||
      (isPlatAdmin && u.tenant_name.toLowerCase().includes(q))
    )
  })

  const [modal,      setModal]      = useState<'new' | UserRow | null>(null)
  const [deleteConf, setDeleteConf] = useState<UserRow | null>(null)

  const toggleMut = useMutation({
    mutationFn: (u: UserRow) => api.patch(
      isPlatAdmin ? `/platform/users/${u.id}` : `/users/${u.id}`,
      { is_active: !u.is_active }
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users-page'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (u: UserRow) => api.delete(
      isPlatAdmin ? `/platform/users/${u.id}` : `/users/${u.id}`
    ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users-page'] }); setDeleteConf(null) },
  })

  // ── Access guard ──────────────────────────────────────────────────────────────

  if (meLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-slate-400">Loading…</div>
  }

  if (!me || (!hasRole(me.role, 'admin') && !isPlatAdmin)) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-slate-600 font-medium">Access restricted</p>
          <p className="text-slate-400 text-sm mt-1">Requires admin role or platform admin.</p>
        </div>
      </div>
    )
  }

  const defaultTenantId = filterTenantId || tenants.find(t => t.is_active)?.id || me.tenant_id

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl">

      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-sm font-semibold text-slate-800">Users</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {isPlatAdmin ? 'All users across all customers' : `Users in ${me.tenant_name}`}
          </p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          New user
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search users…"
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-52"/>
        {isPlatAdmin && (
          <>
            <select value={filterTenantId} onChange={e => setFilterTenantId(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All customers</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
              <input type="checkbox" checked={platformOnly} onChange={e => setPlatformOnly(e.target.checked)}
                className="rounded accent-blue-600"/>
              Platform admins only
            </label>
          </>
        )}
        <span className="text-xs text-slate-400 ml-auto">
          {users.length} user{users.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      {usersLoading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-center py-16 text-sm text-slate-400 bg-white rounded-2xl border border-slate-200">
          No users found
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">User</th>
                {isPlatAdmin && <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Customer</th>}
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Access level</th>
                {isPlatAdmin && <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Platform</th>}
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Last login</th>
                <th className="px-4 py-2.5 w-24"/>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{u.username}</div>
                    <div className="text-xs text-slate-400">{u.full_name ?? u.email}</div>
                    {u.full_name && <div className="text-xs text-slate-400">{u.email}</div>}
                  </td>
                  {isPlatAdmin && (
                    <td className="px-4 py-3 text-xs text-slate-600">{u.tenant_name}</td>
                  )}
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${ROLE_CHIP[u.role] ?? ROLE_CHIP.readonly}`}>
                      {u.role}
                    </span>
                  </td>
                  {isPlatAdmin && (
                    <td className="px-4 py-3">
                      {u.is_platform_admin && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          {u.platform_role ?? 'platform_admin'}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{fmtAge(u.last_login)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setModal(u)} title="Edit"
                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                      </button>
                      {u.id !== me.id && (
                        <>
                          <button onClick={() => toggleMut.mutate(u)} disabled={toggleMut.isPending}
                            title={u.is_active ? 'Deactivate' : 'Activate'}
                            className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                              u.is_active
                                ? 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'
                                : 'text-slate-400 hover:text-green-600 hover:bg-green-50'
                            }`}>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              {u.is_active
                                ? <path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"/>
                                : <path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
                              }
                            </svg>
                          </button>
                          <button onClick={() => setDeleteConf(u)} title="Delete"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / create modal */}
      {modal !== null && (
        <UserModal
          editing={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          me={me}
          tenants={tenants}
          defaultTenantId={defaultTenantId}
        />
      )}

      {/* Delete confirmation */}
      {deleteConf && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-800">Delete user?</h3>
            <p className="text-sm text-slate-600">
              <span className="font-medium">{deleteConf.username}</span>
              {isPlatAdmin && ` (${deleteConf.tenant_name})`}
              {' '}will be permanently removed. This cannot be undone.
            </p>
            {deleteMut.error && (
              <p className="text-xs text-red-500">
                {(deleteMut.error as any)?.response?.data?.detail ?? 'Delete failed'}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteConf(null)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">
                Cancel
              </button>
              <button onClick={() => deleteMut.mutate(deleteConf)} disabled={deleteMut.isPending}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50">
                {deleteMut.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
