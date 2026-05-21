import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchSmtpSettings, saveSmtpSettings, testSmtpSettings } from '../api/admin'
import { fetchChannels, createChannel, updateChannel, deleteChannel, testChannel, type NotificationChannel } from '../api/channels'
import api from '../api/client'
import { useRole, hasRole } from '../hooks/useCurrentUser'

// ── Shared form controls ───────────────────────────────────────────────────────

function FInput({ label, value, onChange, type = 'text', placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

function FToggle({ label, checked, onChange, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string
}) {
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <div onClick={() => onChange(!checked)}
          className={`w-9 h-5 rounded-full transition-colors relative ${checked ? 'bg-blue-600' : 'bg-slate-300'}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </div>
        <span className="text-sm text-slate-700">{label}</span>
      </label>
      {hint && <p className="text-xs text-slate-400 mt-1 ml-11">{hint}</p>}
    </div>
  )
}

// ── SMTP Server tab ────────────────────────────────────────────────────────────

function SmtpTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['smtp-settings'], queryFn: fetchSmtpSettings })

  const [host, setHost]         = useState('')
  const [port, setPort]         = useState('587')
  const [user, setUser]         = useState('')
  const [password, setPassword] = useState('')
  const [fromAddr, setFromAddr] = useState('')
  const [ssl, setSsl]           = useState(false)
  const [status, setStatus]     = useState<'idle' | 'saving' | 'saved' | 'error' | 'testing' | 'tested' | 'test-error'>('idle')
  const [errMsg, setErrMsg]     = useState('')

  useEffect(() => {
    if (!data) return
    setHost(data.host)
    setPort(String(data.port))
    setUser(data.user)
    setFromAddr(data.from_addr)
    setSsl(data.ssl)
  }, [data])

  const save = useMutation({
    mutationFn: () => saveSmtpSettings({
      host, port: Number(port), user,
      password: password || null,
      from_addr: fromAddr, ssl,
    }),
    onMutate: () => { setStatus('saving'); setErrMsg('') },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['smtp-settings'] }); setStatus('saved'); setPassword('') },
    onError: (e: any) => { setStatus('error'); setErrMsg(e?.response?.data?.detail ?? 'Save failed') },
  })

  const test = useMutation({
    mutationFn: testSmtpSettings,
    onMutate: () => { setStatus('testing'); setErrMsg('') },
    onSuccess: () => setStatus('tested'),
    onError: (e: any) => { setStatus('test-error'); setErrMsg(e?.response?.data?.detail ?? 'Test failed') },
  })

  if (isLoading) return <div className="text-slate-400 text-sm p-6">Loading…</div>

  return (
    <div className="max-w-lg space-y-5 p-6">
      <p className="text-sm text-slate-500">
        Configure the outgoing SMTP server used for all email notifications. The password is encrypted with <code className="bg-slate-100 px-1 rounded text-xs">ANTHRIMON_ENCRYPTION_KEY</code> before storage.
      </p>

      <FInput label="Host" value={host} onChange={setHost} placeholder="smtp.gmail.com" />

      <div className="grid grid-cols-2 gap-4">
        <FInput label="Port" value={port} onChange={setPort} placeholder="587" />
        <FToggle label="Use SSL (port 465)" checked={ssl} onChange={setSsl}
          hint={ssl ? 'SMTP_SSL' : 'STARTTLS'} />
      </div>

      <FInput label="From address" value={fromAddr} onChange={setFromAddr} placeholder="anthrimon@yourdomain.com" />
      <FInput label="Username" value={user} onChange={setUser} placeholder="user@gmail.com" />
      <FInput label="Password" value={password} onChange={setPassword} type="password"
        hint={data?.password_set ? 'Password is set — leave blank to keep it unchanged' : 'No password stored yet'} />

      {(status === 'error' || status === 'test-error') && (
        <p className="text-xs text-red-600">{errMsg}</p>
      )}
      {status === 'saved'  && <p className="text-xs text-green-600">Settings saved.</p>}
      {status === 'tested' && <p className="text-xs text-green-600">Test email sent successfully.</p>}

      <div className="flex items-center gap-3 pt-1">
        <button onClick={() => save.mutate()}
          disabled={status === 'saving' || status === 'testing'}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => test.mutate()}
          disabled={!host || status === 'saving' || status === 'testing'}
          className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          {status === 'testing' ? 'Sending…' : 'Send test email'}
        </button>
      </div>
    </div>
  )
}

// ── Notification Channels tab ──────────────────────────────────────────────────

const CHANNEL_TYPES = [
  { value: 'email',     label: 'Email',     available: true,  colour: 'bg-green-100 text-green-700' },
  { value: 'slack',     label: 'Slack',     available: false, colour: 'bg-purple-100 text-purple-700' },
  { value: 'webhook',   label: 'Webhook',   available: false, colour: 'bg-blue-100 text-blue-700' },
  { value: 'pagerduty', label: 'PagerDuty', available: false, colour: 'bg-red-100 text-red-700' },
  { value: 'teams',     label: 'Teams',     available: false, colour: 'bg-indigo-100 text-indigo-700' },
]

function typeMeta(type: string) {
  return CHANNEL_TYPES.find(t => t.value === type) ?? { label: type, colour: 'bg-slate-100 text-slate-600', available: false }
}

function TypeBadge({ type }: { type: string }) {
  const m = typeMeta(type)
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.colour}`}>{m.label}</span>
}

function channelSummary(ch: NotificationChannel): string {
  if (ch.type === 'email') {
    const to: string[] = (ch.config.to as string[]) ?? []
    return to.length ? to.join(', ') : 'No recipients'
  }
  return ''
}

function ChannelModal({ editing, onClose }: { editing: NotificationChannel | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName]           = useState(editing?.name ?? '')
  const [type, setType]           = useState(editing?.type ?? 'email')
  const [recipients, setRecipients] = useState(
    editing?.type === 'email' ? ((editing.config.to as string[]) ?? []).join('\n') : ''
  )
  const [enabled, setEnabled]     = useState(editing?.is_enabled ?? true)
  const [errMsg, setErrMsg]       = useState('')

  const save = useMutation({
    mutationFn: () => {
      const config = type === 'email'
        ? { to: recipients.split('\n').map(s => s.trim()).filter(Boolean) }
        : {}
      return editing
        ? updateChannel(editing.id, { name, config, is_enabled: enabled })
        : createChannel({ name, type, config, is_enabled: enabled })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); onClose() },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Save failed'),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{editing ? 'Edit channel' : 'New channel'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <FInput label="Name" value={name} onChange={setName} placeholder="ops-email" />

          {!editing ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <div className="grid grid-cols-2 gap-2">
                {CHANNEL_TYPES.map(t => (
                  <button key={t.value} onClick={() => t.available && setType(t.value)} disabled={!t.available}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      type === t.value ? 'border-blue-500 bg-blue-50 text-blue-700' :
                      t.available ? 'border-slate-200 hover:border-slate-300 text-slate-700' :
                      'border-slate-100 text-slate-300 cursor-not-allowed'
                    }`}>
                    <span className={`inline-block w-2 h-2 rounded-full ${t.available ? 'bg-current' : 'bg-slate-200'}`} />
                    {t.label}
                    {!t.available && <span className="ml-auto text-xs text-slate-300">soon</span>}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <TypeBadge type={editing.type} />
            </div>
          )}

          {(editing?.type ?? type) === 'email' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Recipients</label>
              <textarea value={recipients} onChange={e => setRecipients(e.target.value)} rows={3}
                placeholder={"admin@example.com\nops@example.com"}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono" />
              <p className="text-xs text-slate-400 mt-1">One address per line</p>
            </div>
          )}

          <FToggle label="Enabled" checked={enabled} onChange={setEnabled} />
          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!name || save.isPending}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ChannelsTab() {
  const qc = useQueryClient()
  const [modal, setModal]             = useState<'new' | NotificationChannel | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [testStatus, setTestStatus]   = useState<Record<string, 'idle' | 'testing' | 'ok' | 'err'>>({})

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: fetchChannels,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteChannel(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); setConfirmDelete(null) },
  })

  async function handleTest(id: string) {
    setTestStatus(s => ({ ...s, [id]: 'testing' }))
    try {
      await testChannel(id)
      setTestStatus(s => ({ ...s, [id]: 'ok' }))
    } catch {
      setTestStatus(s => ({ ...s, [id]: 'err' }))
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Channels receive alert notifications. Assign them to alert rules.</p>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          Add channel
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <p className="text-slate-400 text-sm mb-3">No notification channels yet.</p>
          <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Add your first channel</button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Recipients / config</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="px-4 py-3 w-48"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {channels.map(ch => (
                <tr key={ch.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{ch.name}</td>
                  <td className="px-4 py-3"><TypeBadge type={ch.type} /></td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">{channelSummary(ch)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ch.is_enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                      {ch.is_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    {ch.type === 'email' && (
                      <button onClick={() => handleTest(ch.id)}
                        disabled={testStatus[ch.id] === 'testing'}
                        className={`text-xs ${testStatus[ch.id] === 'ok' ? 'text-green-600' : testStatus[ch.id] === 'err' ? 'text-red-500' : 'text-slate-400 hover:text-blue-600'}`}>
                        {testStatus[ch.id] === 'testing' ? 'Sending…' : testStatus[ch.id] === 'ok' ? 'Sent!' : testStatus[ch.id] === 'err' ? 'Failed' : 'Test'}
                      </button>
                    )}
                    <button onClick={() => setModal(ch)} className="text-xs text-blue-600 hover:underline">Edit</button>
                    {confirmDelete === ch.id ? (
                      <>
                        <button onClick={() => deleteMut.mutate(ch.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmDelete(ch.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && <ChannelModal editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  )
}

// ── Admin page ─────────────────────────────────────────────────────────────────

// ── Users tab ──────────────────────────────────────────────────────────────────

interface UserRecord {
  id: string; username: string; email: string; full_name: string | null
  role: string; is_active: boolean; last_login: string | null; created_at: string
}

const ROLES = ['readonly', 'operator', 'admin', 'superadmin'] as const
const ROLE_STYLE: Record<string, string> = {
  superadmin: 'bg-purple-100 text-purple-700',
  admin:      'bg-blue-100 text-blue-700',
  operator:   'bg-cyan-100 text-cyan-700',
  readonly:   'bg-slate-100 text-slate-600',
}

function fmtLoginAge(iso: string | null): string {
  if (!iso) return 'Never'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'Just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

interface UserModalProps {
  editing: UserRecord | null
  onClose: () => void
  currentUserId: string
}

function UserModal({ editing, onClose, currentUserId }: UserModalProps) {
  const qc = useQueryClient()
  const isNew = editing === null

  const [username,  setUsername]  = useState(editing?.username  ?? '')
  const [email,     setEmail]     = useState(editing?.email     ?? '')
  const [fullName,  setFullName]  = useState(editing?.full_name ?? '')
  const [role,      setRole]      = useState(editing?.role      ?? 'readonly')
  const [password,  setPassword]  = useState('')
  const [error,     setError]     = useState<string | null>(null)

  const isSelf = editing?.id === currentUserId

  const saveMut = useMutation({
    mutationFn: async () => {
      if (isNew) {
        return api.post('/users', { username, email, password, full_name: fullName || null, role })
      }
      const patch: Record<string, unknown> = { email, full_name: fullName || null }
      if (!isSelf) patch.role = role
      return api.patch(`/users/${editing!.id}`, patch)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); onClose() },
    onError:   (e: any) => setError(e?.response?.data?.detail ?? 'Save failed'),
  })

  const resetMut = useMutation({
    mutationFn: () => api.post(`/users/${editing!.id}/reset-password`, { new_password: password }),
    onSuccess:  () => { setPassword(''); setError(null); alert('Password updated') },
    onError:    (e: any) => setError(e?.response?.data?.detail ?? 'Reset failed'),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{isNew ? 'New user' : `Edit ${editing!.username}`}</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-3">
          {isNew && (
            <FInput label="Username" value={username} onChange={setUsername} placeholder="jsmith" />
          )}
          <FInput label="Email" value={email} onChange={setEmail} type="email" placeholder="j.smith@example.com" />
          <FInput label="Full name" value={fullName} onChange={setFullName} placeholder="Jane Smith" />

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value)}
              disabled={isSelf}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {isSelf && <p className="text-[10px] text-slate-400 mt-1">Cannot change your own role</p>}
          </div>

          {isNew && (
            <FInput label="Password" value={password} onChange={setPassword} type="password" placeholder="Min. 8 characters" />
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-6 pb-5 flex items-center justify-between gap-3">
          {!isNew && (
            <div className="flex items-center gap-2 flex-1">
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="New password…"
                className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => password.length >= 8 ? resetMut.mutate() : setError('Password must be at least 8 characters')}
                disabled={resetMut.isPending}
                className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition-colors disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          )}
          <div className="flex gap-2 shrink-0 ml-auto">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {saveMut.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UsersTab() {
  const qc = useQueryClient()
  const [modal, setModal] = useState<'new' | UserRecord | null>(null)

  const { data: users = [], isLoading } = useQuery<UserRecord[]>({
    queryKey: ['users'],
    queryFn:  () => api.get<UserRecord[]>('/users').then(r => r.data),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn:  () => api.get<{ id: string; username: string; role: string }>('/auth/me').then(r => r.data),
  })

  const toggleMut = useMutation({
    mutationFn: (u: UserRecord) => api.patch(`/users/${u.id}`, { is_active: !u.is_active }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Users</h2>
          <p className="text-xs text-slate-400 mt-0.5">Manage who has access to this tenant</p>
        </div>
        <button
          onClick={() => setModal('new')}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          New user
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">User</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Role</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Last login</th>
                <th className="text-left px-4 py-2.5 font-medium text-slate-600">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{u.username}</div>
                    <div className="text-xs text-slate-400">{u.full_name ?? u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${ROLE_STYLE[u.role] ?? ROLE_STYLE.readonly}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{fmtLoginAge(u.last_login)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setModal(u)}
                        className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </button>
                      {u.id !== me?.id && (
                        <button
                          onClick={() => toggleMut.mutate(u)}
                          disabled={toggleMut.isPending}
                          className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${u.is_active ? 'text-slate-400 hover:text-amber-600 hover:bg-amber-50' : 'text-slate-400 hover:text-green-600 hover:bg-green-50'}`}
                          title={u.is_active ? 'Deactivate' : 'Activate'}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            {u.is_active
                              ? <path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
                              : <path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                            }
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal !== null && (
        <UserModal
          editing={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          currentUserId={me?.id ?? ''}
        />
      )}
    </div>
  )
}

// ── Platform settings tab ──────────────────────────────────────────────────────

interface PlatformSettings {
  base_url:                       string
  platform_name:                  string
  timezone:                       string
  session_timeout_hours:          number
  alert_eval_interval_s:          number
  default_renotify_s:             number
  max_alerts_per_device_per_hour: number
  auto_close_stale_days:          number
  notifications_paused:           boolean
  notifications_paused_until:     string | null
  business_hours_enabled:         boolean
  business_hours_start:           number
  business_hours_end:             number
  business_days:                  number[]
  alert_retention_days:           number
  abuseipdb_api_key:              string
}

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

function PlatformTab() {
  const qc = useQueryClient()
  const [f, setF] = useState<PlatformSettings | null>(null)
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery<PlatformSettings>({
    queryKey: ['platform-settings'],
    queryFn:  () => api.get<PlatformSettings>('/admin/settings/platform').then(r => r.data),
  })

  useEffect(() => { if (data) setF(data) }, [data])

  const saveMut = useMutation({
    mutationFn: () => api.put('/admin/settings/platform', f),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['platform-settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) =>
    setF(p => p ? { ...p, [k]: v } : p)

  if (isLoading || !f) return <div className="p-6 text-slate-400 text-sm">Loading…</div>

  const numInput = (k: keyof PlatformSettings, placeholder = '') => (
    <input type="number" value={String(f[k])} placeholder={placeholder}
      onChange={e => set(k as any, Number(e.target.value))}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  )

  const textInput = (k: keyof PlatformSettings, placeholder = '', type = 'text') => (
    <input type={type} value={String(f[k])} placeholder={placeholder}
      onChange={e => set(k as any, e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
  )

  return (
    <div className="p-6 max-w-3xl overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Platform Configuration</h2>
          <p className="text-xs text-slate-400 mt-0.5">Global settings that apply across the entire installation</p>
        </div>
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className={`px-4 py-2 text-xs font-medium rounded-xl transition-colors disabled:opacity-50 ${
            saved ? 'bg-green-600 text-white' : 'bg-slate-800 text-white hover:bg-slate-700'
          }`}>
          {saved ? 'Saved!' : saveMut.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {/* General */}
      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">General</h3>
        <SettingRow label="Application URL"
          description="Base URL for deep links in alert emails. Include protocol, no trailing slash.">
          {textInput('base_url', 'https://anthrimon.lab.local', 'url')}
        </SettingRow>
        <SettingRow label="Platform name"
          description="Display name used in email notifications and templates.">
          {textInput('platform_name', 'Anthrimon')}
        </SettingRow>
        <SettingRow label="Timezone"
          description="IANA timezone used for timestamps in alert emails (e.g. Europe/London, America/New_York).">
          {textInput('timezone', 'UTC')}
        </SettingRow>
      </div>

      {/* Session & security */}
      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Session &amp; Security</h3>
        <SettingRow label="Session timeout"
          description="How long a login session stays valid. Takes effect on next login.">
          <div className="flex items-center gap-2">
            {numInput('session_timeout_hours')}
            <span className="text-xs text-slate-400 shrink-0">hours</span>
          </div>
        </SettingRow>
      </div>

      {/* Notifications */}
      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Notifications</h3>
        <SettingRow label="Pause all notifications"
          badge={f.notifications_paused ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Active</span> : undefined}
          description="Temporarily silence all outgoing alert notifications globally.">
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
        <SettingRow label="Business hours only"
          description="Send notifications only during configured hours. Resolved alerts always send.">
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
                  {DAY_LABELS.map((d, i) => (
                    <button key={i} type="button"
                      onClick={() => {
                        const days = f.business_days.includes(i)
                          ? f.business_days.filter(x => x !== i)
                          : [...f.business_days, i].sort()
                        set('business_days', days)
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                        f.business_days.includes(i)
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}>
                      {d}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </SettingRow>
      </div>

      {/* Alerting engine */}
      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Alerting Engine</h3>
        <SettingRow label="Evaluation interval"
          description="How often the alert engine checks all rules. Requires API restart to take effect.">
          <div className="flex items-center gap-2">
            {numInput('alert_eval_interval_s')}
            <span className="text-xs text-slate-400 shrink-0">seconds</span>
          </div>
        </SettingRow>
        <SettingRow label="Default re-notify interval"
          description="Default interval for re-alerting on active alerts when creating new rules.">
          <div className="flex items-center gap-2">
            <input type="number" value={Math.round(f.default_renotify_s / 60)}
              onChange={e => set('default_renotify_s', Number(e.target.value) * 60)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <span className="text-xs text-slate-400 shrink-0">minutes</span>
          </div>
        </SettingRow>
        <SettingRow label="Storm protection"
          description="Maximum new alerts per device per hour. Prevents alert storms. Set to 0 to disable.">
          <div className="flex items-center gap-2">
            {numInput('max_alerts_per_device_per_hour', '0 = unlimited')}
            <span className="text-xs text-slate-400 shrink-0">/hr</span>
          </div>
        </SettingRow>
        <SettingRow label="Stale alert auto-close"
          description="Auto-close open/acknowledged alerts with no activity after this many days. Set to 0 to disable.">
          <div className="flex items-center gap-2">
            {numInput('auto_close_stale_days', '0 = disabled')}
            <span className="text-xs text-slate-400 shrink-0">days</span>
          </div>
        </SettingRow>
      </div>

      {/* Data */}
      <div className="bg-white rounded-2xl border border-slate-200 px-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Data</h3>
        <SettingRow label="Alert retention"
          description="Days to keep resolved and closed alerts before they are eligible for purging.">
          <div className="flex items-center gap-2">
            {numInput('alert_retention_days')}
            <span className="text-xs text-slate-400 shrink-0">days</span>
          </div>
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Threat Intelligence</h3>
        <SettingRow label="AbuseIPDB API key"
          description="Used to score IPs in flow data. Free key at abuseipdb.com — 1 000 checks/day. Leave blank to disable.">
          {textInput('abuseipdb_api_key', 'Paste API key here', 'password')}
        </SettingRow>
      </div>

      {saveMut.isError && (
        <p className="mt-3 text-xs text-red-500">
          {(saveMut.error as any)?.response?.data?.detail ?? 'Failed to save settings'}
        </p>
      )}
    </div>
  )
}

// ── Email template tab ─────────────────────────────────────────────────────────

interface EmailTemplate { subject: string; html: string }
interface EmailTemplateStatus { metric: string; label: string; is_custom: boolean; subject: string; html: string }

const TEMPLATE_VARS = [
  { name: 'title',          desc: 'Full alert title' },
  { name: 'tag',            desc: 'CRITICAL / RESOLVED' },
  { name: 'severity',       desc: 'critical / major / minor…' },
  { name: 'severity_color', desc: 'Hex colour for severity' },
  { name: 'metric',         desc: 'Alert metric type' },
  { name: 'rule_name',      desc: 'Alert rule name' },
  { name: 'description',    desc: 'Rule description' },
  { name: 'device_name',    desc: 'Device hostname' },
  { name: 'value',          desc: 'Current metric value' },
  { name: 'threshold',      desc: 'Rule threshold' },
  { name: 'interface_name', desc: 'Interface name (interface alerts)' },
  { name: 'prefix',         desc: 'Route prefix (route_missing)' },
  { name: 'neighbor',      desc: 'OSPF neighbor (ospf_state)' },
  { name: 'triggered_at',   desc: 'Time alert fired' },
  { name: 'resolved_at',    desc: 'Time alert resolved' },
  { name: 'alert_url',      desc: 'Deep-link to alert detail' },
  { name: 'platform_name',  desc: 'Platform name from settings' },
]

const PREVIEW_CTX_BASE: Record<string, string> = {
  tag: 'CRITICAL', severity: 'critical', severity_color: '#dc2626',
  rule_name: 'Lab test rule', description: 'Lab alert rule for testing',
  device_name: 'coresw.lab.local',
  triggered_at: '2026-05-10 02:45 UTC', resolved_at: '—',
  alert_url: '#', alert_id: '00000000-0000-0000-0000-000000000000',
  platform_name: 'Anthrimon',
}

const PREVIEW_CTX_BY_METRIC: Record<string, Record<string, string>> = {
  default:          { ...PREVIEW_CTX_BASE, metric: '', title: 'coresw: CPU 94.2%', value: '94.2', threshold: '90' },
  cpu_util_pct:     { ...PREVIEW_CTX_BASE, metric: 'cpu_util_pct', title: 'coresw: CPU 94.2%', value: '94.2', threshold: '90', interface_name: '', prefix: '', neighbor: '' },
  mem_util_pct:     { ...PREVIEW_CTX_BASE, metric: 'mem_util_pct', title: 'coresw: Memory 88%', value: '88', threshold: '85', interface_name: '', prefix: '', neighbor: '' },
  device_down:      { ...PREVIEW_CTX_BASE, metric: 'device_down', title: 'coresw.lab.local: device unreachable', value: '—', threshold: '—', interface_name: '', prefix: '', neighbor: '' },
  interface_down:   { ...PREVIEW_CTX_BASE, metric: 'interface_down', title: 'coresw: Gi0/1 down', value: '—', threshold: '—', interface_name: 'GigabitEthernet0/1', prefix: '', neighbor: '' },
  interface_flap:   { ...PREVIEW_CTX_BASE, metric: 'interface_flap', title: 'coresw: Gi0/1 flapping', value: '5', threshold: '3', interface_name: 'GigabitEthernet0/1', prefix: '', neighbor: '' },
  route_missing:    { ...PREVIEW_CTX_BASE, metric: 'route_missing', title: 'route 10.0.0.0/8 missing', value: '—', threshold: '—', interface_name: '', prefix: '10.0.0.0/8', neighbor: '' },
  ospf_state:       { ...PREVIEW_CTX_BASE, metric: 'ospf_state', title: 'OSPF neighbor 192.168.1.2 not full', value: '—', threshold: '—', interface_name: '', prefix: '', neighbor: '192.168.1.2' },
  temperature:      { ...PREVIEW_CTX_BASE, metric: 'temperature', title: 'coresw: temperature 78°C', value: '78', threshold: '70', interface_name: '', prefix: '', neighbor: '' },
  interface_errors: { ...PREVIEW_CTX_BASE, metric: 'interface_errors', title: 'coresw: interface errors (342)', value: '342', threshold: '100', interface_name: 'GigabitEthernet0/2', prefix: '', neighbor: '' },
  interface_util_pct: { ...PREVIEW_CTX_BASE, metric: 'interface_util_pct', title: 'coresw: bandwidth 92%', value: '92', threshold: '80', interface_name: 'GigabitEthernet0/0', prefix: '', neighbor: '' },
  uptime:           { ...PREVIEW_CTX_BASE, metric: 'uptime', title: 'coresw rebooted (uptime 45s)', value: '45', threshold: '300', interface_name: '', prefix: '', neighbor: '' },
  custom_oid:       { ...PREVIEW_CTX_BASE, metric: 'custom_oid', title: 'Custom OID alert', value: '42', threshold: '10', interface_name: '', prefix: '', neighbor: '' },
}

function renderPreview(template: string, metric: string): string {
  const ctx = PREVIEW_CTX_BY_METRIC[metric] ?? PREVIEW_CTX_BY_METRIC['default']
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? `{{${k}}}`)
}

const METRIC_LABELS: Record<string, string> = {
  default:          'Default (all types)',
  device_down:      'Device unreachable',
  interface_down:   'Interface down',
  interface_flap:   'Interface flapping',
  uptime:           'Device rebooted',
  temperature:      'Temperature high',
  cpu_util_pct:     'CPU utilisation',
  mem_util_pct:     'Memory utilisation',
  interface_errors: 'Interface errors',
  interface_util_pct: 'Interface utilisation',
  ospf_state:       'OSPF neighbor issue',
  route_missing:    'Route missing',
  custom_oid:       'Custom OID',
}

function EmailTemplateTab() {
  const qc = useQueryClient()
  const [selectedMetric, setSelectedMetric] = useState('default')
  const [subject, setSubject] = useState('')
  const [html,    setHtml]    = useState('')
  const [saved,   setSaved]   = useState(false)

  // Load all templates for sidebar status
  const { data: allTemplates = [] } = useQuery<EmailTemplateStatus[]>({
    queryKey: ['email-templates-all'],
    queryFn:  () => api.get<EmailTemplateStatus[]>('/admin/settings/email-templates').then(r => r.data),
  })

  // Load the selected template
  const url = selectedMetric === 'default'
    ? '/admin/settings/email-template'
    : `/admin/settings/email-templates/${selectedMetric}`

  const { data, isLoading } = useQuery<EmailTemplate>({
    queryKey: ['email-template', selectedMetric],
    queryFn:  () => api.get<EmailTemplate>(url).then(r => r.data),
  })

  useEffect(() => {
    if (data) { setSubject(data.subject); setHtml(data.html) }
  }, [data])

  const saveMut = useMutation({
    mutationFn: () => api.put(url, { subject, html }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['email-template', selectedMetric] })
      qc.invalidateQueries({ queryKey: ['email-templates-all'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const resetMut = useMutation({
    mutationFn: () => selectedMetric === 'default'
      ? api.delete('/admin/settings/email-template')
      : api.delete(`/admin/settings/email-templates/${selectedMetric}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['email-template', selectedMetric] })
      qc.invalidateQueries({ queryKey: ['email-templates-all'] })
    },
  })

  const statusByMetric = Object.fromEntries(allTemplates.map(t => [t.metric, t]))
  const allMetrics = ['default', ...Object.keys(METRIC_LABELS).filter(k => k !== 'default')]

  if (isLoading) return <div className="p-6 text-slate-400 text-sm">Loading…</div>

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar — metric selector */}
      <div className="w-48 shrink-0 border-r border-slate-200 bg-slate-50 overflow-y-auto flex flex-col">
        <div className="px-3 py-2.5 border-b border-slate-200">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Alert type</p>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {allMetrics.map(metric => {
            const status = metric === 'default' ? null : statusByMetric[metric]
            const isCustom = metric === 'default'
              ? false  // default is always "the default"
              : status?.is_custom ?? false
            return (
              <button
                key={metric}
                onClick={() => setSelectedMetric(metric)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between gap-1 transition-colors ${
                  selectedMetric === metric
                    ? 'bg-white text-slate-800 border-r-2 border-blue-500'
                    : 'text-slate-600 hover:bg-white hover:text-slate-800'
                }`}
              >
                <span className="text-xs truncate">{METRIC_LABELS[metric] ?? metric}</span>
                {isCustom && (
                  <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-blue-100 text-blue-600 shrink-0">custom</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Editor pane */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-white shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-slate-500 shrink-0">Subject</span>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0"
              placeholder="[{{tag}}] {{title}}"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {selectedMetric !== 'default' && statusByMetric[selectedMetric]?.is_custom && (
              <button
                onClick={() => { if (confirm('Reset to default for this alert type?')) resetMut.mutate() }}
                disabled={resetMut.isPending}
                className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Reset
              </button>
            )}
            {selectedMetric === 'default' && (
              <button
                onClick={() => { if (confirm('Reset default template?')) resetMut.mutate() }}
                disabled={resetMut.isPending}
                className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Reset
              </button>
            )}
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                saved ? 'bg-green-600 text-white' : 'bg-slate-800 text-white hover:bg-slate-700'
              } disabled:opacity-50`}
            >
              {saved ? 'Saved!' : saveMut.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* Split pane */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
          {/* Editor */}
          <div className="w-full md:w-1/2 flex flex-col border-b md:border-b-0 md:border-r border-slate-200 min-h-0" style={{ minHeight: 300 }}>
            <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">HTML</span>
              <span className="text-[10px] text-slate-400">{html.length} chars</span>
            </div>
            <textarea
              value={html}
              onChange={e => setHtml(e.target.value)}
              spellCheck={false}
              className="flex-1 w-full p-4 font-mono text-xs bg-slate-950 text-green-400 resize-none focus:outline-none leading-relaxed"
              style={{ tabSize: 2 }}
            />
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 shrink-0">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Variables</p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARS.map(v => (
                  <button
                    key={v.name}
                    title={v.desc}
                    onClick={() => setHtml(h => h + `{{${v.name}}}`)}
                    className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded hover:bg-blue-100 hover:text-blue-700 transition-colors"
                  >
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="w-full md:w-1/2 flex flex-col min-h-0" style={{ minHeight: 280 }}>
            <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Preview</span>
              <span className="text-[10px] text-slate-400">{METRIC_LABELS[selectedMetric] ?? selectedMetric}</span>
            </div>
            <iframe
              srcDoc={renderPreview(html, selectedMetric)}
              sandbox="allow-same-origin"
              className="flex-1 w-full border-none bg-white"
              title="Email preview"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

type Tab = 'platform' | 'smtp' | 'channels' | 'users' | 'template' | 'data'

export default function AdminPage() {
  const role = useRole()
  const [tab, setTab] = useState<Tab>('platform')

  useQuery({ queryKey: ['smtp-settings'], queryFn: fetchSmtpSettings })
  useQuery({ queryKey: ['channels'],      queryFn: fetchChannels })

  if (!hasRole(role, 'admin')) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-slate-300 text-4xl mb-3">🔒</div>
          <p className="text-slate-600 font-medium">Access restricted</p>
          <p className="text-slate-400 text-sm mt-1">Administration requires admin role or higher.</p>
        </div>
      </div>
    )
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'platform', label: 'Platform' },
    { id: 'smtp',     label: 'SMTP Server' },
    { id: 'channels', label: 'Notification Channels' },
    { id: 'users',    label: 'Users' },
    { id: 'template', label: 'Email Template' },
    { id: 'data',     label: 'Data' },
  ]

  return (
    <div className={tab === 'template' ? 'flex flex-col h-screen' : ''}>
      <div className="px-6 py-4 border-b border-slate-200 bg-white shrink-0">
        <h1 className="text-base font-semibold text-slate-800">Administration</h1>
      </div>

      <div className="bg-white border-b border-slate-200 px-6 shrink-0">
        <nav className="flex gap-1 -mb-px">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'platform' && <PlatformTab />}
      {tab === 'smtp'     && <SmtpTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'users'    && <UsersTab />}
      {tab === 'template' && <EmailTemplateTab />}
      {tab === 'data'     && <DataTab />}
    </div>
  )
}

// ── Data management tab ────────────────────────────────────────────────────────

interface DataStats {
  alerts:  { count: number; size: string; oldest: string|null; retention_days: number }
  flow:    { rows: number;  size: string; oldest: string|null; retention_days: number }
  syslog:  { rows: number;  size: string; oldest: string|null; retention_days: number }
  config:  { backup_count: number; size: string }
}

function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n/1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`
  return String(n)
}

function fmtAge(iso: string|null): string {
  if (!iso) return '—'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  return d === 0 ? 'today' : `${d}d ago`
}

function RetentionCard({ title, description, icon, stats, onSave, saving }: {
  title: string
  description: string
  icon: React.ReactNode
  stats: { label: string; value: string }[]
  onSave: (days: number) => void
  saving: boolean
}) {
  const currentDays = stats.find(s => s.label === 'Retention')?.value.replace(' days', '') ?? '90'
  const [days, setDays] = React.useState(currentDays)

  // sync if stats update
  React.useEffect(() => {
    setDays(stats.find(s => s.label === 'Retention')?.value.replace(' days', '') ?? '90')
  }, [stats])

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6">
      <div className="flex items-start gap-4 mb-5">
        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0 text-slate-500">
          {icon}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{description}</p>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {stats.map(s => (
          <div key={s.label} className="bg-slate-50 rounded-xl px-3 py-2.5">
            <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">{s.label}</p>
            <p className="text-sm font-bold text-slate-700 mt-0.5 tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Retention control */}
      <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
        <label className="text-xs font-medium text-slate-600 shrink-0">Retention</label>
        <div className="flex items-center gap-2 flex-1">
          <input
            type="number" min={1} max={3650}
            value={days}
            onChange={e => setDays(e.target.value)}
            className="w-20 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-sm text-slate-500">days</span>
        </div>
        <button
          onClick={() => onSave(Number(days))}
          disabled={saving || Number(days) < 1}
          className="px-4 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50 shrink-0"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function DataTab() {
  const qc = useQueryClient()

  const { data: stats, isLoading } = useQuery<DataStats>({
    queryKey:        ['data-stats'],
    queryFn:         () => api.get<DataStats>('/admin/data/stats').then(r => r.data),
    refetchInterval: 60_000,
  })

  const makeMut = (url: string) => useMutation({
    mutationFn: (days: number) => api.put(url, { retention_days: days }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['data-stats'] }),
  })

  const alertMut  = makeMut('/admin/data/retention/alerts')
  const flowMut   = makeMut('/admin/data/retention/flow')
  const syslogMut = makeMut('/admin/data/retention/syslog')

  if (isLoading || !stats) {
    return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  }

  const sections = [
    {
      title: 'Alerts',
      description: 'Open, resolved, and expired alerts stored in PostgreSQL',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
      stats: [
        { label: 'Records',   value: fmtNum(stats.alerts.count) },
        { label: 'Size',      value: stats.alerts.size },
        { label: 'Oldest',    value: fmtAge(stats.alerts.oldest) },
        { label: 'Retention', value: `${stats.alerts.retention_days} days` },
      ],
      onSave: (d: number) => alertMut.mutate(d),
      saving: alertMut.isPending,
    },
    {
      title: 'Flow data',
      description: 'NetFlow / sFlow / IPFIX records stored in ClickHouse',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
      stats: [
        { label: 'Records',   value: fmtNum(stats.flow.rows) },
        { label: 'Size',      value: stats.flow.size },
        { label: 'Oldest',    value: fmtAge(stats.flow.oldest) },
        { label: 'Retention', value: `${stats.flow.retention_days} days` },
      ],
      onSave: (d: number) => flowMut.mutate(d),
      saving: flowMut.isPending,
    },
    {
      title: 'Syslog',
      description: 'RFC 3164 / RFC 5424 messages stored in ClickHouse',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h6"/></svg>,
      stats: [
        { label: 'Records',   value: fmtNum(stats.syslog.rows) },
        { label: 'Size',      value: stats.syslog.size },
        { label: 'Oldest',    value: fmtAge(stats.syslog.oldest) },
        { label: 'Retention', value: `${stats.syslog.retention_days} days` },
      ],
      onSave: (d: number) => syslogMut.mutate(d),
      saving: syslogMut.isPending,
    },
    {
      title: 'Config backups',
      description: 'Device running-config snapshots stored in PostgreSQL',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
      stats: [
        { label: 'Backups', value: fmtNum(stats.config.backup_count) },
        { label: 'Size',    value: stats.config.size },
      ],
    },
  ]

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Data management</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          View storage usage and configure retention periods. Changes to ClickHouse TTLs take effect on the next background merge.
        </p>
      </div>

      {sections.map(s => (
        <RetentionCard
          key={s.title}
          title={s.title}
          description={s.description}
          icon={s.icon}
          stats={s.stats}
          onSave={s.onSave ?? (() => {})}
          saving={s.saving ?? false}
        />
      ))}
    </div>
  )
}
