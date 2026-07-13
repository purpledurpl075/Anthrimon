import api from './client'

export interface CollectorSummary {
  id: string
  name: string
  wg_ip: string | null
  last_seen: string | null
  version: string | null
}

export const fetchProbeCollectors = () =>
  api.get<CollectorSummary[]>('/collectors').then(r => {
    // The /collectors endpoint returns a richer object; pick the fields we need.
    type RemoteCollectorRow = {
      id: string
      name: string
      wg_ip?: string | null
      last_seen?: string | null
      version?: string | null
    }
    return (r.data as unknown as RemoteCollectorRow[]).map(c => ({
      id: c.id, name: c.name,
      wg_ip: c.wg_ip ?? null,
      last_seen: c.last_seen ?? null,
      version: c.version ?? null,
    }))
  })

export type ProbeType = 'ping' | 'traceroute' | 'mtr'

export interface ProbeEvent {
  event: 'start' | 'line' | 'complete' | 'error'
  command?: string
  source?: string
  data?: string
  exit_code?: number
  detail?: string
}

export interface ProbeRequest {
  target:     string
  type:       ProbeType
  source:     string             // "hub" or collector UUID
  count?:     number
  timeout_s?: number
  max_hops?:  number
}

/**
 * Open a WebSocket to /probes/ws and stream events back to `onEvent`.
 * Mints a short-lived token via /auth/ws-token first (same pattern as
 * subscribeAlerts in alerts.ts) rather than putting the long-lived session
 * JWT in the URL, where it could appear in server logs and browser history.
 * Returns a `cancel()` function — call it to abort the probe early.
 */
export function runProbe(
  req: ProbeRequest,
  onEvent: (ev: ProbeEvent) => void,
  onClose: () => void,
): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  let ws: WebSocket | null = null
  let cancelled = false

  ;(async () => {
    try {
      const { data } = await api.post<{ token: string }>('/auth/ws-token')
      if (cancelled) return
      ws = new WebSocket(`${proto}://${window.location.host}/api/v1/probes/ws?token=${encodeURIComponent(data.token)}`)
      ws.onopen = () => ws?.send(JSON.stringify(req))
      ws.onmessage = e => {
        try {
          const ev = JSON.parse(e.data) as ProbeEvent
          onEvent(ev)
        } catch {
          onEvent({ event: 'line', data: String(e.data) })
        }
      }
      ws.onerror = () => onEvent({ event: 'error', detail: 'WebSocket error' })
      ws.onclose = () => onClose()
    } catch {
      if (!cancelled) {
        onEvent({ event: 'error', detail: 'Failed to start probe' })
        onClose()
      }
    }
  })()

  return () => {
    cancelled = true
    if (!ws) return
    try { ws.send(JSON.stringify({ cancel: true })) } catch { /* ignore */ }
    try { ws.close() } catch { /* ignore */ }
  }
}
