import React, { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { fetchSmtpSettings, saveSmtpSettings, testSmtpSettings } from '../api/admin'
import { fetchChannels, createChannel, updateChannel, deleteChannel, testChannel, fetchChannelSendLog, type NotificationChannel, type ChannelSendLogEntry } from '../api/channels'
import api from '../api/client'
import { useRole, hasRole, useCurrentUser } from '../hooks/useCurrentUser'

function apiError(e: any): string {
  const detail = e?.response?.data?.detail
  if (Array.isArray(detail)) return detail.map((d: any) => d?.msg ?? String(d)).join('; ')
  if (typeof detail === 'string') return detail
  return e?.message ?? 'Save failed'
}

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
    mutationFn: () => {
      if (!host.trim()) throw new Error('Host is required')
      if (!fromAddr.trim()) throw new Error('From address is required')
      const portNum = Number(port)
      if (!port || isNaN(portNum) || portNum < 1 || portNum > 65535) throw new Error('Port must be between 1 and 65535')
      return saveSmtpSettings({ host, port: portNum, user, password: password || null, from_addr: fromAddr, ssl })
    },
    onMutate: () => { setStatus('saving'); setErrMsg('') },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['smtp-settings'] }); setStatus('saved'); setPassword('') },
    onError: (e: any) => { setStatus('error'); setErrMsg(apiError(e)) },
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
  { value: 'email',     label: 'Email',     available: true, colour: 'bg-green-100 text-green-700' },
  { value: 'slack',     label: 'Slack',     available: true, colour: 'bg-purple-100 text-purple-700' },
  { value: 'webhook',   label: 'Webhook',   available: true, colour: 'bg-blue-100 text-blue-700' },
  { value: 'pagerduty', label: 'PagerDuty', available: true, colour: 'bg-red-100 text-red-700' },
  { value: 'teams',     label: 'Teams',     available: true, colour: 'bg-indigo-100 text-indigo-700' },
]

function typeMeta(type: string) {
  return CHANNEL_TYPES.find(t => t.value === type) ?? { label: type, colour: 'bg-slate-100 text-slate-600', available: false }
}

