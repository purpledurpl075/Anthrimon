import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchCredentials, createCredential, updateCredential, deleteCredential, type Credential } from '../api/credentials'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { SkeletonTable } from '../components/Skeleton'

// ── Type metadata ──────────────────────────────────────────────────────────────

const TYPE_META: Record<string, { label: string; colour: string }> = {
  snmp_v2c:  { label: 'SNMP v2c',  colour: 'bg-blue-100 text-blue-700' },
  snmp_v3:   { label: 'SNMP v3',   colour: 'bg-indigo-100 text-indigo-700' },
  ssh:       { label: 'SSH',       colour: 'bg-green-100 text-green-700' },
  gnmi_tls:  { label: 'gNMI TLS', colour: 'bg-purple-100 text-purple-700' },
  api_token: { label: 'API Token', colour: 'bg-orange-100 text-orange-700' },
  netconf:   { label: 'NETCONF',   colour: 'bg-teal-100 text-teal-700' },
}

const ALL_TYPES = Object.keys(TYPE_META)

function TypeBadge({ type }: { type: string }) {
  const m = TYPE_META[type] ?? { label: type, colour: 'bg-slate-100 text-slate-600' }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.colour}`}>{m.label}</span>
}

function dataSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'snmp_v2c':  return `community: ${data.community ?? '—'}`
    case 'snmp_v3': {
      const level = String(data.security_level ?? 'authPriv')
      const proto = level === 'noAuthNoPriv' ? 'no auth' : `${data.auth_protocol ?? 'SHA'}${level === 'authPriv' ? `+${data.priv_protocol ?? 'AES'}` : ''}`
      return `user: ${data.username ?? '—'} · ${proto}`
    }
    case 'ssh':       return `user: ${data.username ?? '—'}${data.private_key ? ' · key' : ' · password'}`
    case 'gnmi_tls':  return data.skip_verify ? 'skip verify' : 'verified TLS'
    case 'api_token': return data.base_url ? String(data.base_url) : 'token set'
    case 'netconf':   return `user: ${data.username ?? '—'} · port: ${data.port ?? 830}`
    default:          return ''
  }
}

// ── Reusable form controls ─────────────────────────────────────────────────────

function FInput({ label, value, onChange, type = 'text', placeholder, required, mono }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; required?: boolean; mono?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}

function FSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function FTextarea({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={4}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
    </div>
  )
}

// ── Type-specific data forms ───────────────────────────────────────────────────

function DataForm({ type, data, onChange }: {
  type: string; data: Record<string, unknown>; onChange: (d: Record<string, unknown>) => void
}) {
  const set = (key: string, val: unknown) => onChange({ ...data, [key]: val })
  const str = (key: string) => String(data[key] ?? '')

  switch (type) {
    case 'snmp_v2c':
      return <FInput label="Community string" value={str('community')} onChange={v => set('community', v)} required />

    case 'snmp_v3': {
      const level = str('security_level') || 'authPriv'
      const hasAuth = level === 'authNoPriv' || level === 'authPriv'
      const hasPriv = level === 'authPriv'
      return (
        <div className="space-y-3">
          <FInput label="Username" value={str('username')} onChange={v => set('username', v)} required />

          <FSelect label="Security level" value={level}
            onChange={v => {
              const next: Record<string, unknown> = { ...data, security_level: v }
              if (v === 'noAuthNoPriv') { delete next.auth_protocol; delete next.auth_key; delete next.priv_protocol; delete next.priv_key }
              if (v === 'authNoPriv')   { delete next.priv_protocol; delete next.priv_key }
              if (v === 'authNoPriv' || v === 'authPriv') { if (!next.auth_protocol) next.auth_protocol = 'SHA256' }
              if (v === 'authPriv')     { if (!next.priv_protocol) next.priv_protocol = 'AES' }
              onChange(next)
            }}
            options={[
              { value: 'noAuthNoPriv', label: 'noAuthNoPriv — no authentication, no encryption' },
              { value: 'authNoPriv',   label: 'authNoPriv — authenticated, no encryption' },
              { value: 'authPriv',     label: 'authPriv — authenticated + encrypted' },
            ]}
          />

          {hasAuth && (
            <div className="grid grid-cols-2 gap-3">
              <FSelect label="Auth protocol" value={str('auth_protocol') || 'SHA'}
                onChange={v => set('auth_protocol', v)}
                options={[{value:'MD5',label:'MD5'},{value:'SHA',label:'SHA-1'},{value:'SHA256',label:'SHA-256'},{value:'SHA512',label:'SHA-512'}]} />
              <FInput label="Auth key (min 8 chars)" value={str('auth_key')} onChange={v => set('auth_key', v)} type="password" required />
            </div>
          )}

          {hasPriv && (
            <div className="grid grid-cols-2 gap-3">
              <FSelect label="Priv protocol" value={str('priv_protocol') || 'AES'}
                onChange={v => set('priv_protocol', v)}
                options={[{value:'DES',label:'DES'},{value:'AES',label:'AES-128'},{value:'AES192',label:'AES-192'},{value:'AES256',label:'AES-256'}]} />
              <FInput label="Priv key (min 8 chars)" value={str('priv_key')} onChange={v => set('priv_key', v)} type="password" required />
            </div>
          )}
        </div>
      )
    }

    case 'ssh':
      return (
        <div className="space-y-3">
          <FInput label="Username" value={str('username')} onChange={v => set('username', v)} required />
          <FInput label="Password" value={str('password')} onChange={v => set('password', v)} type="password" placeholder="Optional if using private key" />
          <FTextarea label="Private key (PEM)" value={str('private_key')} onChange={v => set('private_key', v)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          <FInput label="Key passphrase" value={str('passphrase')} onChange={v => set('passphrase', v)} type="password" placeholder="Optional" />
        </div>
      )

    case 'gnmi_tls':
      return (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={!!data.skip_verify} onChange={e => set('skip_verify', e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            Skip TLS verification (insecure — dev/lab only)
          </label>
          <FTextarea label="CA certificate (PEM)" value={str('ca_cert')} onChange={v => set('ca_cert', v)} placeholder="-----BEGIN CERTIFICATE-----" />
          <FTextarea label="Client certificate (PEM)" value={str('client_cert')} onChange={v => set('client_cert', v)} placeholder="-----BEGIN CERTIFICATE-----" />
          <FTextarea label="Client key (PEM)" value={str('client_key')} onChange={v => set('client_key', v)} placeholder="-----BEGIN PRIVATE KEY-----" />
        </div>
      )

    case 'api_token':
      return (
        <div className="space-y-3">
          <FInput label="Token" value={str('token')} onChange={v => set('token', v)} type="password" required />
          <FInput label="Base URL" value={str('base_url')} onChange={v => set('base_url', v)} placeholder="https://device.example.com" />
        </div>
      )

    case 'netconf':
      return (
        <div className="space-y-3">
          <FInput label="Username" value={str('username')} onChange={v => set('username', v)} required />
          <FInput label="Password" value={str('password')} onChange={v => set('password', v)} type="password" required />
          <FInput label="Port" value={str('port') || '830'} onChange={v => set('port', Number(v))} type="number" />
        </div>
      )

    default:
      return <p className="text-sm text-slate-400">Select a credential type above.</p>
  }
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateCredentialData(type: string, data: Record<string, unknown>): string | null {
  const str = (k: string) => String(data[k] ?? '').trim()
  switch (type) {
    case 'snmp_v2c':
      if (!str('community')) return 'Community string is required'
      break
    case 'snmp_v3': {
      if (!str('username')) return 'Username is required'
      const level = str('security_level') || 'authPriv'
      if (level !== 'noAuthNoPriv') {
        if (!str('auth_key')) return 'Auth key is required'
        if (str('auth_key').length < 8) return 'Auth key must be at least 8 characters'
      }
      if (level === 'authPriv') {
        if (!str('priv_key')) return 'Priv key is required'
        if (str('priv_key').length < 8) return 'Priv key must be at least 8 characters'
      }
      break
    }
    case 'ssh':
      if (!str('username')) return 'Username is required'
      if (!str('password') && !str('private_key')) return 'A password or private key is required'
      break
    case 'api_token':
      if (!str('token')) return 'Token is required'
      break
    case 'netconf':
      if (!str('username')) return 'Username is required'
      if (!str('password')) return 'Password is required'
      break
  }
  return null
}

function apiError(e: any): string {
  const detail = e?.response?.data?.detail
  if (Array.isArray(detail)) return detail.map((d: any) => d?.msg ?? String(d)).join('; ')
  if (typeof detail === 'string') return detail
  return e?.message ?? 'Save failed'
}

// ── Add / edit modal ───────────────────────────────────────────────────────────

function CredentialModal({ editing, onClose }: { editing: Credential | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(editing?.name ?? '')
  const [type, setType] = useState(editing?.type ?? 'snmp_v2c')
  const [data, setData] = useState<Record<string, unknown>>(editing?.data ?? {})
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () => editing
      ? updateCredential(editing.id, { name, data })
      : createCredential({ name, type, data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials-all'] }); onClose() },
    onError: (e: any) => setError(apiError(e)),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">{editing ? 'Edit credential' : 'New credential'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          <FInput label="Name" value={name} onChange={setName} placeholder="lab-snmpv3-core" required />

          {!editing ? (
            <FSelect label="Type" value={type} onChange={t => {
              setType(t)
              setData(t === 'snmp_v3'
                ? { security_level: 'authPriv', auth_protocol: 'SHA256', priv_protocol: 'AES' }
                : {})
            }}
              options={ALL_TYPES.map(t => ({ value: t, label: TYPE_META[t]?.label ?? t }))} />
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <TypeBadge type={editing.type} />
            </div>
          )}

          <div className="border-t border-slate-100 pt-4">
            <DataForm type={editing?.type ?? type} data={data} onChange={setData} />
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => {
              if (!name.trim()) { setError('Name is required'); return }
              const err = validateCredentialData(editing?.type ?? type, data)
              if (err) { setError(err); return }
              save.mutate()
            }} disabled={save.isPending}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CredentialsPage() {
  const qc = useQueryClient()
  const role = useRole()
  const canWrite  = hasRole(role, 'operator')
  const canDelete = hasRole(role, 'admin')
  const [modal, setModal] = useState<'new' | Credential | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: creds = [], isLoading } = useQuery({
    queryKey: ['credentials-all'],
    queryFn: () => fetchCredentials(true),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteCredential(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials-all'] }); setConfirmDelete(null) },
  })

  return (
    <div>
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <h1 className="text-base font-semibold text-slate-800">Credentials</h1>
        {canWrite && (
          <button onClick={() => setModal('new')}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Add credential
          </button>
        )}
      </div>

      <div className="p-6">
        {isLoading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : creds.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <p className="text-slate-400 text-sm mb-3">No credentials yet.</p>
            <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Add your first credential</button>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-600">Details</th>
                  <th className="px-4 py-3 w-28"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {creds.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{c.name}</td>
                    <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                    <td className="px-4 py-3 text-xs text-slate-400">{dataSummary(c.type, c.data)}</td>
                    <td className="px-4 py-3 text-right space-x-3">
                      {canWrite && <button onClick={() => setModal(c)} className="text-xs text-blue-600 hover:underline">Edit</button>}
                      {canDelete && (confirmDelete === c.id ? (
                        <>
                          <button onClick={() => deleteMut.mutate(c.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                          <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDelete(c.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && <CredentialModal editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  )
}
