import api from './client'

export interface Credential {
  id: string
  name: string
  type: string
}

export interface DiscoveredDevice {
  ip: string
  hostname: string
  vendor: string
  sys_descr: string
  sys_object_id: string
  already_in_db: boolean
  device_id: string | null
  credential_id: string | null  // which credential responded
}

export interface SweepJob {
  job_id:      string
  status:      'pending' | 'running' | 'done' | 'cancelled' | 'error'
  cidr:        string
  total:       number
  scanned:     number
  found:       DiscoveredDevice[]
  error:       string | null
  started_at:  string
  finished_at: string | null
}

export interface SweepJobSummary {
  job_id:      string
  status:      string
  cidr:        string
  total:       number
  scanned:     number
  found:       number
  started_at:  string
  finished_at: string | null
}

export const fetchCredentials = () =>
  api.get<Credential[]>('/credentials', { params: { all: true } }).then(r => r.data)

export const startSweep = (cidr: string, credential_ids: string[], timeout_s = 3, collector_id?: string) =>
  api.post<SweepJob>('/discovery/sweep', { cidr, credential_ids, timeout_s, ...(collector_id ? { collector_id } : {}) }).then(r => r.data)

export const getSweepJob    = (job_id: string) =>
  api.get<SweepJob>(`/discovery/sweep/${job_id}`).then(r => r.data)

export const listSweepJobs  = () =>
  api.get<SweepJobSummary[]>('/discovery/sweep').then(r => r.data)

export const cancelSweepJob = (job_id: string) =>
  api.delete(`/discovery/sweep/${job_id}`)
