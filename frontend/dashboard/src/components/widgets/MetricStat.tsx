import { useQuery } from '@tanstack/react-query'
import { fetchMetricCatalog, fetchMetricValue, fetchMetricSeries } from '../../api/metrics'
import { formatMetricValue } from './shared'
import { MetricSparkline } from './sparklines'
import type { MetricWidgetProps } from './metricWidgetConfig'

export function MetricStat({ config, refreshIntervalS = 60 }: MetricWidgetProps) {
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

  const { data: seriesData } = useQuery({
    queryKey: ['metric-series', metric_id, device_id, interface_name, 60],
    queryFn:  () => fetchMetricSeries({ metric_id: metric_id!, device_id: device_id!, interface_name, range_minutes: 60 }),
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

  const unit  = data?.unit ?? seriesData?.unit ?? def?.unit ?? ''
  const value = data?.value ?? null
  const thresholds = config.thresholds ?? def?.thresholds ?? null

  let valueColor = '#1e293b'
  if (thresholds && value !== null) {
    if (value >= thresholds.crit) valueColor = '#dc2626'
    else if (value >= thresholds.warn) valueColor = '#d97706'
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex flex-col">
      <h3 className="text-sm font-semibold text-slate-800 truncate">{title}</h3>
      {config.interface_name && <p className="text-[10px] text-slate-400 truncate">{config.device_name ? `${config.device_name} — ` : ''}{config.interface_name}</p>}
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <div className="text-3xl font-bold tabular-nums" style={{ color: valueColor }}>
          {isLoading ? '…' : formatMetricValue(value, unit)}
        </div>
        {seriesData && seriesData.series.length >= 2 && (
          <MetricSparkline series={seriesData.series} w={140} h={36} color={valueColor === '#1e293b' ? '#3b82f6' : valueColor} />
        )}
      </div>
    </div>
  )
}
