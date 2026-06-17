import api from './client'

export interface MetricThresholds {
  warn: number
  crit: number
}

export interface MetricDef {
  id: string
  label: string
  category: 'device' | 'interface'
  unit: string
  value_type: 'gauge' | 'raw'
  default_max: number | null
  thresholds: MetricThresholds | null
}

export interface MetricValue {
  unit: string
  value: number | null
  timestamp: number | null
}

export interface MetricSeries {
  unit: string
  series: [number, number][]
}

export const fetchMetricCatalog = () =>
  api.get<MetricDef[]>('/metrics/catalog').then(r => r.data)

export const fetchMetricValue = (params: { metric_id: string; device_id: string; interface_name?: string }) =>
  api.get<MetricValue>('/metrics/query', { params: { ...params, mode: 'instant' } }).then(r => r.data)

export const fetchMetricSeries = (params: { metric_id: string; device_id: string; interface_name?: string; range_minutes: number }) =>
  api.get<MetricSeries>('/metrics/query', { params: { ...params, mode: 'range' } }).then(r => r.data)
