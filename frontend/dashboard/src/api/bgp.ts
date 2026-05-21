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
