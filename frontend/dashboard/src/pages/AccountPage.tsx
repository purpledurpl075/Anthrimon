import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import QRCode from 'react-qr-code'
import api from '../api/client'
import { SkeletonDetailPage } from '../components/Skeleton'
import { totpSetup, totpConfirm, totpDisable, totpBackupCodes } from '../api/devices'

interface Me {
  id: string
  username: string
  email: string
  full_name: string | null
  role: string
  tenant_id: string
  totp_enabled: boolean
}

const fetchMe = () => api.get<Me>('/auth/me').then(r => r.data)

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Super admin',
  admin:      'Admin',
  operator:   'Operator',
  readonly:   'Read only',
}

// ── TOTP setup wizard ─────────────────────────────────────────────────────────

type TotpWizardStep = 'idle' | 'scan' | 'backup_codes'

function TotpSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [wizardStep, setWizardStep] = useState<TotpWizardStep>('idle')
  const [provUri, setProvUri]       = useState('')
  const [secret, setSecret]         = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [backupCode, setBackupCode]  = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [msg, setMsg]               = useState<{ ok: boolean; text: string } | null>(null)
  const [showDisable, setShowDisable] = useState(false)
  const [showRegen, setShowRegen]    = useState(false)
  const [regenCode, setRegenCode]    = useState('')
  const [regenCodes, setRegenCodes]  = useState<string[]>([])
  const [loadingSetup, setLoadingSetup]   = useState(false)
  const [loadingConfirm, setLoadingConfirm] = useState(false)
  const [loadingDisable, setLoadingDisable] = useState(false)
  const [loadingRegen, setLoadingRegen]   = useState(false)

  async function startSetup() {
    setLoadingSetup(true); setMsg(null)
    try {
      const data = await totpSetup()
      setSecret(data.secret)
      setProvUri(data.provisioning_uri)
      setConfirmCode('')
      setWizardStep('scan')
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.detail ?? 'Setup failed.' })
    } finally {
      setLoadingSetup(false)
    }
  }

  async function confirmSetup() {
    setLoadingConfirm(true); setMsg(null)
    try {
      const data = await totpConfirm(confirmCode)
      setBackupCodes(data.backup_codes)
      setWizardStep('backup_codes')
      onChanged()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.detail ?? 'Invalid code.' })
    } finally {
      setLoadingConfirm(false)
    }
  }

  async function disable() {
    setLoadingDisable(true); setMsg(null)
    try {
      await totpDisable(disableCode)
      setShowDisable(false); setDisableCode('')
      onChanged()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.detail ?? 'Invalid code.' })
    } finally {
      setLoadingDisable(false)
    }
  }

  async function regen() {
    setLoadingRegen(true); setMsg(null)
    try {
      const data = await totpBackupCodes(regenCode)
      setRegenCodes(data.backup_codes)
      setRegenCode('')
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.detail ?? 'Invalid code.' })
    } finally {
      setLoadingRegen(false)
    }
  }

  // ── Enabled state ──────────────────────────────────────────────────────────
  if (enabled && wizardStep === 'idle') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            2FA active
          </span>
        </div>

        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>
        )}

        {/* Regenerate backup codes */}
        {!showRegen ? (
          <button
            onClick={() => { setShowRegen(true); setShowDisable(false); setMsg(null) }}
            className="text-sm text-slate-600 hover:text-blue-600 underline underline-offset-2 transition-colors"
          >
            Regenerate backup codes
          </button>
        ) : regenCodes.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-700">New backup codes (save these now — shown once):</p>
            <div className="grid grid-cols-2 gap-1">
              {regenCodes.map(c => (
                <code key={c} className="text-xs font-mono bg-slate-50 border border-slate-200 px-2 py-1 rounded text-center">{c}</code>
              ))}
            </div>
            <button onClick={() => { setShowRegen(false); setRegenCodes([]) }}
              className="text-xs text-slate-500 hover:text-slate-700">Done</button>
          </div>
        ) : (
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Enter your current TOTP code to regenerate
              </label>
              <input
                type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                value={regenCode}
                onChange={e => setRegenCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={regen}
              disabled={loadingRegen || regenCode.length !== 6}
              className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loadingRegen ? '…' : 'Regenerate'}
            </button>
            <button onClick={() => { setShowRegen(false); setRegenCode('') }}
              className="px-3 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50 transition-colors">
              Cancel
            </button>
          </div>
        )}

        {/* Disable */}
        {!showDisable ? (
          <button
            onClick={() => { setShowDisable(true); setShowRegen(false); setMsg(null) }}
            className="block text-sm text-red-500 hover:text-red-700 underline underline-offset-2 transition-colors"
          >
            Disable two-factor authentication
          </button>
        ) : (
          <div className="border border-red-200 rounded-lg p-4 space-y-3 bg-red-50">
            <p className="text-xs text-red-700 font-medium">Confirm with your current TOTP code to disable 2FA:</p>
            <div className="flex gap-2 items-end">
              <input
                type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                value={disableCode}
                onChange={e => setDisableCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <button
                onClick={disable}
                disabled={loadingDisable || disableCode.length !== 6}
                className="px-3 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {loadingDisable ? '…' : 'Disable'}
              </button>
              <button onClick={() => { setShowDisable(false); setDisableCode('') }}
                className="px-3 py-2 border border-slate-300 text-sm rounded-lg hover:bg-white transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Setup wizard: scan step ────────────────────────────────────────────────
  if (wizardStep === 'scan') {
    return (
      <div className="space-y-4">
        <p className="text-xs text-slate-600">
          Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.),
          then enter the 6-digit code below to confirm.
        </p>
        <div className="flex justify-center p-4 bg-white border border-slate-200 rounded-lg">
          <QRCode value={provUri} size={180} />
        </div>
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-700">Can't scan? Enter manually</summary>
          <code className="block mt-1 font-mono break-all bg-slate-50 border border-slate-200 p-2 rounded text-xs">{secret}</code>
        </details>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Verification code</label>
          <input
            type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            value={confirmCode}
            onChange={e => setConfirmCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            autoFocus
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {msg && <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>}
        <div className="flex gap-2">
          <button
            onClick={confirmSetup}
            disabled={loadingConfirm || confirmCode.length !== 6}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loadingConfirm ? 'Verifying…' : 'Enable 2FA'}
          </button>
          <button
            onClick={() => { setWizardStep('idle'); setMsg(null) }}
            className="px-4 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // ── Setup wizard: backup codes step ───────────────────────────────────────
  if (wizardStep === 'backup_codes') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            2FA enabled
          </span>
        </div>
        <p className="text-xs text-slate-700 font-medium">
          Save these backup codes somewhere safe. Each can be used once if you lose access to your authenticator.
          They won't be shown again.
        </p>
        <div className="grid grid-cols-2 gap-1">
          {backupCodes.map(c => (
            <code key={c} className="text-xs font-mono bg-slate-50 border border-slate-200 px-2 py-1 rounded text-center">{c}</code>
          ))}
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(backupCodes.join('\n')) }}
          className="text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2"
        >
          Copy all codes
        </button>
        <button
          onClick={() => setWizardStep('idle')}
          className="w-full px-4 py-2 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-700 transition-colors"
        >
          Done
        </button>
      </div>
    )
  }

  // ── Disabled / not set up ─────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Two-factor authentication is not enabled. Add an extra layer of security to your account.
      </p>
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>}
      <button
        onClick={startSetup}
        disabled={loadingSetup}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {loadingSetup ? 'Setting up…' : 'Enable two-factor authentication'}
      </button>
    </div>
  )
}


