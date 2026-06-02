import api from './client'

export interface NotificationChannel {
  id: string
  tenant_id: string
  name: string
  type: string
  config: Record<string, unknown>
  is_enabled: boolean
  created_at: string
  updated_at: string
}

export const fetchChannels = () =>
  api.get<{ items: NotificationChannel[]; total: number }>('/notification-channels').then(r => r.data.items)

export const createChannel = (body: { name: string; type: string; config: Record<string, unknown>; is_enabled: boolean }) =>
  api.post<NotificationChannel>('/notification-channels', body).then(r => r.data)

export const updateChannel = (id: string, body: Partial<{ name: string; config: Record<string, unknown>; is_enabled: boolean }>) =>
  api.patch<NotificationChannel>(`/notification-channels/${id}`, body).then(r => r.data)

export const deleteChannel = (id: string) =>
  api.delete(`/notification-channels/${id}`)

export const testChannel = (id: string) =>
  api.post(`/notification-channels/${id}/test`)

export interface ChannelSendLogEntry {
  id: number
  channel_id: string
  alert_id: string | null
  event: string
  status: string
  error: string | null
  attempts: number
  sent_at: string
}

export const fetchChannelSendLog = (id: string, limit = 50) =>
  api.get<ChannelSendLogEntry[]>(`/notification-channels/${id}/send-log?limit=${limit}`).then(r => r.data)
