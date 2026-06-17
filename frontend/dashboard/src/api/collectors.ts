import api from './client'

export interface RemoteCollector {
  id:                 string
  name:               string
  hostname:           string | null
  site_id:            string | null
  status:             'pending' | 'online' | 'offline' | 'revoked'
  timezone:           string
  wg_ip:              string | null
  wg_public_key:      string | null
  ip_address:         string | null
  version:            string | null
  capabilities:       string[]
  last_seen:          string | null
  registered_at:      string | null
  is_active:          boolean
  created_at:         string
  state_interval_s:   number | null
  counter_interval_s: number | null
  // Only present immediately after creation / token regeneration
  registration_token?: string
  ca_cert?:            string
}

export interface CollectorDevice {
  id:          string
  hostname:    string
  mgmt_ip:     string | null
  vendor:      string
  device_type: string
  last_polled: string | null
}

export interface CollectorDetails extends RemoteCollector {
  devices: CollectorDevice[]
}

export interface SyslogMessage {
  device_id:   string
  device_ip:   string
  facility:    number
  severity:    number
  ts:          string
  hostname:    string
  program:     string
  message:     string
  received_at: string
}

export interface CollectorLogs {
  messages:     SyslogMessage[]
  device_count: number
}

export interface CollectorLogEntry {
  collector_id: string
  ts:           string
  level:        string  // zerolog levels: trace/debug/info/warn/error/fatal/panic
  message:      string
  fields:       string  // JSON blob of any extra zerolog fields
}

export interface CollectorOwnLogs {
  logs: CollectorLogEntry[]
}

export interface CollectorCreate { name: string; site_id?: string }

export const fetchCollectors    = () =>
  api.get<RemoteCollector[]>('/collectors').then(r => r.data)

export const createCollector    = (body: CollectorCreate) =>
  api.post<RemoteCollector>('/collectors', body).then(r => r.data)

export const fetchCollector     = (id: string) =>
  api.get<RemoteCollector>(`/collectors/${id}`).then(r => r.data)

export const fetchCollectorDetails = (id: string) =>
  api.get<CollectorDetails>(`/collectors/${id}/details`).then(r => r.data)

export const fetchCollectorLogs = (id: string, minutes = 120, limit = 100) =>
  api.get<CollectorLogs>(`/collectors/${id}/logs`, { params: { minutes, limit } }).then(r => r.data)

export const fetchCollectorOwnLogs = (id: string, minutes = 120, limit = 200) =>
  api.get<CollectorOwnLogs>(`/collectors/${id}/collector-logs`, { params: { minutes, limit } }).then(r => r.data)

export const patchCollector     = (id: string, body: { timezone?: string; name?: string; state_interval_s?: number | null; counter_interval_s?: number | null }) =>
  api.patch<RemoteCollector>(`/collectors/${id}`, body).then(r => r.data)

export const deleteCollector    = (id: string) =>
  api.delete(`/collectors/${id}`)

export const regenerateToken    = (id: string) =>
  api.post<{ registration_token: string; ca_cert: string; expires_at: string }>(
    `/collectors/${id}/token`
  ).then(r => r.data)

// ── Build management ──────────────────────────────────────────────────────────

export interface ArchBuildInfo {
  built:       boolean
  size_bytes:  number | null
  built_at:    string | null
}

export interface BuildStatus {
  arches:        Record<string, ArchBuildInfo>
  go_available:  boolean
  source_exists: boolean
}

export interface BuildResult {
  all_ok: boolean
  arches: Record<string, { success: boolean; size_bytes?: number; error?: string }>
}

export const fetchBuildStatus = () =>
  api.get<BuildStatus>('/collectors/builds/status').then(r => r.data)

export const triggerBuild = () =>
  api.post<BuildResult>('/collectors/builds').then(r => r.data)

export interface UpdateResult {
  status:    'update_triggered' | 'offline' | 'error'
  collector?: string
  detail?:   string
}

export const triggerUpdate = (id: string) =>
  api.post<UpdateResult>(`/collectors/${id}/update`).then(r => r.data)

// ── Deployment package download ───────────────────────────────────────────────

/** Trigger a browser download of the deployment zip for the given collector.
 *  The token (plaintext, one-time) is baked into collector.yaml inside the zip.
 *  Uses fetch directly so we can receive a binary blob with the auth header. */
export const downloadPackage = async (id: string, token: string, arch = 'amd64') => {
  const params = new URLSearchParams({ arch, ...(token ? { token } : {}) })
  const jwt    = localStorage.getItem('token') ?? ''
  const res    = await fetch(`/api/v1/collectors/${id}/download?${params}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    return Promise.reject({ response: { status: res.status, data: err } })
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = href
  a.download = `anthrimon-collector-linux-${arch}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(href)
}
