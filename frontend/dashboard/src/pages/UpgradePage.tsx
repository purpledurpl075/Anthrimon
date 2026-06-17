import { Link, useSearchParams } from 'react-router-dom'
import { useLicense } from '../hooks/useLicense'
import { useCurrentUser } from '../hooks/useCurrentUser'
import { PAID_FEATURES, featureByKey } from '../features'

function LockIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export default function UpgradePage() {
  const [params] = useSearchParams()
  const { data: lic } = useLicense()
  const { data: me } = useCurrentUser()
  const feature = featureByKey(params.get('feature')) ?? PAID_FEATURES[0]

  const licensed = !!lic?.valid && (lic.modules.includes('*') || lic.modules.includes(feature.key))

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 p-2 rounded-lg ${licensed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {licensed ? <CheckIcon /> : <LockIcon />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-800">{feature.label}</h1>
            {licensed
              ? <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">Active</span>
              : <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">Premium</span>}
          </div>
          <p className="text-sm text-slate-500 mt-0.5">{feature.tagline}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">What you get</h2>
        <ul className="space-y-2">
          {feature.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2 text-sm text-slate-700">
              <span className="mt-0.5 text-blue-500"><CheckIcon /></span>{b}
            </li>
          ))}
        </ul>
      </div>

      {licensed ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-5 text-sm text-emerald-800">
          This feature is licensed and active on this server
          {lic?.expires_at ? ` until ${lic.expires_at.slice(0, 10)}` : ''}.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-800">How to enable</h2>
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-slate-700">
            <li>In <span className="font-medium">Platform Admin → License</span>, download this server's license request.</li>
            <li>Send it to Anthrimon to receive a license file enabling <code className="text-xs bg-slate-100 px-1 rounded">{feature.key}</code>.</li>
            <li>Upload the license file in the same place — the feature unlocks immediately, no restart.</li>
          </ol>
          {me?.is_platform_admin ? (
            <Link to="/platform" className="inline-block px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
              Go to License management
            </Link>
          ) : (
            <p className="text-xs text-slate-500">Ask a platform administrator to apply a license.</p>
          )}
        </div>
      )}

      {/* Other premium features */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Other premium features</h2>
        <div className="flex flex-wrap gap-2">
          {PAID_FEATURES.filter((f) => f.key !== feature.key).map((f) => (
            <Link key={f.key} to={`/upgrade?feature=${f.key}`}
              className="px-3 py-1.5 text-sm rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
              {f.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
