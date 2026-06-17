// Registry of license-gated ("paid") features. Each maps to a license module
// key checked via the /license endpoint (is_licensed). Free 1.0 ships with none
// of these licensed — they render locked in the nav and link to /upgrade. When a
// license enabling the key is uploaded (Platform Admin → License), they unlock.
//
// Adding a real paid module later = add its key here (matching the module's
// manifest license_key) plus its real route in `to`.

export interface PaidFeature {
  key: string          // license module key (matches modules/<name>/manifest.yaml license_key)
  label: string        // nav + page title
  category: string     // sidebar section it appears in (only when licensed)
  to: string           // route when licensed (falls back to the upgrade page until a real page ships)
  tagline: string      // one-line value pitch
  bullets: string[]    // feature bullets on the upgrade page
}

export const PAID_FEATURES: PaidFeature[] = [
  {
    key: 'reports',
    label: 'Advanced Reports',
    category: 'Analysis',
    to: '/upgrade?feature=reports',
    tagline: 'Scheduled, branded PDF/CSV reports for capacity, SLA, and inventory.',
    bullets: [
      'Schedule recurring reports and email them to stakeholders',
      'Capacity & utilisation trends across sites and tenants',
      'SLA / uptime summaries with per-device breakdowns',
      'Export to PDF and CSV with your organisation branding',
    ],
  },
  {
    key: 'ai_insights',
    label: 'AI Insights',
    category: 'Monitoring',
    to: '/upgrade?feature=ai_insights',
    tagline: 'Anomaly detection and root-cause hints across metrics, flow, and syslog.',
    bullets: [
      'Automatic baselining and anomaly detection on every metric',
      'Correlates alerts, flow spikes, and syslog into likely root cause',
      'Natural-language search over your telemetry',
      'Proactive "what changed" summaries before users notice',
    ],
  },
]

/** Licensed premium features for a given sidebar category. */
export const licensedFeaturesIn = (
  category: string,
  isLicensed: (key: string) => boolean,
): PaidFeature[] => PAID_FEATURES.filter((f) => f.category === category && isLicensed(f.key))

export const featureByKey = (k: string | null | undefined): PaidFeature | undefined =>
  PAID_FEATURES.find((f) => f.key === k)
