export interface DeviceListItem {
  id: string
  hostname: string
  fqdn: string | null
  mgmt_ip: string
  vendor: string
  device_type: string
  platform: string | null
  status: string
  last_seen: string | null
  is_active: boolean
  tags: string[]
}

export interface PaginatedResponse<T> {
  total: number
  limit: number
  offset: number
  items: T[]
}

export interface Device {
  id: string
  hostname: string
  fqdn: string | null
  mgmt_ip: string
  vendor: string
  device_type: string
  platform: string | null
  os_version: string | null
  serial_number: string | null
  sys_description: string | null
  collection_method: string
  snmp_version: string
  snmp_port: number
  polling_interval_s: number
  status: string
  last_seen: string | null
  last_polled: string | null
  is_active: boolean
  tags: string[]
  notes: string | null
  snmp_engine_id: string | null
  collector_id: string | null
}

export interface Interface {
  id: string
  device_id: string
  if_index: number
  name: string
  description: string | null
  if_type: string | null
  speed_bps: number | null
  mtu: number | null
  mac_address: string | null
  admin_status: string
  oper_status: string
  last_change: string | null
  updated_at: string
}

export interface Alert {
  id: string
  tenant_id: string
  rule_id: string | null
  device_id: string | null
  interface_id: string | null
  severity: 'critical' | 'major' | 'minor' | 'warning' | 'info'
  status: 'open' | 'acknowledged' | 'resolved' | 'suppressed' | 'expired'
  title: string
  message: string | null
  context: Record<string, unknown>
  triggered_at: string
  acknowledged_at: string | null
  resolved_at: string | null
  suppressed_by_alert_id: string | null
  suppressed_child_count: number
  suppressed_children?: SuppressedChildSummary[]
  correlation_id: string | null
  mass_failure_siblings?: SuppressedChildSummary[]
  created_at: string
  updated_at: string
}

export interface SuppressedChildSummary {
  id: string
  title: string
  severity: 'critical' | 'major' | 'minor' | 'warning' | 'info'
  metric: string | null
  device_name: string | null
  triggered_at: string
}

export interface AlertRule {
  id: string
  tenant_id: string
  name: string
  description: string | null
  is_enabled: boolean
  device_selector: Record<string, unknown> | null
  metric: string
  condition: string
  threshold: number | null
  duration_seconds: number
  renotify_seconds: number
  severity: string
  channel_ids: string[]
  maintenance_window_ids: string[]
  escalation_severity: string | null
  escalation_seconds: number | null
  stable_for_seconds: number
  notify_on_resolve: boolean
  custom_oid: string | null
  created_at: string
  updated_at: string
}

export interface HealthData {
  device_id: string
  collected_at: string
  cpu_util_pct: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  mem_util_pct: number | null
  uptime_seconds: number | null
  temperatures: Array<{ sensor: string; celsius: number; ok: boolean }>
}
