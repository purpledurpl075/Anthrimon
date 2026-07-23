import api from './client'

export interface OverviewData {
  devices: {
    total: number
    up: number
    down: number
    unreachable: number
    unknown: number
    by_type: Record<string, number>
  }
  alerts: {
    open: number
    critical: number
    major: number
    by_severity: Record<string, number>
  }
  interfaces_down: number
  poll_health: {
    polled_recently: number
    total_active: number
  }
  last_polled_at: string | null
  problem_devices: {
    id: string
    hostname: string
    mgmt_ip: string
    vendor: string
    device_type: string
    status: string
    last_seen: string | null
  }[]
  recent_alerts: {
    id: string
    title: string
    severity: string
    triggered_at: string | null
    device_id: string | null
  }[]
  top_alerting_devices: {
    device_id: string
    hostname: string
    device_type: string
    count: number
  }[]
  alert_trend: [number, number][]
  recently_resolved: {
    id: string
    title: string
    severity: string
    resolved_at: string | null
    device_id: string | null
  }[]
  generated_at: string
}

export interface TopInterface {
  device_id: string
  device_name: string
  device_type: string
  iface_id: string
  iface_name: string
  speed_bps: number | null
  current_in_bps: number
  current_out_bps: number
  util_pct: number | null
  in_series: [number, number][]
  out_series: [number, number][]
}

export interface TopDevice {
  device_id: string
  device_name: string
  device_type: string
  total_bps: number
}

export interface TopBandwidthData {
  top_interfaces: TopInterface[]
  top_devices: TopDevice[]
}

export const fetchOverview = () =>
  api.get<OverviewData>('/overview').then(r => r.data)

export const fetchTopBandwidth = (limit = 8, windowMinutes = 30) =>
  api.get<TopBandwidthData>('/overview/top-bandwidth', { params: { limit, window_minutes: windowMinutes } }).then(r => r.data)

export interface TopResourcesData {
  cpu:    { device_id: string; hostname: string; device_type: string; cpu_pct: number }[]
  memory: { device_id: string; hostname: string; device_type: string; mem_pct: number }[]
}

export interface WidgetData {
  interface_health: { up: number; down: number; admin_down: number; total: number }
  routing_health: {
    bgp:  { total: number; established: number; by_state: Record<string, number> }
    ospf: { total: number; full: number; by_state: Record<string, number> }
  }
  config_changes: { device_id: string; hostname: string; vendor: string; collected_at: string; lines_added: number; lines_removed: number }[]
  collector_status: { name: string; status: string; last_seen: string | null }[]
  // Names of sections that failed to load server-side (query error) — that
  // section's field above is a fallback empty value, not a real zero/empty state.
  errors: string[]
}

export const fetchTopResources = (limit = 5) =>
  api.get<TopResourcesData>('/overview/top-resources', { params: { limit } }).then(r => r.data)

export const fetchWidgetData = () =>
  api.get<WidgetData>('/overview/widget-data').then(r => r.data)

export interface SyslogHeatmapCell { dow: number; hr: number; count: number }

export const fetchSyslogHeatmap = () =>
  api.get<SyslogHeatmapCell[]>('/syslog/heatmap').then(r => r.data)

export const fetchSyslogMessages = (severityMax: number, limit: number) =>
  api.get<{ messages: any[] }>('/syslog/messages', { params: { severity_max: severityMax, limit, minutes: 1440 } }).then(r => r.data)
