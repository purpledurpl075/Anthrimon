// Shared config shape for the generic "metric_*" dashboard widgets
// (MetricGauge, MetricStat, MetricGraph) and TextNote. Stored as the
// `config` of a DashboardWidget instance.
export type { MetricWidgetConfig } from '../../api/dashboards'

import type { MetricWidgetConfig } from '../../api/dashboards'

export interface MetricWidgetProps {
  config: MetricWidgetConfig
  refreshIntervalS?: number
  rangeMinutes?: number
}
