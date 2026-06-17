import { useQuery } from '@tanstack/react-query'
import { fetchMetricCatalog, fetchMetricValue } from '../../api/metrics'
import { formatMetricValue } from './shared'
import type { MetricWidgetProps } from './metricWidgetConfig'

// ── 270° arc gauge geometry ──────────────────────────────────────────────────
// 0deg = top (12 o'clock), increasing clockwise. The gauge spans 270deg with a
// 90deg gap centered at the bottom, i.e. from 225deg (bottom-left) clockwise
// through the top to 135deg (bottom-right).

const START_ANGLE = 225
const SWEEP = 270
const CX = 100
const CY = 100
const R = 80
const SW = 16

function polarToCartesian(angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: CX + R * Math.cos(rad), y: CY + R * Math.sin(rad) }
}

function arcPath(startAngle: number, endAngle: number): string {
  const sweep = endAngle - startAngle
  if (sweep <= 0) return ''
  const start = polarToCartesian(startAngle)
  const end = polarToCartesian(endAngle)
  const largeArc = sweep > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${R} ${R} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

const ZONE_COLORS = { ok: '#16a34a', warn: '#d97706', crit: '#dc2626', track: '#e2e8f0' }

export function MetricGauge({ config, refreshIntervalS = 60 }: MetricWidgetProps) {
  const { device_id, metric_id, interface_name } = config
  const configured = !!device_id && !!metric_id

  const { data: catalog } = useQuery({
    queryKey: ['metric-catalog'],
    queryFn:  fetchMetricCatalog,
    staleTime: 300_000,
  })
  const def = catalog?.find(m => m.id === metric_id)
  const title = config.title || def?.label || 'Metric'

  const { data, isLoading } = useQuery({
    queryKey: ['metric-value', metric_id, device_id, interface_name],
    queryFn:  () => fetchMetricValue({ metric_id: metric_id!, device_id: device_id!, interface_name }),
    enabled:  configured,
    refetchInterval: refreshIntervalS * 1000,
    staleTime:       Math.floor(refreshIntervalS * 1000 / 2),
  })

  if (!configured) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex flex-col items-center justify-center text-center gap-1">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="text-xs text-slate-400">Click configure to pick a device and metric</p>
      </div>
    )
  }

  const unit  = data?.unit ?? def?.unit ?? ''
  const value = data?.value ?? null
  const thresholds = config.thresholds ?? def?.thresholds ?? null
  const max = config.max ?? def?.default_max ?? (
    thresholds ? thresholds.crit * 1.25 : value !== null ? Math.max(value * 1.25, 1) : 100
  )

  const frac = value !== null && max > 0 ? Math.min(1, Math.max(0, value / max)) : 0

  let valueColor: string = ZONE_COLORS.ok
  if (thresholds && value !== null) {
    if (value >= thresholds.crit) valueColor = ZONE_COLORS.crit
    else if (value >= thresholds.warn) valueColor = ZONE_COLORS.warn
  }

  const warnFrac = thresholds ? Math.min(1, Math.max(0, thresholds.warn / max)) : null
  const critFrac = thresholds ? Math.min(1, Math.max(0, thresholds.crit / max)) : null

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex flex-col">
      <h3 className="text-sm font-semibold text-slate-800 truncate">{title}</h3>
      {config.interface_name && <p className="text-[10px] text-slate-400 truncate">{config.device_name ? `${config.device_name} — ` : ''}{config.interface_name}</p>}
      <div className="flex-1 flex items-center justify-center min-h-0">
        <svg viewBox="0 0 200 200" className="w-full h-full max-w-[180px]">
          {thresholds && warnFrac != null && critFrac != null ? (
            <>
              <path d={arcPath(START_ANGLE, START_ANGLE + SWEEP * warnFrac)} stroke={ZONE_COLORS.ok} strokeOpacity={0.18} strokeWidth={SW} fill="none" />
              <path d={arcPath(START_ANGLE + SWEEP * warnFrac, START_ANGLE + SWEEP * critFrac)} stroke={ZONE_COLORS.warn} strokeOpacity={0.18} strokeWidth={SW} fill="none" />
              <path d={arcPath(START_ANGLE + SWEEP * critFrac, START_ANGLE + SWEEP)} stroke={ZONE_COLORS.crit} strokeOpacity={0.18} strokeWidth={SW} fill="none" />
            </>
          ) : (
            <path d={arcPath(START_ANGLE, START_ANGLE + SWEEP)} stroke={ZONE_COLORS.track} strokeWidth={SW} fill="none" strokeLinecap="round" />
          )}
          {frac > 0 && (
            <path d={arcPath(START_ANGLE, START_ANGLE + SWEEP * frac)} stroke={valueColor} strokeWidth={SW} fill="none" strokeLinecap="round" />
          )}
          <text x={CX} y={CY - 2} textAnchor="middle" fontSize={26} fontWeight={700} fill="#1e293b">
            {isLoading ? '…' : formatMetricValue(value, unit)}
          </text>
          {config.device_name && (
            <text x={CX} y={CY + 26} textAnchor="middle" fontSize={11} fill="#94a3b8">{config.device_name}</text>
          )}
        </svg>
      </div>
    </div>
  )
}
