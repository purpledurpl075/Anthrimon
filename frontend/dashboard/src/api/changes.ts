import api from './client'

export interface ChangeAction {
  id: string
  device_id: string
  step_order: number
  action_type: string
  payload: Record<string, any>
  status: string
  output: string | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  device_name: string | null
}

export interface ChangeRequest {
  id: string
  tenant_id: string
  title: string
  description: string | null
  status: string
  requested_by: string
  approved_by: string | null
  executed_by: string | null
  approval_notes: string | null
  rejection_reason: string | null
  scheduled_at: string | null
  executed_at: string | null
  completed_at: string | null
  rollback_plan: string | null
  created_at: string
  updated_at: string
  actions: ChangeAction[]
  requested_by_name: string | null
  approved_by_name: string | null
  executed_by_name: string | null
}

export interface ChangeActionCreate {
  device_id: string
  action_type: string
  payload: Record<string, any>
}

export interface ChangeRequestCreate {
  title: string
  description?: string
  rollback_plan?: string
  actions: ChangeActionCreate[]
}

export const fetchChangeRequests = (params?: { status?: string }) =>
  api.get<ChangeRequest[]>('/changes', { params }).then(r => r.data)

export const fetchChangeRequest = (id: string) =>
  api.get<ChangeRequest>(`/changes/${id}`).then(r => r.data)

export const createChangeRequest = (data: ChangeRequestCreate) =>
  api.post<ChangeRequest>('/changes', data).then(r => r.data)

export const approveChangeRequest = (id: string, notes?: string) =>
  api.post<ChangeRequest>(`/changes/${id}/approve`, { notes }).then(r => r.data)

export const rejectChangeRequest = (id: string, reason: string) =>
  api.post<ChangeRequest>(`/changes/${id}/reject`, { reason }).then(r => r.data)

export const executeChangeRequest = (id: string) =>
  api.post<ChangeRequest>(`/changes/${id}/execute`).then(r => r.data)

export const cancelChangeRequest = (id: string) =>
  api.post<ChangeRequest>(`/changes/${id}/cancel`).then(r => r.data)
