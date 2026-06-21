import { useQuery } from '@tanstack/react-query'
import { fetchWidgetData } from '../../api/overview'
export { formatAge } from '../../utils/time'

// ── Helpers ────────────────────────────────────────────────────────────────────

export function fmtBps(bps: number): string {
  if (bps >= 1e9)  return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6)  return `${(bps / 1e6).toFixed(1)} Mbps`
  if (bps >= 1e3)  return `${(bps / 1e3).toFixed(0)} Kbps`
  return `${bps.toFixed(0)} bps`
}

// Formats a generic metric value (from /metrics/query) for display, based on its unit.
export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || Number.isNaN(value)) return '—'
  switch (unit) {
    case '%':     return `${value.toFixed(1)}%`
    case 'bps':   return fmtBps(value)
    case 'ms':    return `${value.toFixed(1)} ms`
    case '°C':    return `${value.toFixed(1)}°C`
    case 'err/s': return `${value.toFixed(2)} err/s`
    default:      return unit ? `${value.toFixed(2)} ${unit}` : value.toFixed(2)
  }
}

export const SEV_ORDER = ['critical', 'major', 'minor', 'warning', 'info'] as const

export const SEV_COLOR: Record<string, string> = {
  critical: '#dc2626', major: '#ea580c', minor: '#d97706',
  warning: '#2563eb', info: '#64748b',
}

export const SEV_BG: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  major:    'bg-orange-100 text-orange-700 border-orange-200',
  minor:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  warning:  'bg-blue-100 text-blue-700 border-blue-200',
  info:     'bg-slate-100 text-slate-600 border-slate-200',
}

export function utilColor(pct: number | null): string {
  if (pct === null) return '#94a3b8'
  if (pct < 30)  return '#16a34a'
  if (pct < 60)  return '#0891b2'
  if (pct < 80)  return '#d97706'
  if (pct < 95)  return '#ea580c'
  return '#dc2626'
}

// BGP session-state colors (BGPSummaryWidget)
export const STATE_COLOR: Record<string, string> = {
  established:  '#16a34a',
  active:       '#d97706',
  connect:      '#2563eb',
  opensent:     '#7c3aed',
  openconfirm:  '#7c3aed',
  idle:         '#94a3b8',
  unknown:      '#94a3b8',
}

// BGP session-state colors (BGPFlapLogWidget)
export const BGP_STATE_COLOR: Record<string, string> = {
  established: '#16a34a', active: '#d97706', idle: '#94a3b8',
  connect: '#2563eb', opensent: '#7c3aed', openconfirm: '#7c3aed', unknown: '#94a3b8',
}

// Syslog severity labels/colors (SyslogFeedWidget)
export const SEV_LABEL: Record<number, string> = { 0: 'EMERG', 1: 'ALERT', 2: 'CRIT', 3: 'ERROR' }
export const SEV_FEED_COLOR: Record<number, string> = { 0: '#7f1d1d', 1: '#991b1b', 2: '#dc2626', 3: '#f97316' }

// ── Shared queries ────────────────────────────────────────────────────────────

export function useWidgetData() {
  return useQuery({ queryKey: ['widget-data'], queryFn: fetchWidgetData, refetchInterval: 60_000, staleTime: 30_000 })
}
