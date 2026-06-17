import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchDashboard, updateDashboard,
  type Dashboard, type DashboardWidget, type MetricWidgetConfig,
} from '../api/dashboards'
import { WIDGET_DEFS, type WidgetDef } from './useDashboardLayout'

// ── Combined widget registry ─────────────────────────────────────────────────
// The 21 extracted "summary" widget types (from WIDGET_DEFS) plus the 4
// generic "metric_*" / "text_note" types. Summary types appear at most once
// per dashboard (matching Overview); metric/text types are instanced — every
// "Add" creates a fresh instance_id with its own `config`.

export interface DashboardWidgetDef extends WidgetDef {
  isMetric?: boolean
}

export const METRIC_WIDGET_DEFS: DashboardWidgetDef[] = [
  { id: 'metric_gauge', label: 'Metric gauge', description: 'Radial dial for a device or interface metric', defaultW: 3, defaultH: 3, minW: 2, minH: 2, isMetric: true },
  { id: 'metric_stat',  label: 'Metric stat',  description: 'Big number + sparkline for a metric',           defaultW: 3, defaultH: 2, minW: 2, minH: 2, isMetric: true },
  { id: 'metric_graph', label: 'Metric graph', description: 'Time-series chart for a metric',                defaultW: 6, defaultH: 3, minW: 3, minH: 2, isMetric: true },
  { id: 'text_note',    label: 'Text note',    description: 'Free-form text panel',                          defaultW: 4, defaultH: 2, minW: 2, minH: 2, isMetric: true },
]

export const WIDGET_REGISTRY: DashboardWidgetDef[] = [...WIDGET_DEFS, ...METRIC_WIDGET_DEFS]

export function findWidgetDef(type: string): DashboardWidgetDef | undefined {
  return WIDGET_REGISTRY.find(d => d.id === type)
}

// ── Time range helpers ───────────────────────────────────────────────────────

const TIME_RANGE_MINUTES: Record<string, number> = {
  '15m': 15, '1h': 60, '6h': 360, '24h': 1440, '7d': 10080,
}

export function timeRangeToMinutes(range: string): number {
  return TIME_RANGE_MINUTES[range] ?? 1440
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const AUTOSAVE_DELAY_MS = 800

function genInstanceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `w-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useDashboardWidgets(dashboardId: string) {
  const queryClient = useQueryClient()
  const { data: dashboard, isLoading } = useQuery({
    queryKey: ['dashboard', dashboardId],
    queryFn:  () => fetchDashboard(dashboardId),
    enabled:  !!dashboardId,
  })

  const [widgets, setWidgets] = useState<DashboardWidget[]>([])
  const [timeRange, setTimeRangeState] = useState('24h')
  const [refreshIntervalS, setRefreshIntervalState] = useState(60)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed local state from the fetched dashboard. Re-runs only when the
  // dashboard id itself changes, so background refetches don't clobber
  // in-flight local edits.
  useEffect(() => {
    if (!dashboard) return
    setWidgets(dashboard.layout.widgets)
    setTimeRangeState(dashboard.layout.time_range)
    setRefreshIntervalState(dashboard.layout.refresh_interval_s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard?.id])

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
  }, [])

  const applyUpdate = useCallback((updated: Dashboard) => {
    queryClient.setQueryData(['dashboard', dashboardId], updated)
    queryClient.invalidateQueries({ queryKey: ['dashboards'] })
  }, [dashboardId, queryClient])

  // Debounced autosave of the layout (widgets + time range + refresh interval).
  const persist = useCallback((nextWidgets: DashboardWidget[], nextTimeRange: string, nextRefresh: number) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      updateDashboard(dashboardId, {
        layout: { widgets: nextWidgets, time_range: nextTimeRange, refresh_interval_s: nextRefresh },
      }).then(applyUpdate)
    }, AUTOSAVE_DELAY_MS)
  }, [dashboardId, applyUpdate])

  // Immediately persists the current layout, bypassing the debounce — call
  // when leaving edit mode so changes aren't lost on navigation.
  const flush = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    return updateDashboard(dashboardId, {
      layout: { widgets, time_range: timeRange, refresh_interval_s: refreshIntervalS },
    }).then(updated => { applyUpdate(updated); return updated })
  }, [dashboardId, widgets, timeRange, refreshIntervalS, applyUpdate])

  const updateWidgets = (next: DashboardWidget[]) => {
    setWidgets(next)
    persist(next, timeRange, refreshIntervalS)
  }

  const addWidget = (type: string, config?: MetricWidgetConfig): string => {
    const def = findWidgetDef(type)
    const bottomY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0)
    const newWidget: DashboardWidget = {
      instance_id: genInstanceId(),
      type,
      x: 0,
      y: bottomY,
      w: def?.defaultW ?? 4,
      h: def?.defaultH ?? 3,
      ...(config ? { config } : {}),
    }
    updateWidgets([...widgets, newWidget])
    return newWidget.instance_id
  }

  const removeWidget = (instanceId: string) => {
    updateWidgets(widgets.filter(w => w.instance_id !== instanceId))
  }

  const updateWidgetConfig = (instanceId: string, config: MetricWidgetConfig) => {
    updateWidgets(widgets.map(w => w.instance_id === instanceId ? { ...w, config } : w))
  }

  const updateFromRGL = (rglLayout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => {
    updateWidgets(widgets.map(w => {
      const item = rglLayout.find(l => l.i === w.instance_id)
      return item ? { ...w, x: item.x, y: item.y, w: item.w, h: item.h } : w
    }))
  }

  const setTimeRange = (range: string) => {
    setTimeRangeState(range)
    persist(widgets, range, refreshIntervalS)
  }

  const setRefreshInterval = (s: number) => {
    setRefreshIntervalState(s)
    persist(widgets, timeRange, s)
  }

  const rename = (name: string) => updateDashboard(dashboardId, { name }).then(applyUpdate)
  const setShared = (is_shared: boolean) => updateDashboard(dashboardId, { is_shared }).then(applyUpdate)
  const setDefault = (is_default: boolean) => updateDashboard(dashboardId, { is_default }).then(applyUpdate)

  return {
    dashboard, isLoading,
    widgets, timeRange, refreshIntervalS,
    addWidget, removeWidget, updateWidgetConfig, updateFromRGL,
    setTimeRange, setRefreshInterval, rename, setShared, setDefault,
    flush,
  }
}
