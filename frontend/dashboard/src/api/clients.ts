import api from './client'

export interface ClientPresence {
  device_id: string
  device_name: string | null
  port: string | null
  port_iface_id: string | null
  vlan_id: number | null
  last_seen: string
}

export interface ClientIP {
  ip: string
  device_id: string
  device_name: string | null
  interface_name: string | null
  last_seen: string
}

export interface IPIntel {
  is_private: boolean
  country_iso: string | null
  country_name: string | null
  asn: number | null
  asn_org: string | null
  city: string | null
  abuse_score: number | null
  abuse_reports: number | null
  abuse_isp: string | null
}

export interface ClientDetail {
  mac: string
  vendor: string | null
  presences: ClientPresence[]
  ips: ClientIP[]
  ip_intel: Record<string, IPIntel>
}

export const fetchClient = (mac: string) =>
  api.get<ClientDetail>(`/clients/${mac}`).then(r => r.data)

export function macToUrl(mac: string): string {
  return mac.replace(/:/g, '-')
}
