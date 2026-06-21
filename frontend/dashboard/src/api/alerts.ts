import api from './client'
import type { Alert, AlertRule, PaginatedResponse } from './types'

export const fetchAlerts = (params?: { status?: string; severity?: string; device_id?: string; limit?: number; offset?: number }) =>
  api.get<PaginatedResponse<Alert>>('/alerts', { params }).then(r => r.data)

export const acknowledgeAlert = (id: string) =>
  api.post<Alert>(`/alerts/${id}/acknowledge`).then(r => r.data)

export const resolveAlert = (id: string) =>
  api.post<Alert>(`/alerts/${id}/resolve`).then(r => r.data)

export const fetchAlertRules = () =>
  api.get<PaginatedResponse<AlertRule>>('/alert-rules').then(r => r.data)

export const createAlertRule = (body: Record<string, unknown>) =>
  api.post<AlertRule>('/alert-rules', body).then(r => r.data)

export const updateAlertRule = (id: string, body: Record<string, unknown>) =>
  api.patch<AlertRule>(`/alert-rules/${id}`, body).then(r => r.data)

export const deleteAlertRule = (id: string) =>
  api.delete(`/alert-rules/${id}`)

export const fetchAlert = (id: string) =>
  api.get<Alert>(`/alerts/${id}`).then(r => r.data)

export const fetchAlertRule = (id: string) =>
  api.get<AlertRule>(`/alert-rules/${id}`).then(r => r.data)

export type AlertBulkAction = 'acknowledge' | 'resolve'

export const bulkAlertAction = (alert_ids: string[], action: AlertBulkAction) =>
  api.post<{ updated: number }>('/alerts/bulk', { alert_ids, action }).then(r => r.data)

export async function exportAlertsCsv(params?: { status?: string; severity?: string }) {
  const token = localStorage.getItem('token')
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.severity) qs.set('severity', params.severity)
  const url = `/api/v1/alerts/export.csv${qs.toString() ? '?' + qs : ''}`
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error('Export failed')
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match?.[1] ?? 'alerts.csv'
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export type AlertsWsStatus = 'connecting' | 'open' | 'closed'

/**
 * Subscribe to live alert changes via /alerts/ws. Calls `onMessage` whenever
 * the server reports `{"event": "alerts_changed"}` — caller should refetch
 * GET /alerts. Reconnects with exponential backoff (1s → 30s cap) if the
 * connection drops. Returns an unsubscribe function.
 */
export function subscribeAlerts(
  onMessage: () => void,
  onStatusChange?: (status: AlertsWsStatus) => void,
): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 1000
  let stopped = false

  async function connect() {
    if (stopped) return
    onStatusChange?.('connecting')
    try {
      const { data } = await api.post<{ token: string }>('/auth/ws-token')
      if (stopped) return
      ws = new WebSocket(`${proto}://${window.location.host}/api/v1/alerts/ws?token=${encodeURIComponent(data.token)}`)
      ws.onopen = () => { backoff = 1000; onStatusChange?.('open') }
      ws.onmessage = () => onMessage()
      ws.onclose = () => {
        onStatusChange?.('closed')
        if (stopped) return
        reconnectTimer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
      ws.onerror = () => ws?.close()
    } catch {
      onStatusChange?.('closed')
      if (stopped) return
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  }
}
