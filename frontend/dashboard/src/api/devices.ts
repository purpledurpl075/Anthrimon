import api from './client'
import type { Device, DeviceListItem, HealthData, Interface, PaginatedResponse } from './types'

export const fetchDevices = (params?: { limit?: number; offset?: number }) =>
  api.get<PaginatedResponse<DeviceListItem>>('/devices', { params }).then((r) => r.data)

export const fetchDevice = (id: string) =>
  api.get<Device>(`/devices/${id}`).then((r) => r.data)

export const fetchDeviceInterfaces = (id: string) =>
  api.get<Interface[]>(`/devices/${id}/interfaces`).then((r) => r.data)

export const fetchDeviceHealth = (id: string) =>
  api.get<HealthData>(`/devices/${id}/health`).then((r) => r.data)

export interface HealthHistory {
  cpu_pct:     [number, number][]
  mem_pct:     [number, number][]
  mem_used:    [number, number][]
  mem_total:   [number, number][]
  temp_series: Record<string, [number, number][]>
  dom_tx:      Record<string, [number, number][]>
  dom_rx:      Record<string, [number, number][]>
  dom_tx_now:  Record<string, number>
  dom_rx_now:  Record<string, number>
}

export const fetchDeviceHealthHistory = (id: string, hours: number) =>
  api.get<HealthHistory>(`/devices/${id}/health/history`, { params: { hours } }).then(r => r.data)

export const deleteDevice = (id: string) =>
  api.delete(`/devices/${id}`)

export const patchDevice = (id: string, data: Record<string, unknown>) =>
  api.patch<Device>(`/devices/${id}`, data).then((r) => r.data)

export const setAlertExclusions = (id: string, metrics: string[], interface_ids: string[]) =>
  api.put(`/devices/${id}/alert-exclusions`, { metrics, interface_ids }).then(r => r.data)

export const login = (username: string, password: string) =>
  api.post<{ access_token: string }>('/auth/login', { username, password }).then((r) => r.data)

export interface DeviceCredentialEntry {
  credential_id: string
  name: string
  type: string
  priority: number
}

export interface SnmpDiagResult {
  success: boolean
  credential_name: string
  credential_type: string
  response_ms: number | null
  results: { oid: string; value: string }[]
  error: string | null
}

export const fetchDeviceCredentials = (id: string) =>
  api.get<DeviceCredentialEntry[]>(`/devices/${id}/credentials`).then(r => r.data)

export const linkDeviceCredential = (id: string, credential_id: string, priority: number) =>
  api.post(`/devices/${id}/credentials`, { credential_id, priority })

export const unlinkDeviceCredential = (deviceId: string, credentialId: string) =>
  api.delete(`/devices/${deviceId}/credentials/${credentialId}`)

export const runSnmpDiag = (id: string) =>
  api.post<SnmpDiagResult>(`/devices/${id}/snmp-diag`).then(r => r.data)

export interface LLDPNeighborEntry {
  local_port: string
  remote_system_name: string | null
  remote_port: string | null
  remote_chassis_id: string | null
  remote_chassis_id_subtype: string | null
  remote_mgmt_ip: string | null
  capabilities: string[]
  updated_at: string
}

export interface CDPNeighborEntry {
  local_port: string
  remote_device: string | null
  remote_port: string | null
  remote_mgmt_ip: string | null
  platform: string | null
  capabilities: string[]
  native_vlan: number | null
  duplex: string | null
  updated_at: string
}

export interface NeighborsResponse {
  lldp: LLDPNeighborEntry[]
  cdp: CDPNeighborEntry[]
}

export const fetchDeviceNeighbors = (id: string) =>
  api.get<NeighborsResponse>(`/devices/${id}/neighbors`).then(r => r.data)

export interface OSPFNeighborEntry {
  neighbor_ip: string | null
  router_id: string | null
  display_name?: string | null
  state: string
  area: string | null
  interface_name: string | null
  priority: number | null
  last_state_change: string | null
  updated_at: string
  inferred: boolean
}

export const fetchDeviceOSPF = (id: string) =>
  api.get<OSPFNeighborEntry[]>(`/devices/${id}/ospf`).then(r => r.data)

export interface RouteEntry {
  destination: string
  next_hop: string | null
  protocol: string
  metric: number | null
  interface_name: string | null
  updated_at: string
}

