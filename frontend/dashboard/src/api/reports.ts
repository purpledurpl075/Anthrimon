import api from './client'

export type ReportType =
  | 'capacity' | 'sla' | 'inventory'
  | 'compliance' | 'alert_summary' | 'config_changes' | 'flow_top_talkers'
  | 'interface_health' | 'bgp_health' | 'syslog_security'
  | 'bundle'
export type ReportFormat = 'pdf' | 'csv'

export interface ScheduledReport {
  id: string
  tenant_id: string
  user_id: string
  name: string
  report_type: ReportType
  formats: ReportFormat[]
  filters: Record<string, unknown>
  recurrence_cron: string
  recipients: string[]
  is_enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
  email_subject: string | null
  email_note: string | null
  consecutive_failures: number
  created_at: string
  updated_at: string
}

export interface ReportRun {
  id: string
  tenant_id: string
  scheduled_report_id: string | null
  report_type: ReportType
  format: ReportFormat
  status: 'pending' | 'running' | 'success' | 'failed'
  error: string | null
  file_size_bytes: number | null
  triggered_by: string | null
  emailed_to: string[] | null
  started_at: string
  completed_at: string | null
}

export interface ScheduledReportCreate {
  name: string
  report_type: ReportType
  formats: ReportFormat[]
  filters?: Record<string, unknown>
  recurrence_cron: string
  recipients: string[]
  is_enabled?: boolean
  email_subject?: string | null
  email_note?: string | null
}

export const fetchSchedules = () =>
  api.get<ScheduledReport[]>('/reports/schedules').then(r => r.data)

export const createSchedule = (body: ScheduledReportCreate) =>
  api.post<ScheduledReport>('/reports/schedules', body).then(r => r.data)

export const updateSchedule = (id: string, body: Partial<ScheduledReportCreate>) =>
  api.patch<ScheduledReport>(`/reports/schedules/${id}`, body).then(r => r.data)

export const deleteSchedule = (id: string) =>
  api.delete(`/reports/schedules/${id}`)

export const runReportNow = (body: { report_type: ReportType; format: ReportFormat; filters?: Record<string, unknown>; email_to?: string[] }) =>
  api.post<ReportRun>('/reports/run', body).then(r => r.data)

export const fetchRuns = () =>
  api.get<ReportRun[]>('/reports/runs').then(r => r.data)

export const fetchRun = (id: string) =>
  api.get<ReportRun>(`/reports/runs/${id}`).then(r => r.data)

export const deleteRun = (id: string) =>
  api.delete(`/reports/runs/${id}`)

/** Render-only preview (feature 5) — returns raw HTML, not JSON, so it can't
 * go through the shared `api` client (client.ts unconditionally does
 * res.json() on success). Same raw-fetch-with-Bearer-token pattern as
 * downloadRun() below, just reading text() instead of blob(). */
export async function previewReport(body: { report_type: ReportType; filters?: Record<string, unknown> }): Promise<string> {
  const token = localStorage.getItem('token')
  const res = await fetch('/api/v1/reports/preview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Preview failed (${res.status})`)
  return res.text()
}

/** Report downloads need the Bearer token, so a plain <a href> won't work —
 * fetch as a blob (same pattern as platformHealth.ts's downloadPlatformBackup)
 * and trigger a synthetic download. */
export async function downloadRun(run: ReportRun): Promise<void> {
  const token = localStorage.getItem('token')
  const res = await fetch(`/api/v1/reports/runs/${run.id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = `${run.report_type}-report-${run.id}.${run.format}`
  a.click()
  URL.revokeObjectURL(objectUrl)
}
