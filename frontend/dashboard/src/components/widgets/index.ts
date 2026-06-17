import type { ComponentType } from 'react'
import { StatCardsRow } from './StatCardsRow'
import { AlertSeverityBar } from './AlertSeverityBar'
import { DeviceTypeGrid } from './DeviceTypeGrid'
import { TopBandwidthSection } from './TopBandwidthSection'
import { ProblemDevices } from './ProblemDevices'
import { OpenAlerts } from './OpenAlerts'
import { TopAlertingDevices } from './TopAlertingDevices'
import { RecentlyResolved } from './RecentlyResolved'
import { BGPSummaryWidget } from './BGPSummaryWidget'
import { InterfaceHealthWidget } from './InterfaceHealthWidget'
import { TopCpuWidget } from './TopCpuWidget'
import { TopMemoryWidget } from './TopMemoryWidget'
import { RoutingHealthWidget } from './RoutingHealthWidget'
import { ConfigChangesWidget } from './ConfigChangesWidget'
import { CollectorStatusWidget } from './CollectorStatusWidget'
import { SyslogRateWidget } from './SyslogRateWidget'
import { AlertTimelineWidget } from './AlertTimelineWidget'
import { SyslogFeedWidget } from './SyslogFeedWidget'
import { SyslogHeatmapWidget } from './SyslogHeatmapWidget'
import { BGPPrefixTotalsWidget } from './BGPPrefixTotalsWidget'
import { BGPFlapLogWidget } from './BGPFlapLogWidget'
import { OSPFAreasWidget } from './OSPFAreasWidget'
import { MetricGauge } from './MetricGauge'
import { MetricStat } from './MetricStat'
import { MetricGraph } from './MetricGraph'
import { TextNote } from './TextNote'

export * from './StatCardsRow'
export * from './AlertSeverityBar'
export * from './DeviceTypeGrid'
export * from './TopBandwidthSection'
export * from './ProblemDevices'
export * from './OpenAlerts'
export * from './TopAlertingDevices'
export * from './RecentlyResolved'
export * from './BGPSummaryWidget'
export * from './InterfaceHealthWidget'
export * from './TopCpuWidget'
export * from './TopMemoryWidget'
export * from './RoutingHealthWidget'
export * from './ConfigChangesWidget'
export * from './CollectorStatusWidget'
export * from './SyslogRateWidget'
export * from './AlertTimelineWidget'
export * from './SyslogFeedWidget'
export * from './SyslogHeatmapWidget'
export * from './BGPPrefixTotalsWidget'
export * from './BGPFlapLogWidget'
export * from './OSPFAreasWidget'
export * from './sparklines'
export * from './icons'
export * from './shared'
export * from './metricWidgetConfig'
export * from './MetricGauge'
export * from './MetricStat'
export * from './MetricGraph'
export * from './TextNote'
export * from './WidgetConfigModal'

// Registry of the 4 generic "metric_*" + "text_note" widget types, keyed by
// the widget type id used in custom-dashboard layouts. Unlike
// WIDGET_COMPONENTS, each of these takes a `config` prop (device/metric/etc).
export const METRIC_WIDGET_COMPONENTS = {
  metric_gauge: MetricGauge,
  metric_stat:  MetricStat,
  metric_graph: MetricGraph,
  text_note:    TextNote,
} as const

// Registry of self-fetching "summary" widget components, keyed by the widget
// type id used in WIDGET_DEFS / dashboard layouts. Shared by OverviewPage's
// renderWidget and the custom-dashboard grid (DashboardGrid).
export const WIDGET_COMPONENTS: Record<string, ComponentType> = {
  stat_cards:           StatCardsRow,
  alert_severity:       AlertSeverityBar,
  device_types:         DeviceTypeGrid,
  top_bandwidth:        TopBandwidthSection,
  problem_devices:      ProblemDevices,
  open_alerts:          OpenAlerts,
  top_alerting_devices: TopAlertingDevices,
  recently_resolved:    RecentlyResolved,
  bgp_summary:          BGPSummaryWidget,
  interface_health:     InterfaceHealthWidget,
  top_cpu:              TopCpuWidget,
  top_memory:           TopMemoryWidget,
  routing_health:       RoutingHealthWidget,
  config_changes:       ConfigChangesWidget,
  collector_status:     CollectorStatusWidget,
  syslog_activity:      SyslogRateWidget,
  alert_timeline:       AlertTimelineWidget,
  syslog_feed:          SyslogFeedWidget,
  syslog_heatmap:       SyslogHeatmapWidget,
  bgp_prefix_totals:    BGPPrefixTotalsWidget,
  bgp_flap_log:         BGPFlapLogWidget,
  ospf_areas:           OSPFAreasWidget,
}
