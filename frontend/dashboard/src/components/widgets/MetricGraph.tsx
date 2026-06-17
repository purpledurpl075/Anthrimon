import { useQuery } from '@tanstack/react-query'
import TimeSeriesChart from '../TimeSeriesChart'
import { fetchMetricCatalog, fetchMetricSeries } from '../../api/metrics'
import { formatMetricValue } from './shared'
import type { MetricWidgetProps } from './metricWidgetConfig'

export function MetricGraph({ config, refreshIntervalS = 60, rangeMinutes = 60 }: MetricWidgetProps) {
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
    queryKey: ['metric-series', metric_id, device_id, interface_name, rangeMinutes],
    queryFn:  () => fetchMetricSeries({ metric_id: metric_id!, device_id: device_id!, interface_name, range_minutes: rangeMinutes }),
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

  const unit   = data?.unit ?? def?.unit ?? ''
  const series = data?.series ?? []

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex flex-col">
      <h3 className="text-sm font-semibold text-slate-800 truncate mb-1">{title}</h3>
      {config.interface_name && <p className="text-[10px] text-slate-400 -mt-1 mb-2 truncate">{config.device_name ? `${config.device_name} — ` : ''}{config.interface_name}</p>}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-400">Loading…</div>
        ) : (
          <TimeSeriesChart
            series={[{ name: title, color: '#3b82f6', data: series }]}
            height={180}
            yFmt={v => formatMetricValue(v, unit)}
            empty="No data"
          />
        )}
      </div>
    </div>
  )
}
