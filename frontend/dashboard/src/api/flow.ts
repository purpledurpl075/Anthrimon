import api from './client'

export interface FlowSummary {
  bytes_total:      number
  packets_total:    number
  flows_total:      number
  unique_src_ips:   number
  unique_dst_ips:   number
  active_exporters: number
}

export interface TopTalker {
  src_ip:        string
  dst_ip:        string
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface TopPort {
  dst_port:      number
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface ProtocolPoint {
  ts_ms:         number
  protocol:      number
  protocol_name: string
  bytes_total:   number
  packets_total: number
}

export interface TopDevice {
  device_id:     string
  device_name:   string
  device_type:   string
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface TimeseriesPoint {
  ts_ms:         number
  bytes_total:   number
  packets_total: number
  flow_count:    number
}

export interface FlowRecord {
  device_id:       string
  exporter_ip:     string
  flow_type:       string
  flow_start_ms:   number
  flow_end_ms:     number
  src_ip:          string
  dst_ip:          string
  src_port:        number
  dst_port:        number
  protocol:        number
  protocol_name:   string
  tcp_flags:       number
  bytes:           number
  packets:         number
  input_if_index:  number
  output_if_index: number
  src_asn:         number
  dst_asn:         number
  sampling_rate:   number
}

export interface InterfaceBreakdownRow {
  input_if_index:  number
  input_if_name:   string
  output_if_index: number
  output_if_name:  string
  bytes_total:     number
  packets_total:   number
  flow_count:      number
}

const p = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))

export const fetchFlowSummary = (minutes: number, deviceId?: string) =>
  api.get<FlowSummary>('/flow/summary', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchTopTalkers = (minutes: number, limit: number, deviceId?: string, protocol?: number) =>
  api.get<TopTalker[]>('/flow/top-talkers', { params: p({ minutes, limit, device_id: deviceId, protocol }) }).then(r => r.data)

export const fetchTopPorts = (minutes: number, limit: number, deviceId?: string) =>
  api.get<TopPort[]>('/flow/top-ports', { params: p({ minutes, limit, device_id: deviceId }) }).then(r => r.data)

export const fetchProtocolBreakdown = (minutes: number, deviceId?: string) =>
  api.get<ProtocolPoint[]>('/flow/protocol-breakdown', { params: p({ minutes, device_id: deviceId }) }).then(r => r.data)

export const fetchTopDevices = (minutes: number, limit = 10) =>
  api.get<TopDevice[]>('/flow/top-devices', { params: p({ minutes, limit }) }).then(r => r.data)

export const fetchFlowTimeseries = (minutes: number, deviceId?: string, srcIp?: string, dstIp?: string) =>
  api.get<TimeseriesPoint[]>('/flow/timeseries', { params: p({ minutes, device_id: deviceId, src_ip: srcIp, dst_ip: dstIp }) }).then(r => r.data)

export const searchFlows = (params: {
  device_id?: string; src_ip?: string; dst_ip?: string
  protocol?: number; src_port?: number; dst_port?: number
  minutes?: number; limit?: number
}) => api.get<FlowRecord[]>('/flow/search', { params: p(params) }).then(r => r.data)

export interface IpDetail {
  ip: string
  bytes_as_src:        number
  bytes_as_dst:        number
  pkts_as_src:         number
  pkts_as_dst:         number
  flows_total:         number
  unique_destinations: number
  unique_sources:      number
  profile: {
    avg_duration_s:     number
    avg_bytes_per_flow: number
    avg_bytes_per_pkt:  number
    max_flow_bytes:     number
    tcp_flows:          number
    udp_flows:          number
    icmp_flows:         number
    unique_dst_ports:   number
    unique_src_ports:   number
  }
  top_peers:  { peer_ip: string; bytes_sent: number; bytes_received: number }[]
  top_ports:  { dst_port: number; protocol: number; protocol_name: string; bytes_total: number }[]
  timeseries: { ts_ms: number; bytes_out: number; bytes_in: number }[]
}

export const fetchIpDetail = (ip: string, minutes: number, deviceId?: string) =>
  api.get<IpDetail>('/flow/ip-detail', { params: p({ ip, minutes, device_id: deviceId }) }).then(r => r.data)

export interface IfaceFlowPoint {
  ts_ms: number; bytes_in: number; bytes_out: number; packets_total: number; flow_count: number
}

export interface IfaceTalker {
  src_ip: string; dst_ip: string; protocol: number; protocol_name: string
  bytes_total: number; packets_total: number; flow_count: number
}

export const fetchInterfaceFlowTimeseries = (deviceId: string, ifIndex: number, minutes: number) =>
  api.get<IfaceFlowPoint[]>('/flow/interface-timeseries', { params: { device_id: deviceId, if_index: ifIndex, minutes } }).then(r => r.data)

export const fetchInterfaceTopTalkers = (deviceId: string, ifIndex: number, minutes: number, limit = 10) =>
  api.get<IfaceTalker[]>('/flow/interface-top-talkers', { params: { device_id: deviceId, if_index: ifIndex, minutes, limit } }).then(r => r.data)

export interface GeoSummaryRow {
  country_iso:   string
  country_name:  string
  bytes_total:   number
  unique_ips:    number
}

export interface ThreatRow {
  ip:                  string
  abuse_score:         number
  abuse_reports:       number | null
  abuse_isp:           string | null
  abuse_domain:        string | null
  country_iso:         string | null
  country_name:        string | null
  asn_org:             string | null
  bytes_total:         number
  flow_count:          number
  unique_destinations: number
}

export interface IpIntel {
  country_iso:   string | null
  country_name:  string | null
  asn:           number | null
  asn_org:       string | null
  city:          string | null
  abuse_score:   number | null
  abuse_reports: number | null
  abuse_isp:     string | null
  abuse_domain:  string | null
  is_private:    boolean
}

export const fetchGeoSummary = (minutes: number, deviceId?: string, limit = 30) =>
  api.get<GeoSummaryRow[]>('/flow/geo-summary', { params: { minutes, device_id: deviceId, limit } }).then(r => r.data)

export const fetchFlowThreats = (minutes: number, minScore = 25, deviceId?: string) =>
  api.get<ThreatRow[]>('/flow/threats', { params: { minutes, min_score: minScore, device_id: deviceId } }).then(r => r.data)

export const fetchIpIntel = (ips: string[], enrich = false) =>
  api.get<Record<string, IpIntel>>('/flow/ip-intel', { params: { ips: ips.join(','), enrich } }).then(r => r.data)

// ── Deep analytics ────────────────────────────────────────────────────────────

export interface AsnRow {
  asn:         number
  asn_name:    string
  bytes_total: number
  flow_count:  number
  pct:         number
}

export interface AppCategory {
  type:        'category'
  category:    string
  bytes_total: number
  flow_count:  number
  pct:         number
  services:    string[]
}

export interface AppPort {
  type:        'port'
  port:        number
  protocol:    string
  service:     string
  category:    string
  bytes_total: number
  flow_count:  number
  unique_src:  number
  unique_dst:  number
}

export interface DirectionSummary {
  summary: Record<'inbound'|'outbound'|'internal'|'transit', {
    bytes_total: number; packets_total: number; flow_count: number
    unique_src: number; unique_dst: number; pct: number
  }>
  top_inbound_sources:       Array<{ ip: string; bytes_total: number; flow_count: number }>
  top_outbound_destinations: Array<{ ip: string; bytes_total: number; flow_count: number }>
}

export interface ElephantFlow {
  device_name:   string
  flow_type:     string
  start_ms:      number
  end_ms:        number
  duration_s:    number
  src_ip:        string
  dst_ip:        string
  src_port:      number
  dst_port:      number
  service:       string
  protocol:      string
  tcp_flags:     number
  bytes_est:     number
  bytes_raw:     number
  packets:       number
  sampling_rate: number
  bps:           number
}

export interface SubnetRow {
  subnet:      string
  bytes_total: number
  flow_count:  number
  unique_ips:  number
  pct:         number
}

export interface TcpFlagsSummary {
  total_tcp_flows: number
  total_bytes:     number
  flags: Record<'syn_only'|'syn_ack'|'rst'|'fin'|'ack_only'|'psh_ack', { count: number; pct: number }>
  top_rst_sources:  Array<{ ip: string; rst_count: number; unique_targets: number; unique_ports: number }>
  scan_candidates:  Array<{ ip: string; syn_count: number; unique_targets: number; unique_ports: number }>
}

export const fetchAsnSummary = (minutes: number, direction = 'src', deviceId?: string, limit = 25) =>
  api.get<AsnRow[]>('/flow/asn-summary', { params: { minutes, direction, device_id: deviceId, limit } }).then(r => r.data)

export const fetchApplicationSummary = (minutes: number, deviceId?: string) =>
  api.get<(AppCategory | AppPort)[]>('/flow/application-summary', { params: { minutes, device_id: deviceId } }).then(r => r.data)

export const fetchDirectionSummary = (minutes: number, deviceId?: string) =>
  api.get<DirectionSummary>('/flow/direction-summary', { params: { minutes, device_id: deviceId } }).then(r => r.data)

export const fetchElephantFlows = (minutes: number, minMb = 5, deviceId?: string) =>
  api.get<ElephantFlow[]>('/flow/elephant-flows', { params: { minutes, min_mb: minMb, device_id: deviceId } }).then(r => r.data)

export const fetchSubnetSummary = (minutes: number, direction = 'src', deviceId?: string) =>
  api.get<SubnetRow[]>('/flow/subnet-summary', { params: { minutes, direction, device_id: deviceId } }).then(r => r.data)

export const fetchTcpFlags = (minutes: number, deviceId?: string) =>
  api.get<TcpFlagsSummary>('/flow/tcp-flags', { params: { minutes, device_id: deviceId } }).then(r => r.data)
