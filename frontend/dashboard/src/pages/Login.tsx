import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, totpChallenge } from '../api/devices'
import api from '../api/client'

type Step = 'credentials' | 'totp'

export default function Login() {
  const [step, setStep]             = useState<Step>('credentials')
  const [username, setUsername]     = useState('')
  const [password, setPassword]     = useState('')
  const [totpCode, setTotpCode]     = useState('')
  const [backupCode, setBackupCode] = useState('')
  const [useBackup, setUseBackup]   = useState(false)
  const [session, setSession]       = useState('')
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [demoMode, setDemoMode]     = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    fetch('/api/v1/auth/demo-status').then(r => r.json()).then(d => {
      if (d.demo_mode) {
        setDemoMode(true)
        fetch('/api/v1/auth/demo-login', { method: 'POST' })
          .then(r => r.json())
          .then(d => {
            if (d.access_token) {
              localStorage.setItem('token', d.access_token)
              navigate('/')
            }
          })
          .catch(() => setDemoMode(true))
      }
    }).catch(() => {})
  }, [])

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    localStorage.removeItem('token')
    setError('')
    setLoading(true)
    try {
      const res = await login(username, password)
      if (res.totp_required && res.totp_session) {
        setSession(res.totp_session)
        setStep('totp')
      } else {
        localStorage.setItem('token', res.access_token)
        navigate('/')
      }
    } catch {
      setError('Invalid username or password')
    } finally {
      setLoading(false)
    }
  }

  async function handleTotp(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await totpChallenge(
        session,
        useBackup ? undefined : totpCode || undefined,
        useBackup ? backupCode || undefined : undefined,
      )
      localStorage.setItem('token', res.access_token)
      navigate('/')
    } catch {
      setError('Invalid code — try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="bg-white rounded-xl shadow-md dark:shadow-xl dark:ring-1 dark:ring-slate-700 p-8 w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <img src="/logo-primary.svg" alt="Anthrimon" className="h-24 w-auto" />
        </div>

        {step === 'credentials' ? (
          <form onSubmit={handleCredentials} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleTotp} className="space-y-4">
            <div className="text-center mb-2">
              <p className="text-sm font-medium text-slate-700">Two-Factor Authentication</p>
              <p className="text-xs text-slate-500 mt-1">
                {useBackup
                  ? 'Enter one of your backup codes'
                  : 'Enter the 6-digit code from your authenticator app'}
              </p>
            </div>

            {!useBackup ? (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-center tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  required
                />
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Backup code</label>
                <input
                  type="text"
                  value={backupCode}
                  onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                  placeholder="XXXXXXXX"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-center tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  required
                />
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading || (!useBackup && totpCode.length !== 6) || (useBackup && !backupCode)}
              className="w-full bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={() => { setUseBackup(b => !b); setTotpCode(''); setBackupCode(''); setError('') }}
              className="w-full text-xs text-slate-500 hover:text-blue-600 transition-colors"
            >
              {useBackup ? '← Use authenticator app instead' : 'Use a backup code instead'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('credentials'); setSession(''); setError('') }}
              className="w-full text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
