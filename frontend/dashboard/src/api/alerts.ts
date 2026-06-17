import api from './client'
import type { Alert, AlertRule, PaginatedResponse } from './types'

export const fetchAlerts = (params?: { status?: string; severity?: string; device_id?: string; limit?: number }) =>
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
  const token = localStorage.getItem('token') ?? ''
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 1000
  let stopped = false

  function connect() {
    if (stopped) return
    onStatusChange?.('connecting')
    ws = new WebSocket(`${proto}://${window.location.host}/api/v1/alerts/ws?token=${encodeURIComponent(token)}`)
    ws.onopen = () => { backoff = 1000; onStatusChange?.('open') }
    ws.onmessage = () => onMessage()
    ws.onclose = () => {
      onStatusChange?.('closed')
      if (stopped) return
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
    ws.onerror = () => ws?.close()
  }
  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  }
}
