import { useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'

export type WidgetSize = 'half' | 'full'

export interface WidgetConfig {
  id: string
  visible: boolean
  size: WidgetSize
}

export interface WidgetDef {
  id: string
  label: string
  description: string
  defaultSize: WidgetSize
}

export const WIDGET_DEFS: WidgetDef[] = [
  { id: 'stat_cards',           label: 'Stat cards',           description: 'Device counts, alert totals, poll health',  defaultSize: 'full' },
  { id: 'alert_severity',       label: 'Alert severity',       description: 'Open alerts broken down by severity',        defaultSize: 'half' },
  { id: 'device_types',         label: 'Device types',         description: 'Device count by type',                       defaultSize: 'half' },
  { id: 'top_bandwidth',        label: 'Top bandwidth',        description: 'Busiest interfaces and devices',             defaultSize: 'full' },
  { id: 'problem_devices',      label: 'Problem devices',      description: 'Down or unreachable devices',                defaultSize: 'half' },
  { id: 'open_alerts',          label: 'Open alerts',          description: 'Highest-severity open alerts',               defaultSize: 'half' },
  { id: 'top_alerting_devices', label: 'Top alerting devices', description: 'Devices with the most open alerts',          defaultSize: 'half' },
  { id: 'recently_resolved',    label: 'Recently resolved',    description: 'Alerts resolved in the last hour',           defaultSize: 'full' },
  { id: 'bgp_summary',          label: 'BGP summary',          description: 'BGP session health across all devices',       defaultSize: 'half' },
]

const STORAGE_KEY = 'anthrimon-dashboard-layout-v1'

const DEFAULT_LAYOUT: WidgetConfig[] = WIDGET_DEFS.map(w => ({
  id: w.id,
  visible: true,
  size: w.defaultSize,
}))

function loadLayout(): WidgetConfig[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as WidgetConfig[]
      const savedIds  = new Set(parsed.map(w => w.id))
      const knownIds  = new Set(WIDGET_DEFS.map(d => d.id))
      return [
        ...parsed.filter(w => knownIds.has(w.id)),
        ...WIDGET_DEFS.filter(d => !savedIds.has(d.id)).map(d => ({
          id: d.id, visible: true, size: d.defaultSize as WidgetSize,
        })),
      ]
    }
  } catch {}
  return DEFAULT_LAYOUT
}

export function useDashboardLayout() {
  const [layout, setLayout] = useState<WidgetConfig[]>(loadLayout)

  const persist = (next: WidgetConfig[]) => {
    setLayout(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch {}
  }

  return {
    layout,
    reorder:     (activeId: string, overId: string) => persist(
      arrayMove(layout, layout.findIndex(w => w.id === activeId), layout.findIndex(w => w.id === overId))
    ),
    setVisible:  (id: string, visible: boolean) => persist(
      layout.map(w => w.id === id ? { ...w, visible } : w)
    ),
    toggleSize:  (id: string) => persist(
      layout.map(w => w.id === id ? { ...w, size: w.size === 'full' ? 'half' : 'full' } : w)
    ),
    reset:       () => persist(DEFAULT_LAYOUT),
  }
}