function TypeBadge({ type }: { type: string }) {
  const m = typeMeta(type)
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.colour}`}>{m.label}</span>
}

function fmtRelTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function SendLogPanel({ channelId }: { channelId: string }) {
  const { data: entries = [], isLoading } = useQuery<ChannelSendLogEntry[]>({
    queryKey: ['channel-send-log', channelId],
    queryFn: () => fetchChannelSendLog(channelId, 20),
    staleTime: 10_000,
  })

  if (isLoading) return <div className="px-4 py-3 text-xs text-slate-400">Loading…</div>
  if (entries.length === 0) return <div className="px-4 py-3 text-xs text-slate-400">No sends recorded yet.</div>

  return (
    <div className="divide-y divide-slate-100">
      {entries.map(e => (
        <div key={e.id} className="px-4 py-2 flex items-start gap-3 text-xs">
          <span className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.status === 'success' ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-slate-400 w-20 flex-shrink-0">{fmtRelTime(e.sent_at)}</span>
          <span className={`font-medium w-20 flex-shrink-0 ${e.status === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {e.status}
            {e.attempts > 1 && <span className="text-slate-400 font-normal"> ({e.attempts} tries)</span>}
          </span>
          <span className="text-slate-500">
            {e.event === 'test' ? 'test send' : e.event}
            {e.error && <span className="text-red-500 ml-2 truncate max-w-xs">{e.error}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

function channelSummary(ch: NotificationChannel): string {
  if (ch.type === 'email') {
    const to: string[] = (ch.config.to as string[]) ?? []
    return to.length ? to.join(', ') : 'No recipients'
  }
  if (ch.type === 'slack' || ch.type === 'teams') {
    const url = (ch.config.webhook_url as string) ?? ''
    return url ? url.replace(/^https?:\/\//, '').slice(0, 60) + (url.length > 66 ? '…' : '') : 'No webhook URL'
  }
  if (ch.type === 'webhook') {
    const url = (ch.config.url as string) ?? ''
    return url ? url.replace(/^https?:\/\//, '').slice(0, 60) + (url.length > 66 ? '…' : '') : 'No URL'
  }
  if (ch.type === 'pagerduty') {
    const key = (ch.config.integration_key as string) ?? ''
    return key ? key.slice(0, 8) + '…' : 'No integration key'
  }
  return ''
}

function ChannelModal({ editing, onClose }: { editing: NotificationChannel | null; onClose: () => void }) {
  const qc = useQueryClient()
  const activeType = editing?.type ?? 'email'

  const [name, setName]             = useState(editing?.name ?? '')
  const [type, setType]             = useState(activeType)
  const [enabled, setEnabled]       = useState(editing?.is_enabled ?? true)
  const [errMsg, setErrMsg]         = useState('')

  // email
  const [recipients, setRecipients] = useState(
    editing?.type === 'email' ? ((editing.config.to as string[]) ?? []).join('\n') : ''
  )
  // slack / teams
  const [webhookUrl, setWebhookUrl] = useState(
    editing?.type === 'slack'  ? (editing.config.webhook_url as string ?? '') :
    editing?.type === 'teams'  ? (editing.config.webhook_url as string ?? '') : ''
  )
  // generic webhook
  const [webhookTargetUrl, setWebhookTargetUrl] = useState(
    editing?.type === 'webhook' ? (editing.config.url as string ?? '') : ''
  )
  const [webhookSecret, setWebhookSecret] = useState(
    editing?.type === 'webhook' ? (editing.config.secret as string ?? '') : ''
  )
  // pagerduty
  const [integrationKey, setIntegrationKey] = useState(
    editing?.type === 'pagerduty' ? (editing.config.integration_key as string ?? '') : ''
  )

  const currentType = editing ? activeType : type

  function buildConfig(): Record<string, unknown> {
    if (currentType === 'email')
      return { to: recipients.split('\n').map(s => s.trim()).filter(Boolean) }
    if (currentType === 'slack' || currentType === 'teams')
      return { webhook_url: webhookUrl.trim() }
    if (currentType === 'webhook') {
      const cfg: Record<string, unknown> = { url: webhookTargetUrl.trim() }
      if (webhookSecret.trim()) cfg.secret = webhookSecret.trim()
      return cfg
    }
    if (currentType === 'pagerduty')
      return { integration_key: integrationKey.trim() }
    return {}
  }

  const save = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('Name is required')
      if (currentType === 'email' && !recipients.trim()) throw new Error('At least one recipient is required')
      if ((currentType === 'slack' || currentType === 'teams') && !webhookUrl.trim()) throw new Error('Webhook URL is required')
      if (currentType === 'webhook' && !webhookTargetUrl.trim()) throw new Error('URL is required')
      if (currentType === 'pagerduty' && !integrationKey.trim()) throw new Error('Integration key is required')
      const config = buildConfig()
      return editing
        ? updateChannel(editing.id, { name, config, is_enabled: enabled })
        : createChannel({ name, type, config, is_enabled: enabled })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); onClose() },
    onError: (e: any) => setErrMsg(apiError(e)),
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
          <FInput label="Name" value={name} onChange={setName} placeholder="ops-slack" />

          {!editing ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <div className="grid grid-cols-3 gap-2">
                {CHANNEL_TYPES.map(t => (
                  <button key={t.value} onClick={() => setType(t.value)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                      type === t.value ? 'border-blue-500 bg-blue-50 text-blue-700' :
                      'border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}>
                    <span className="inline-block w-2 h-2 rounded-full bg-current" />
                    {t.label}
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

          {currentType === 'email' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Recipients</label>
              <textarea value={recipients} onChange={e => setRecipients(e.target.value)} rows={3}
                placeholder={"admin@example.com\nops@example.com"}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono" />
              <p className="text-xs text-slate-400 mt-1">One address per line</p>
            </div>
          )}

          {(currentType === 'slack') && (
            <FInput label="Incoming Webhook URL" value={webhookUrl} onChange={setWebhookUrl}
              placeholder="https://hooks.slack.com/services/…"
              hint="Create an incoming webhook in your Slack app settings" />
          )}

          {(currentType === 'teams') && (
            <FInput label="Incoming Webhook URL" value={webhookUrl} onChange={setWebhookUrl}
              placeholder="https://…webhook.office.com/webhookb2/…"
              hint="Create an incoming webhook connector in your Teams channel" />
          )}

          {currentType === 'webhook' && (
            <>
              <FInput label="URL" value={webhookTargetUrl} onChange={setWebhookTargetUrl}
                placeholder="https://your-endpoint.example.com/hook" />
              <FInput label="HMAC secret (optional)" value={webhookSecret} onChange={setWebhookSecret}
                type="password"
                hint="If set, each request includes X-Anthrimon-Signature: sha256=<hmac>" />
            </>
          )}

          {currentType === 'pagerduty' && (
            <FInput label="Integration key" value={integrationKey} onChange={setIntegrationKey}
              placeholder="a1b2c3d4e5f6…"
              hint="Events API v2 integration key from your PagerDuty service" />
          )}

          <FToggle label="Enabled" checked={enabled} onChange={setEnabled} />
          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
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
  const [logOpen, setLogOpen]         = useState<Record<string, boolean>>({})

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
                <React.Fragment key={ch.id}>
                  <tr className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-800">{ch.name}</td>
                    <td className="px-4 py-3"><TypeBadge type={ch.type} /></td>
                    <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">{channelSummary(ch)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ch.is_enabled ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {ch.is_enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-3">
                      <button onClick={() => handleTest(ch.id)}
                        disabled={testStatus[ch.id] === 'testing'}
                        className={`text-xs ${testStatus[ch.id] === 'ok' ? 'text-green-600' : testStatus[ch.id] === 'err' ? 'text-red-500' : 'text-slate-400 hover:text-blue-600'}`}>
                        {testStatus[ch.id] === 'testing' ? 'Sending…' : testStatus[ch.id] === 'ok' ? 'Sent!' : testStatus[ch.id] === 'err' ? 'Failed' : 'Test'}
                      </button>
                      <button
                        onClick={() => setLogOpen(s => ({ ...s, [ch.id]: !s[ch.id] }))}
                        className={`text-xs ${logOpen[ch.id] ? 'text-blue-600' : 'text-slate-400 hover:text-blue-600'}`}>
                        Log
                      </button>
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
                  {logOpen[ch.id] && (
                    <tr className="bg-slate-50">
                      <td colSpan={5} className="border-t border-slate-100">
                        <SendLogPanel channelId={ch.id} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
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


// ── Tenant / Site tab ─────────────────────────────────────────────────────────

interface TenantSettings {
  name: string; slug: string
  contact_name: string | null; contact_email: string | null
  notes: string | null
}

function TenantTab() {
  const qc = useQueryClient()
  const [f, setF] = useState<TenantSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [errMsg, setErrMsg] = useState('')

  const { data, isLoading } = useQuery<TenantSettings>({
    queryKey: ['tenant-settings'],
    queryFn:  () => api.get<TenantSettings>('/admin/tenant').then(r => r.data),
  })
  useEffect(() => { if (data) setF(data) }, [data])

  const saveMut = useMutation({
    mutationFn: () => api.put('/admin/tenant', {
      name:          f?.name,
      contact_name:  f?.contact_name || null,
      contact_email: f?.contact_email || null,
      notes:         f?.notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-settings'] })
      setSaved(true); setErrMsg('')
      setTimeout(() => setSaved(false), 2000)
    },
    onError: (e: any) => setErrMsg(apiError(e)),
  })

  if (isLoading || !f) return <div className="p-6 text-slate-400 text-sm">Loading…</div>

  const set = <K extends keyof TenantSettings>(k: K, v: TenantSettings[K]) =>
    setF(p => p ? { ...p, [k]: v } : p)

  const txt = (k: keyof TenantSettings, label: string, ph = '', hint?: string) => (
    <SettingRow label={label} description={hint ?? ''}>
      <input value={(f[k] as string) ?? ''} onChange={e => set(k, e.target.value as any)}
        placeholder={ph}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </SettingRow>
  )

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-slate-800">Tenant</h2>
        <p className="text-xs text-slate-400 mt-0.5">Identity and contact details for this tenant</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Identity</h3>
        <SettingRow label="Tenant name" description="Display name for this tenant / organisation.">
          <input value={f.name} onChange={e => set('name', e.target.value)}
            placeholder="Acme Corp"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </SettingRow>
        <SettingRow label="Slug" description="URL-safe identifier — set at provisioning time, read-only.">
          <input value={f.slug} readOnly
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed font-mono" />
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">NOC Contact</h3>
        {txt('contact_name', 'Contact name', 'Network Operations', 'Primary contact for this environment.')}
        {txt('contact_email', 'Contact email', 'noc@example.com', 'Used in alert footers and acknowledgement flows.')}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Notes</h3>
        <div className="py-4">
          <textarea value={f.notes ?? ''} onChange={e => set('notes', e.target.value)} rows={4}
            placeholder="Freeform notes — network topology summary, maintenance contacts, escalation procedures…"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y" />
        </div>
      </div>

      {errMsg && <p className="text-xs text-red-500 mb-3">{errMsg}</p>}
      <div className="flex items-center justify-end gap-3">
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className={`px-4 py-2 text-xs font-medium rounded-xl transition-colors disabled:opacity-50 ${
            saved ? 'bg-green-600 text-white' : 'bg-slate-800 text-white hover:bg-slate-700'
          }`}>
          {saved ? 'Saved!' : saveMut.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ── Sites tab ─────────────────────────────────────────────────────────────────

interface SiteRecord {
  id: string; name: string; description: string | null
  location: string | null; device_count: number
}
interface DeviceRecord {
  id: string; hostname: string; fqdn: string | null
  mgmt_ip: string | null; vendor: string | null; site_id: string | null
}

function SiteModal({ editing, allDevices, onClose }: {
  editing: SiteRecord | null
  allDevices: DeviceRecord[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const isNew = editing === null

  const [name,        setName]        = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [location,    setLocation]    = useState(editing?.location ?? '')
  const [errMsg,      setErrMsg]      = useState('')

  const assignedToThis = allDevices.filter(d => !isNew && d.site_id === editing?.id).map(d => d.id)
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedToThis))

  const toggleDevice = (id: string) =>
    setAssigned(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const saveMut = useMutation({
    mutationFn: async () => {
      const site = isNew
        ? (await api.post<SiteRecord>('/admin/sites', { name, description: description || null, location: location || null })).data
        : (await api.patch<SiteRecord>(`/admin/sites/${editing!.id}`, { name, description: description || null, location: location || null })).data
      await api.put(`/admin/sites/${site.id}/devices`, { device_ids: [...assigned] })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sites'] }); qc.invalidateQueries({ queryKey: ['admin-all-devices'] }); onClose() },
    onError: (e: any) => setErrMsg(apiError(e)),
  })

  // Devices available: all devices not assigned to another site, plus those already in this site
  const available = allDevices.filter(d => !d.site_id || d.site_id === editing?.id)
  const [devSearch, setDevSearch] = useState('')
  const filtered = available.filter(d =>
    !devSearch || (d.fqdn ?? d.hostname).toLowerCase().includes(devSearch.toLowerCase()) ||
    (d.mgmt_ip ?? '').includes(devSearch)
  )

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-slate-800">{isNew ? 'New site' : `Edit — ${editing!.name}`}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-4">
          <FInput label="Name" value={name} onChange={setName} placeholder="HQ / Branch – London" />
          <FInput label="Location" value={location} onChange={setLocation} placeholder="New York, US" />
          <FInput label="Description" value={description} onChange={setDescription} placeholder="Optional notes about this site" />

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Devices</label>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="p-2 border-b border-slate-100 bg-slate-50">
                <input value={devSearch} onChange={e => setDevSearch(e.target.value)}
                  placeholder="Filter devices…"
                  className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="max-h-52 overflow-y-auto divide-y divide-slate-50">
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-slate-400 text-center">No unassigned devices</p>
                ) : filtered.map(d => (
                  <label key={d.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={assigned.has(d.id)} onChange={() => toggleDevice(d.id)}
                      className="rounded border-slate-300 text-blue-600" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-slate-800 truncate">{d.fqdn ?? d.hostname}</span>
                      {d.mgmt_ip && <span className="text-[10px] text-slate-400 font-mono">{d.mgmt_ip}</span>}
                    </span>
                    {d.vendor && <span className="text-[10px] text-slate-400 shrink-0">{d.vendor}</span>}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">{assigned.size} device{assigned.size !== 1 ? 's' : ''} selected</p>
          </div>

          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl">Cancel</button>
          <button onClick={() => saveMut.mutate()} disabled={!name || saveMut.isPending}
            className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {saveMut.isPending ? 'Saving…' : isNew ? 'Create site' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SitesTab() {
  const qc = useQueryClient()
  const [modal, setModal] = useState<'new' | SiteRecord | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: sites = [], isLoading } = useQuery<SiteRecord[]>({
    queryKey: ['admin-sites'],
    queryFn:  () => api.get<SiteRecord[]>('/admin/sites').then(r => r.data),
  })
  const { data: allDevices = [] } = useQuery<DeviceRecord[]>({
    queryKey: ['admin-all-devices'],
    queryFn:  () => api.get<DeviceRecord[]>('/admin/devices/unassigned').then(r => r.data),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/sites/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sites'] }); qc.invalidateQueries({ queryKey: ['admin-all-devices'] }); setConfirmDelete(null) },
  })

  const unassigned = allDevices.filter(d => !d.site_id)

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Sites</h2>
          <p className="text-xs text-slate-400 mt-0.5">Group devices by physical location or logical grouping</p>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          New site
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : sites.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <svg className="w-8 h-8 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <p className="text-slate-400 text-sm mb-3">No sites yet.</p>
          <button onClick={() => setModal('new')} className="text-sm text-blue-600 hover:underline">Create your first site</button>
        </div>
      ) : (
        <div className="space-y-3">
          {sites.map(site => (
            <div key={site.id} className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex items-center gap-4">
              <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800">{site.name}</p>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  {site.location && <span className="text-xs text-slate-400">{site.location}</span>}
                  {site.description && <span className="text-xs text-slate-400 truncate max-w-xs">{site.description}</span>}
                </div>
              </div>
              <span className="text-xs text-slate-500 shrink-0">
                {site.device_count} device{site.device_count !== 1 ? 's' : ''}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => setModal(site)}
                  className="text-xs text-blue-600 hover:underline">Edit</button>
                {confirmDelete === site.id ? (
                  <>
                    <button onClick={() => deleteMut.mutate(site.id)} className="text-xs text-red-600 font-medium hover:underline">Confirm</button>
                    <button onClick={() => setConfirmDelete(null)} className="text-xs text-slate-400 hover:underline">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDelete(site.id)} className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Unassigned devices callout */}
      {unassigned.length > 0 && (
        <div className="mt-4 bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3 flex items-center gap-3">
          <span className="text-xs text-slate-500">{unassigned.length} device{unassigned.length !== 1 ? 's' : ''} not assigned to any site</span>
        </div>
      )}

      {modal !== null && (
        <SiteModal
          editing={modal === 'new' ? null : modal}
          allDevices={allDevices}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

// ── Tenant alerting settings tab ────────────────────────────────────────────────
//
// Platform admins set org-wide defaults for these 10 settings via
// PlatformPage's Global Settings tab (/platform/settings). Any tenant_admin
// may override the subset that applies to their own tenant here, via
// /admin/settings/alerting. Overrides are stored sparsely — fields left at
// the platform default automatically track future platform-wide changes.

interface TenantAlertingSettings {
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
}

interface TenantAlertingSettingsRead extends TenantAlertingSettings {
  platform_defaults: TenantAlertingSettings
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

function SaveBar({ saveMut, saved }: { saveMut: UseMutationResult<any, any, void, unknown>; saved: boolean }) {
  return (
    <div className="flex items-center justify-end gap-3 mb-6">
      <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
        className={`px-4 py-2 text-xs font-medium rounded-xl transition-colors disabled:opacity-50 ${
          saved ? 'bg-green-600 text-white' : 'bg-slate-800 text-white hover:bg-slate-700'
        }`}>
        {saved ? 'Saved!' : saveMut.isPending ? 'Saving…' : 'Save changes'}
      </button>
      {saveMut.isError && (
        <p className="text-xs text-red-500">{(saveMut.error as any)?.response?.data?.detail ?? 'Failed to save'}</p>
      )}
    </div>
  )
}

// Shared hook for the tenant alerting-overrides mutation.
function useAlertingSettings() {
  const qc = useQueryClient()
  const [f, setF] = useState<TenantAlertingSettingsRead | null>(null)
  const [saved, setSaved] = useState(false)
  const { data, isLoading } = useQuery<TenantAlertingSettingsRead>({
    queryKey: ['tenant-alerting-settings'],
    queryFn:  () => api.get<TenantAlertingSettingsRead>('/admin/settings/alerting').then(r => r.data),
  })
  useEffect(() => { if (data) setF(data) }, [data])
  const saveMut = useMutation({
    mutationFn: () => {
      const { platform_defaults, ...body } = f as TenantAlertingSettingsRead
      return api.put('/admin/settings/alerting', body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-alerting-settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })
  const set = <K extends keyof TenantAlertingSettings>(k: K, v: TenantAlertingSettings[K]) =>
    setF(p => p ? { ...p, [k]: v } : p)
  return { f, set, isLoading, saveMut, saved }
}

// Shows the platform-wide default for a field, plus a "Reset" link when this
// tenant's effective value differs from it.
function DefaultHint({ overridden, deflt, onReset }: {
  overridden: boolean; deflt?: string; onReset: () => void
}) {
  if (!overridden) {
    return deflt !== undefined
      ? <p className="text-[10px] text-slate-400 mt-1">Platform default: {deflt}</p>
      : null
  }
  return (
    <p className="text-[10px] text-amber-600 mt-1">
      {deflt !== undefined ? `Overridden — platform default: ${deflt}` : 'Overridden for this tenant'} ·{' '}
      <button type="button" onClick={onReset} className="underline hover:text-amber-700">Reset</button>
    </p>
  )
}

function AlertingSettingsTab() {
  const { f, set, isLoading, saveMut, saved } = useAlertingSettings()
  if (isLoading || !f) return <div className="p-6 text-slate-400 text-sm">Loading…</div>
  const d = f.platform_defaults
  const num = (k: keyof TenantAlertingSettings, unit = '') => (
    <div>
      <input type="number" value={String(f[k])}
        onChange={e => set(k, Number(e.target.value) as any)}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
      <DefaultHint overridden={f[k] !== d[k]} deflt={`${d[k]}${unit}`} onReset={() => set(k, d[k] as any)} />
    </div>
  )
  const pauseOverridden = f.notifications_paused !== d.notifications_paused
    || f.notifications_paused_until !== d.notifications_paused_until
  const bizOverridden = f.business_hours_enabled !== d.business_hours_enabled
    || f.business_hours_start !== d.business_hours_start
    || f.business_hours_end !== d.business_hours_end
    || JSON.stringify(f.business_days) !== JSON.stringify(d.business_days)
  return (
    <div className="p-6 max-w-3xl overflow-y-auto">
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-slate-800">Alerting</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Override the platform-wide alerting defaults for your tenant. Fields left at the
          platform default automatically track future platform-wide changes.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Firing Behaviour</h3>
        <SettingRow label="Storm protection"
          description="Maximum new alerts per device per hour. Set to 0 to disable.">
          {num('max_alerts_per_device_per_hour', '/hr')}
        </SettingRow>
        <SettingRow label="Device-down stale floor"
          description="Minimum seconds without a successful poll before a device is considered unreachable. Actual threshold is max(this, 2.5× poll interval).">
          {num('device_down_stale_min_s', 's')}
        </SettingRow>
        <SettingRow label="Stale alert auto-close"
          description="Auto-close open/acknowledged alerts with no activity after this many days. Set to 0 to disable.">
          {num('auto_close_stale_days', 'd')}
        </SettingRow>
        <SettingRow label="Alert retention"
          description="How long resolved/expired/suppressed alerts are kept before being purged.">
          {num('alert_retention_days', 'd')}
        </SettingRow>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 px-6 mb-6">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide pt-4 pb-2">Notification Schedule</h3>
        <SettingRow label="Pause all notifications"
          badge={f.notifications_paused ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Active</span> : undefined}
          description="Temporarily silence all outgoing alert notifications for your tenant.">
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
            <DefaultHint overridden={pauseOverridden}
              onReset={() => { set('notifications_paused', d.notifications_paused); set('notifications_paused_until', d.notifications_paused_until) }} />
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
            <DefaultHint overridden={bizOverridden}
              onReset={() => {
                set('business_hours_enabled', d.business_hours_enabled)
                set('business_hours_start', d.business_hours_start)
                set('business_hours_end', d.business_hours_end)
                set('business_days', d.business_days)
              }} />
          </div>
        </SettingRow>
      </div>
      <SaveBar saveMut={saveMut} saved={saved} />
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
              sandbox="allow-scripts"
              className="flex-1 w-full border-none bg-white"
              title="Email preview"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── API Methods tab ───────────────────────────────────────────────────────────

interface ApiMethod {
  id: string
  device_id: string
  method: string
  label: string
  enabled: boolean
  reachable: boolean | null
  last_probe_at: string | null
  probe_error: string | null
  configure_status: string | null
  configure_at: string | null
}

interface ApiDevice {
  device_id: string
  hostname: string
  mgmt_ip: string
  vendor: string
  supported_methods: string[]
  has_ssh_cred: boolean
  methods: ApiMethod[]
}

const METHOD_ORDER = ['snmp', 'arista_eapi', 'aruba_cx_rest', 'gnmi']

function MethodBadge({ m }: { m: ApiMethod | undefined; method: string }) {
  if (!m) return <span className="text-xs text-slate-300">—</span>
  const dot = m.reachable === true ? 'bg-green-500'
    : m.reachable === false ? 'bg-red-400'
    : m.enabled ? 'bg-slate-300' : 'bg-slate-200'
  const text = m.reachable === true ? 'Reachable'
    : m.reachable === false ? 'Unreachable'
    : m.enabled ? 'Enabled'
    : 'Disabled'
  const cls = m.reachable === true ? 'text-green-700 bg-green-50'
    : m.reachable === false ? 'text-red-700 bg-red-50'
    : 'text-slate-500 bg-slate-100'
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  )
}

function ConfigureModal({ device, method, onClose, onDone }: {
  device: ApiDevice; method: string; onClose: () => void; onDone: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [output, setOutput] = useState('')
  const [success, setSuccess] = useState(false)

  const { data: cmdData } = useQuery<{ commands: string[]; vrf?: string }>({
    queryKey: ['api-method-commands', device.device_id, method],
    queryFn: () => api.get(`/api-methods/${device.device_id}/${method}/commands`).then(r => r.data as { commands: string[]; vrf?: string }),
  })
  const preview = cmdData?.commands.join('\n') ?? '…'

  const run = async () => {
    setStatus('running')
    try {
      const r = await api.post(`/api-methods/${device.device_id}/${method}/configure`)
      const rd = r.data as { output?: string; status?: string }
      setOutput(rd.output ?? '')
      setSuccess(rd.status === 'success')
    } catch (e: any) {
      setOutput(e?.response?.data?.detail ?? String(e))
      setSuccess(false)
    }
    setStatus('done')
    onDone()
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">
            Auto-configure {method === 'arista_eapi' ? 'Arista eAPI' : 'CX REST'} — {device.hostname}
          </h2>
          <button onClick={onClose} aria-label="Close dialog" className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <p className="text-xs text-slate-500 mb-2">
              Commands to be pushed via SSH (config mode, saved to startup){cmdData?.vrf ? ` · management VRF: ${cmdData.vrf}` : ''}:
            </p>
            <pre className="bg-slate-900 text-green-400 rounded-lg p-3 text-xs font-mono whitespace-pre leading-relaxed">
              {preview}
            </pre>
          </div>
          {status === 'done' && (
            <div>
              <p className={`text-xs font-semibold mb-1 ${success ? 'text-green-700' : 'text-red-700'}`}>
                {success ? '✓ Configuration applied successfully' : '✗ Configuration failed'}
              </p>
              <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono max-h-48 overflow-auto whitespace-pre-wrap">
                {output || '(no output)'}
              </pre>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">
            {status === 'done' ? 'Close' : 'Cancel'}
          </button>
          {status !== 'done' && (
            <button onClick={run} disabled={status === 'running'}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {status === 'running' ? 'Configuring…' : 'Deploy'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ApiMethodsTab() {
  const qc = useQueryClient()
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [bulkConfiguring, setBulkConfiguring] = useState<Record<string, boolean>>({})
  const [modal, setModal] = useState<{ device: ApiDevice; method: string } | null>(null)
  const [vendorFilter, setVendorFilter] = useState('all')

  const { data: devicesData, isLoading } = useQuery<ApiDevice[]>({
    queryKey: ['api-methods'],
    queryFn: () => api.get('/api-methods/').then(r => r.data as ApiDevice[]),
    refetchInterval: 60_000,
  })
  const devices: ApiDevice[] = devicesData ?? []

  const vendors = useMemo(() => ['all', ...new Set(devices.map(d => d.vendor))].sort(), [devices])

  const filtered = useMemo(() =>
    vendorFilter === 'all' ? devices : devices.filter(d => d.vendor === vendorFilter),
    [devices, vendorFilter]
  )

  const probe = async (deviceId: string, method: string, ip: string) => {
    const key = `${deviceId}:${method}`
    setProbing(p => ({ ...p, [key]: true }))
    try {
      await api.post(`/api-methods/${deviceId}/${method}/probe`)
      qc.invalidateQueries({ queryKey: ['api-methods'] })
    } finally {
      setProbing(p => ({ ...p, [key]: false }))
    }
  }

  const probeAll = async () => {
    setProbing(p => ({ ...p, _all: true }))
    try {
      await api.post('/api-methods/probe-all')
      qc.invalidateQueries({ queryKey: ['api-methods'] })
    } finally {
      setProbing(p => ({ ...p, _all: false }))
    }
  }

  const toggle = async (deviceId: string, method: string) => {
    await api.patch(`/api-methods/${deviceId}/${method}/toggle`)
    qc.invalidateQueries({ queryKey: ['api-methods'] })
  }

  const configureBulk = async (devs: ApiDevice[], method: string) => {
    setBulkConfiguring(p => ({ ...p, [method]: true }))
    try {
      await Promise.all(devs.map(d => api.post(`/api-methods/${d.device_id}/${method}/configure`)))
      qc.invalidateQueries({ queryKey: ['api-methods'] })
    } finally {
      setBulkConfiguring(p => ({ ...p, [method]: false }))
    }
  }

  if (isLoading) return <div className="p-6 text-sm text-slate-400">Loading…</div>

  const configurable = filtered.filter(d =>
    d.supported_methods.some(m => m !== 'snmp') && d.has_ssh_cred
  )

  // Count summary
  const totalMethods = devices.flatMap(d => d.methods).filter(m => m.method !== 'snmp')
  const reachableCount = totalMethods.filter(m => m.reachable).length
  const pendingCount = totalMethods.filter(m => !m.reachable && m.method !== 'snmp').length

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {modal && (
        <ConfigureModal
          device={modal.device}
          method={modal.method}
          onClose={() => setModal(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['api-methods'] })}
        />
      )}

      {/* Header + bulk actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">API Method Orchestration</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {devices.length} devices · {reachableCount} methods reachable · {pendingCount} pending enablement
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {vendors.map(v => (
              <button key={v} onClick={() => setVendorFilter(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${vendorFilter === v ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {v === 'all' ? 'All vendors' : v}
              </button>
            ))}
          </div>
          <button onClick={probeAll} disabled={!!probing['_all']}
            className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-50">
            {probing['_all'] ? 'Probing…' : 'Probe all'}
          </button>
        </div>
      </div>

      {/* Bulk configure callout — shown when there are configurable devices not yet reachable */}
      {configurable.length > 0 && (() => {
        const needsConfig = configurable.filter(d =>
          d.methods.some(m => m.method !== 'snmp' && !m.reachable && m.configure_status !== 'success')
        )
        if (!needsConfig.length) return null
        // Group by method
        const byMethod: Record<string, ApiDevice[]> = {}
        for (const d of needsConfig) {
          for (const m of d.methods) {
            if (m.method !== 'snmp' && !m.reachable && m.configure_status !== 'success') {
              byMethod[m.method] = [...(byMethod[m.method] ?? []), d]
            }
          }
        }
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <p className="text-xs font-semibold text-amber-800 mb-2">
              {needsConfig.length} device{needsConfig.length !== 1 ? 's' : ''} have unconfigured API methods
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(byMethod).map(([method, devs]) => (
                <button key={method}
                  onClick={() => configureBulk(devs, method)}
                  disabled={!!bulkConfiguring[method]}
                  className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-60">
                  {bulkConfiguring[method]
                    ? `Configuring ${devs.length} device${devs.length !== 1 ? 's' : ''}…`
                    : `Configure ${method === 'arista_eapi' ? 'Arista eAPI' : 'CX REST'} on ${devs.length} device${devs.length !== 1 ? 's' : ''}`}
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Device table */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-400">
          No devices found
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-400">Device</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Vendor</th>
                {METHOD_ORDER.filter(m =>
                  filtered.some(d => d.supported_methods.includes(m))
                ).map(m => (
                  <th key={m} className="text-left px-4 py-3 text-xs font-medium text-slate-400">
                    {{snmp:'SNMP', arista_eapi:'Arista eAPI', aruba_cx_rest:'CX REST', gnmi:'gNMI'}[m] ?? m}
                  </th>
                ))}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(dev => {
                const byMethod = Object.fromEntries(dev.methods.map(m => [m.method, m]))
                const visibleMethods = METHOD_ORDER.filter(m =>
                  filtered.some(d => d.supported_methods.includes(m))
                )
                return (
                  <tr key={dev.device_id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <div className="text-sm font-medium text-slate-800">{dev.hostname || dev.mgmt_ip}</div>
                      <div className="text-xs text-slate-400 font-mono">{dev.mgmt_ip}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{dev.vendor}</td>
                    {visibleMethods.map(method => {
                      const m = byMethod[method]
                      const key = `${dev.device_id}:${method}`
                      if (!dev.supported_methods.includes(method)) {
                        return <td key={method} className="px-4 py-3 text-slate-200 text-xs">—</td>
                      }
                      return (
                        <td key={method} className="px-4 py-3">
                          <div className="space-y-1.5">
                            <MethodBadge m={m} method={method} />
                            {m?.last_probe_at && (
                              <div className="text-[10px] text-slate-400">
                                {new Date(m.last_probe_at).toLocaleTimeString()}
                              </div>
                            )}
                            {method !== 'snmp' && m && (
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => probe(dev.device_id, method, dev.mgmt_ip)}
                                  disabled={!!probing[key]}
                                  className="text-[10px] px-1.5 py-0.5 border border-slate-200 rounded bg-white hover:bg-slate-50 disabled:opacity-50">
                                  {probing[key] ? '…' : 'Probe'}
                                </button>
                                <button
                                  onClick={() => toggle(dev.device_id, method)}
                                  className={`text-[10px] px-1.5 py-0.5 border rounded ${m.enabled ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-blue-200 text-blue-600 hover:bg-blue-50'}`}>
                                  {m.enabled ? 'Disable' : 'Enable'}
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      )
                    })}
                    <td className="px-4 py-3">
                      {(() => {
                        const unconfigured = dev.supported_methods.filter(m =>
                          m !== 'snmp' && !byMethod[m]?.reachable && byMethod[m]?.configure_status !== 'success'
                        )
                        if (!unconfigured.length) return null
                        if (!dev.has_ssh_cred)
                          return <span className="text-xs text-slate-300">No SSH cred</span>
                        return (
                          <div className="flex gap-1.5">
                            {unconfigured.map(method => (
                              <button key={method}
                                onClick={() => setModal({ device: dev, method })}
                                className="text-xs px-2 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                                Configure {method === 'arista_eapi' ? 'eAPI' : 'REST'}
                              </button>
                            ))}
                          </div>
                        )
                      })()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

type Tab =
  | 'tenant' | 'sites'
  | 'alerting'
  | 'smtp' | 'channels' | 'template'
  | 'api-methods'
  | 'storage'

const ADMIN_NAV: { section: string; items: { id: Tab; label: string; icon: React.ReactNode }[] }[] = [
  {
    section: 'Tenant',
    items: [
      {
        id: 'tenant', label: 'Tenant',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
      },
      {
        id: 'sites', label: 'Sites',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
      },
      {
        id: 'alerting', label: 'Alerting',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
      },
    ],
  },
  {
    section: 'Notifications',
    items: [
      {
        id: 'smtp', label: 'SMTP Server',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
      },
      {
        id: 'channels', label: 'Channels',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
      },
      {
        id: 'template', label: 'Email Templates',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
      },
    ],
  },
  {
    section: 'Collection',
    items: [
      {
        id: 'api-methods', label: 'API Methods',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
      },
    ],
  },
  {
    section: 'Data',
    items: [
      {
        id: 'storage', label: 'Storage',
        icon: <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
      },
    ],
  },
]

// Tabs that read platform-wide data (storage stats span every tenant), so
// only platform_admin may view/edit them.
const PLATFORM_ONLY_TABS: Set<Tab> = new Set(['storage'])

export default function AdminPage() {
  const role = useRole()
  const { data: me } = useCurrentUser()
  const [searchParams] = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab | null) ?? 'tenant'
  const [tab, setTab] = useState<Tab>(initialTab)

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

  const isPlatformAdmin = me?.is_platform_admin ?? false
  const nav = ADMIN_NAV
    .map(group => ({ ...group, items: group.items.filter(i => !PLATFORM_ONLY_TABS.has(i.id) || isPlatformAdmin) }))
    .filter(group => group.items.length > 0)
  const activeTab: Tab = (PLATFORM_ONLY_TABS.has(tab) && !isPlatformAdmin) ? 'tenant' : tab

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left settings nav */}
      <div className="w-52 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-200">
          <h1 className="text-sm font-semibold text-slate-800">Administration</h1>
        </div>
        <nav className="flex-1 py-2">
          {nav.map(({ section, items }) => (
            <div key={section} className="mb-2">
              <p className="px-5 pt-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
                {section}
              </p>
              {items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center gap-2.5 px-5 py-2 text-sm text-left transition-colors relative ${
                    activeTab === item.id
                      ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                      : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                  }`}
                >
                  <span className={activeTab === item.id ? 'text-blue-500' : 'text-slate-400'}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className={`flex-1 min-w-0 bg-white ${activeTab === 'template' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
        {activeTab === 'tenant'           && <TenantTab />}
        {activeTab === 'sites'            && <SitesTab />}
        {activeTab === 'alerting'         && <AlertingSettingsTab />}
        {activeTab === 'smtp'             && <SmtpTab />}
        {activeTab === 'channels'         && <ChannelsTab />}
        {activeTab === 'template'         && <EmailTemplateTab />}
        {activeTab === 'api-methods'      && <ApiMethodsTab />}
        {activeTab === 'storage'          && <DataTab />}
      </div>
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