// ── Main page ─────────────────────────────────────────────────────────────────

export default function AccountPage() {
  const qc = useQueryClient()

  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: fetchMe })

  const [fullName, setFullName]         = useState('')
  const [email, setEmail]               = useState('')
  const [currentPw, setCurrentPw]       = useState('')
  const [newPw, setNewPw]               = useState('')
  const [confirmPw, setConfirmPw]       = useState('')
  const [profileMsg, setProfileMsg]     = useState<{ ok: boolean; text: string } | null>(null)
  const [pwMsg, setPwMsg]               = useState<{ ok: boolean; text: string } | null>(null)

  const profileMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/auth/me', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] })
      setProfileMsg({ ok: true, text: 'Profile updated.' })
    },
    onError: (e: any) => setProfileMsg({ ok: false, text: e?.response?.data?.detail ?? 'Update failed.' }),
  })

  const pwMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/auth/me', body),
    onSuccess: () => {
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setPwMsg({ ok: true, text: 'Password changed.' })
    },
    onError: (e: any) => setPwMsg({ ok: false, text: e?.response?.data?.detail ?? 'Change failed.' }),
  })

  if (isLoading || !me) return <SkeletonDetailPage />

  const saveProfile = () => {
    setProfileMsg(null)
    const body: Record<string, unknown> = {}
    if (fullName !== '') body.full_name = fullName
    if (email !== '')    body.email     = email
    if (Object.keys(body).length === 0) return
    profileMutation.mutate(body)
  }

  const changePassword = () => {
    setPwMsg(null)
    if (newPw !== confirmPw) { setPwMsg({ ok: false, text: 'New passwords do not match.' }); return }
    if (newPw.length < 8)    { setPwMsg({ ok: false, text: 'Password must be at least 8 characters.' }); return }
    pwMutation.mutate({ current_password: currentPw, new_password: newPw })
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="px-6 py-4 border-b border-slate-200 bg-white">
        <h1 className="text-base font-semibold text-slate-800">Account</h1>
      </div>

      <main className="p-6 max-w-xl space-y-6">

        {/* Profile info */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Profile</h2>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
            <dt className="text-slate-500">Username</dt>
            <dd className="font-mono text-slate-700">{me.username}</dd>
            <dt className="text-slate-500">Role</dt>
            <dd className="text-slate-700">{ROLE_LABEL[me.role] ?? me.role}</dd>
          </dl>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Full name</label>
              <input
                type="text"
                placeholder={me.full_name ?? 'Not set'}
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                placeholder={me.email}
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveProfile}
              disabled={profileMutation.isPending || (!fullName && !email)}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {profileMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            {profileMsg && (
              <span className={`text-xs ${profileMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                {profileMsg.text}
              </span>
            )}
          </div>
        </div>

        {/* Password change */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Change password</h2>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Current password</label>
              <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">New password</label>
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Confirm new password</label>
              <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={changePassword}
              disabled={pwMutation.isPending || !currentPw || !newPw || !confirmPw}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {pwMutation.isPending ? 'Changing…' : 'Change password'}
            </button>
            {pwMsg && (
              <span className={`text-xs ${pwMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                {pwMsg.text}
              </span>
            )}
          </div>
        </div>

        {/* Two-factor authentication */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Two-factor authentication</h2>
          <TotpSection
            enabled={me.totp_enabled}
            onChanged={() => qc.invalidateQueries({ queryKey: ['me'] })}
          />
        </div>

        {/* Session management */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Sessions</h2>
          <p className="text-xs text-slate-500 mb-4">
            Revoke all active sessions across all devices. You will be signed out and need to log in again.
          </p>
          <button
            onClick={async () => {
              if (!confirm('Sign out of all sessions? You will need to log in again.')) return
              try {
                await api.post('/auth/revoke-sessions')
              } catch { /* ignore */ }
              localStorage.removeItem('token')
              window.location.href = '/login'
            }}
            className="px-4 py-2 text-xs font-medium text-red-700 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
          >
            Sign out everywhere
          </button>
        </div>

      </main>
    </div>
  )
}
