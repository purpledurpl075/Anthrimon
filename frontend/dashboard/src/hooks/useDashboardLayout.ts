// ── Widget registry ───────────────────────────────────────────────────────────

export interface WidgetDef {
  id: string
  label: string
  description: string
  defaultW: number  // columns (1–12)
  defaultH: number  // rows (each ~120px)
  minW?: number
  minH?: number
}

export const WIDGET_DEFS: WidgetDef[] = [
  { id: 'stat_cards',           label: 'Stat cards',            description: 'Device counts, alert totals, poll health',  defaultW: 12, defaultH: 2, minH: 2 },
  { id: 'alert_severity',       label: 'Alert severity',        description: 'Open alerts by severity',                    defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'device_types',         label: 'Device types',          description: 'Device count by type',                       defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'top_bandwidth',        label: 'Top bandwidth',         description: 'Busiest interfaces and devices',             defaultW: 12, defaultH: 4, minH: 3 },
  { id: 'problem_devices',      label: 'Problem devices',       description: 'Down or unreachable devices',                defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'open_alerts',          label: 'Open alerts',           description: 'Highest-severity open alerts',               defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'top_alerting_devices', label: 'Top alerting devices',  description: 'Devices with the most open alerts',          defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'recently_resolved',    label: 'Recently resolved',     description: 'Alerts resolved in the last hour',           defaultW: 12, defaultH: 3, minH: 2 },
  { id: 'bgp_summary',          label: 'BGP summary',           description: 'BGP session health across all devices',       defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'interface_health',     label: 'Interface health',      description: 'Up / Down / Admin-down breakdown',            defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'top_cpu',              label: 'Top CPU',               description: 'Top 5 devices by current CPU%',              defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'top_memory',           label: 'Top memory',            description: 'Top 5 devices by current memory%',           defaultW: 4,  defaultH: 3, minH: 2 },
  { id: 'routing_health',       label: 'Routing health',        description: 'BGP and OSPF session summary',               defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'config_changes',       label: 'Config changes',        description: 'Devices with config changes in last 24 h',   defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'collector_status',     label: 'Collector status',      description: 'Remote collector health',                    defaultW: 4,  defaultH: 2, minH: 2 },
  { id: 'syslog_activity',      label: 'Syslog activity',       description: 'Syslog message counts by severity',          defaultW: 4,  defaultH: 2, minH: 2 },
  { id: 'alert_timeline',       label: 'Alert timeline',        description: 'Hourly alert count over last 24 h',          defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'syslog_feed',          label: 'Syslog live feed',      description: 'Last 10 critical/emergency messages',         defaultW: 6,  defaultH: 4, minH: 3 },
  { id: 'syslog_heatmap',       label: 'Syslog heatmap',        description: 'Message intensity by hour × day (7 days)',   defaultW: 8,  defaultH: 3, minH: 2 },
  { id: 'bgp_prefix_totals',    label: 'BGP prefix totals',     description: 'Total prefixes received and advertised',     defaultW: 6,  defaultH: 3, minH: 2 },
  { id: 'bgp_flap_log',         label: 'BGP flap log',          description: 'Recent BGP state transitions',               defaultW: 6,  defaultH: 4, minH: 3 },
  { id: 'ospf_areas',           label: 'OSPF areas',            description: 'Neighbor counts per OSPF area',              defaultW: 4,  defaultH: 3, minH: 2 },
]