export const fetchDeviceRoutes = (id: string, protocol?: string) =>
  api.get<RouteEntry[]>(`/devices/${id}/routes`, { params: protocol ? { protocol } : undefined }).then(r => r.data)

export interface AddressEntry {
  type: 'arp' | 'mac'
  ip: string | null
  mac: string
  port: string | null
  port_iface_id: string | null
  vlan_interface: string | null
  vlan: number | null
  entry_type: string
  updated_at: string
}

export interface AddressesResponse {
  total: number
  limit: number
  offset: number
  items: AddressEntry[]
}

export const fetchDeviceAddresses = (id: string, params?: { search?: string; type?: string; limit?: number; offset?: number }) =>
  api.get<AddressesResponse>(`/devices/${id}/addresses`, { params }).then(r => r.data)

export interface GlobalAddressEntry extends AddressEntry {
  device_id: string
  device_name: string
}

export interface GlobalAddressesResponse {
  total: number
  limit: number
  offset: number
  items: GlobalAddressEntry[]
}

export const fetchAllAddresses = (params?: { search?: string; type?: string; device_id?: string; limit?: number; offset?: number }) =>
  api.get<GlobalAddressesResponse>('/devices/addresses', { params }).then(r => r.data)

export interface VlanPort { interface: string; tagged: boolean }
export interface VlanEntry { vlan_id: number; name: string | null; ports: VlanPort[] }
export interface StpPort { interface: string; state: string; role: string }

export const fetchDeviceVlans = (deviceId: string) =>
  api.get<VlanEntry[]>(`/devices/${deviceId}/vlans`).then(r => r.data)

export const fetchDeviceStp = (deviceId: string) =>
  api.get<StpPort[]>(`/devices/${deviceId}/stp`).then(r => r.data)

// ── Traps ─────────────────────────────────────────────────────────────────────

export interface TrapEvent {
  id:           string
  device_id:    string
  hostname:     string
  source_ip:    string
  trap_type:    string
  oid:          string
  severity:     string
  varbinds:     { oid: string; type: string; value: string }[]
  snmp_version: string
  received_at:  string
}

export const fetchDeviceTraps = (deviceId: string, days = 7) =>
  api.get<{ items: TrapEvent[] }>(`/traps/device/${deviceId}`, { params: { days } }).then(r => r.data)

export const fetchTraps = (params: {
  device_id?: string; trap_type?: string; days?: number; limit?: number; offset?: number
}) =>
  api.get<{ total: number; items: TrapEvent[] }>('/traps', { params }).then(r => r.data)

// ── Baselines ──────────────────────────────────────────────────────────────────

export interface BaselineRow {
  id:             string
  bucket_type:    string
  bucket_index:   number
  interface_id:   string | null
  interface_name: string | null
  label:          string | null
  window_days:    number
  normal_up_pct:  number | null  // 0.0–1.0; null = no baseline yet
  mean:           number | null
  stddev:         number | null
  p5:             number | null
  p95:            number | null
  sample_count:   number | null
  force_alert:    boolean
  force_suppress: boolean
  computed_at:    string | null
}

export interface DeviceBaselines {
  device_id: string
  /** Keyed by metric_type, e.g. 'interface_down', 'cpu_util_pct' */
  baselines: Record<string, BaselineRow[]>
}

export const fetchDeviceBaselines = (id: string) =>
  api.get<DeviceBaselines>(`/devices/${id}/baselines`).then(r => r.data)

export interface LatencyHistory {
  rtt_avg_ms: [number, number][]
  rtt_min_ms: [number, number][]
  rtt_max_ms: [number, number][]
  loss_pct:   [number, number][]
}

export const fetchDeviceLatency = (id: string, hours: number) =>
  api.get<LatencyHistory>(`/devices/${id}/latency`, { params: { hours } }).then(r => r.data)

export interface CreateDevicePayload {
  mgmt_ip: string
  snmp_port: number
  credential_id?: string
  collector_id?: string
}

export const createDevice = (data: CreateDevicePayload) =>
  api.post<{ id: string }>('/devices', data).then(r => r.data)

export const overrideBaseline = (
  deviceId: string,
  metricType: string,
  force_alert: boolean,
  force_suppress: boolean,
  label?: string,
) => {
  const qs = label ? `?label=${encodeURIComponent(label)}` : ''
  return api.post(
    `/devices/${deviceId}/baselines/${metricType}/override${qs}`,
    { force_alert, force_suppress },
  )
}
