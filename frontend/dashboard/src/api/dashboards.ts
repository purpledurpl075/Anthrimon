import api from './client'

// Config bag for the generic "metric_*" / "text_note" widget types. The
// index signature keeps it assignable to/from the JSONB `config` field.
export interface MetricWidgetConfig {
  [key: string]: unknown
  title?: string
  device_id?: string
  device_name?: string
  interface_name?: string
  metric_id?: string
  thresholds?: { warn: number; crit: number } | null
  max?: number | null
  // text_note only
  text?: string
}

export interface DashboardWidget {
  instance_id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  config?: MetricWidgetConfig
}

export interface DashboardLayout {
  widgets: DashboardWidget[]
  time_range: string
  refresh_interval_s: number
}

export interface Dashboard {
  id: string
  name: string
  description: string
  is_shared: boolean
  is_default: boolean
  layout: DashboardLayout
  user_id: string
  owner_name: string | null
  can_edit: boolean
  created_at: string
  updated_at: string
}

export interface DashboardCreate {
  name: string
  description?: string
  is_shared?: boolean
  layout?: DashboardLayout
}

export interface DashboardUpdate {
  name?: string
  description?: string
  is_shared?: boolean
  is_default?: boolean
  layout?: DashboardLayout
}

export interface DashboardTemplateInfo {
  key: string
  name: string
  description: string
}

export const fetchDashboards = () =>
  api.get<Dashboard[]>('/dashboards').then(r => r.data)

export const fetchDashboard = (id: string) =>
  api.get<Dashboard>(`/dashboards/${id}`).then(r => r.data)

export const createDashboard = (data: DashboardCreate) =>
  api.post<Dashboard>('/dashboards', data).then(r => r.data)

export const updateDashboard = (id: string, data: DashboardUpdate) =>
  api.patch<Dashboard>(`/dashboards/${id}`, data).then(r => r.data)

export const deleteDashboard = (id: string) =>
  api.delete<void>(`/dashboards/${id}`)

export const cloneDashboard = (id: string) =>
  api.post<Dashboard>(`/dashboards/${id}/clone`).then(r => r.data)

export const fetchDashboardTemplates = () =>
  api.get<DashboardTemplateInfo[]>('/dashboards/templates').then(r => r.data)

export const cloneTemplate = (key: string) =>
  api.post<Dashboard>(`/dashboards/templates/${key}/clone`).then(r => r.data)
