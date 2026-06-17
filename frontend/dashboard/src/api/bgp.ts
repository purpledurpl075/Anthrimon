import api from './client'

export interface BGPSession {
  id:                  string
  device_id:           string
  device_name:         string
  vrf:                 string
  peer_ip:             string
  peer_asn:            number | null
  local_asn:           number
  peer_router_id:      string | null
  peer_description:    string | null
  admin_status:        string
  session_type:        'iBGP' | 'eBGP'
  session_state:       string
  state_color:         string
  prefixes_received:   number | null
  prefixes_advertised: number | null
  uptime_seconds:      number | null
  in_updates:          number
  out_updates:         number
  flap_count:          number
  last_state_change:   string | null
  updated_at:          string
}

export interface BGPSessionEvent {
  id:          string
  prev_state:  string
  new_state:   string
  recorded_at: string
}

export interface BGPSummary {
  total:        number
  established:  number
  down:         number
  by_state:     Record<string, number>
  top_flappers: Array<{
    session_id:  string
    device_name: string
    peer_ip:     string
    peer_asn:    number | null
    flap_count:  number
    state:       string
  }>
}

export const fetchDeviceBGPSessions = (deviceId: string) =>
  api.get<BGPSession[]>(`/bgp/devices/${deviceId}/sessions`).then(r => r.data)

export const fetchAllBGPSessions = (state?: string) =>
  api.get<BGPSession[]>('/bgp/sessions', { params: state ? { state } : {} }).then(r => r.data)

export const fetchBGPSummary = () =>
  api.get<BGPSummary>('/bgp/summary').then(r => r.data)

export const fetchBGPSessionEvents = (sessionId: string) =>
  api.get<BGPSessionEvent[]>(`/bgp/sessions/${sessionId}/events`).then(r => r.data)

export interface BGPPrefixTotals {
  sessions:      number
  established:   number
  total_rx:      number
  total_tx:      number
  top_receivers: { device: string; peer_ip: string; peer_asn: number | null; prefixes_rx: number }[]
}

export interface BGPFlapEvent {
  recorded_at: string
  device:      string
  peer_ip:     string
  peer_asn:    number | null
  prev_state:  string
  new_state:   string
}

export interface OSPFArea {
  area:      string
  vrf:       string
  total:     number
  full:      number
  not_full:  number
}

export const fetchBGPPrefixTotals = () =>
  api.get<BGPPrefixTotals>('/bgp/prefix-totals').then(r => r.data)

export const fetchBGPFlapLog = (limit = 20) =>
  api.get<BGPFlapEvent[]>('/bgp/flap-log', { params: { limit } }).then(r => r.data)

export const fetchOSPFAreas = () =>
  api.get<OSPFArea[]>('/bgp/ospf-areas').then(r => r.data)

export interface OSPFNeighbor {
  id:                 string
  device_id:          string
  device_name:        string
  vrf:                string
  neighbor_router_id: string | null
  neighbor_ip:        string | null
  interface_name:     string | null
  area:               string
  state:              string
  priority:           number | null
  uptime_seconds:     number | null
  last_state_change:  string | null
}

export const fetchOSPFNeighbors = () =>
  api.get<OSPFNeighbor[]>('/bgp/ospf-neighbors').then(r => r.data)

// ── IS-IS ─────────────────────────────────────────────────────────────────────

export interface ISISNeighbor {
  id:               string
  device_id:        string
  device_name:      string
  instance:         string
  sys_id:           string
  hostname:         string | null
  interface_name:   string | null
  circuit_type:     string
  adjacency_state:  string
  ipv4_address:     string | null
  ipv6_address:     string | null
  uptime_seconds:   number | null
  last_state_change: string | null
}

export interface ISISSummary {
  total:   number
  up:      number
  down:    number
  devices: number
}

export interface ISISArea {
  device_id:   string
  device_name: string
  instance:    string
  area_addr:   string
}

export const fetchISISNeighbors = () =>
  api.get<ISISNeighbor[]>('/bgp/isis-neighbors').then(r => r.data)

export const fetchISISSummary = () =>
  api.get<ISISSummary>('/bgp/isis-summary').then(r => r.data)

export const fetchISISAreas = () =>
  api.get<ISISArea[]>('/bgp/isis-areas').then(r => r.data)

export interface RouteEntryDTO {
  device_id:      string
  device_name:    string
  destination:    string
  next_hop:       string | null
  metric:         number | null
  interface_name: string | null
  updated_at:     string
}

export const fetchRoutes = (protocol: 'bgp' | 'ospf' | 'isis') =>
  api.get<RouteEntryDTO[]>('/bgp/routes', { params: { protocol } }).then(r => r.data)

export interface ISISCircuitLevel {
  device_id:      string
  device_name:    string
  instance:       string
  interface_name: string
  level:          string
  metric:         number | null
  hello_interval: number | null
  hold_timer:     number | null
  priority:       number | null
  dis_id:         string | null
  updated_at:     string
}

export const fetchISISCircuitLevels = () =>
  api.get<ISISCircuitLevel[]>('/bgp/isis-circuit-levels').then(r => r.data)

export interface ISISLsp {
  device_id:          string
  device_name:        string
  instance:           string
  level:              string
  lsp_id:             string
  sequence_number:    number | null
  checksum:           number | null
  remaining_lifetime: number | null
  pdu_length:         number | null
  overload_bit:       boolean
  attached_bit:       boolean
  updated_at:         string
}

export const fetchISISLsps = () =>
  api.get<ISISLsp[]>('/bgp/isis-lsps').then(r => r.data)

export interface ISISTopologyNode {
  id:      string
  label:   string
  area:    string | null
  managed: boolean
}

export interface ISISTopologyEdge {
  source: string
  target: string
  level:  string
  state:  string
}

export interface ISISTopology {
  nodes: ISISTopologyNode[]
  edges: ISISTopologyEdge[]
}

export const fetchISISTopology = () =>
  api.get<ISISTopology>('/bgp/isis-topology').then(r => r.data)

// ── BGP prefix history (time-series from VictoriaMetrics) ─────────────────

export interface BGPPeerSeries {
  peer_ip:  string
  peer_asn: string
  values:   [number, number][]  // [timestamp_ms, value]
}

export interface BGPPrefixHistory {
  prefix_count: BGPPeerSeries[]
  update_rate:  BGPPeerSeries[]
}

export const fetchBGPPrefixHistory = (deviceId: string, hours = 24) =>
  api.get<BGPPrefixHistory>(`/bgp/devices/${deviceId}/prefix-history`, { params: { hours } })
    .then(r => r.data)
