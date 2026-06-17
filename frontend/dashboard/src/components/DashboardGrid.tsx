import { useState, useRef, useEffect } from 'react'
import { ReactGridLayout as GridLayout } from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { Download, Trash2 } from 'lucide-react'
import type { DashboardWidget, MetricWidgetConfig } from '../api/dashboards'
import { findWidgetDef, timeRangeToMinutes } from '../hooks/useDashboardWidgets'
import { WIDGET_COMPONENTS, MetricGauge, MetricStat, MetricGraph, TextNote, Icons } from './widgets'

export interface DashboardGridProps {
  widgets: DashboardWidget[]
  timeRange: string
  refreshIntervalS: number
  isEditing?: boolean
  readOnly?: boolean
  onLayoutChange?: (rgl: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void
  onRemoveWidget?: (instanceId: string) => void
  onUpdateWidgetConfig?: (instanceId: string, config: MetricWidgetConfig) => void
  onConfigureWidget?: (instanceId: string) => void
}

function renderWidget(
  widget: DashboardWidget,
  refreshIntervalS: number,
  rangeMinutes: number,
  isEditing: boolean,
  onUpdateWidgetConfig?: (instanceId: string, config: MetricWidgetConfig) => void,
) {
  const config = widget.config ?? {}
  switch (widget.type) {
    case 'metric_gauge':
      return <MetricGauge config={config} refreshIntervalS={refreshIntervalS} />
    case 'metric_stat':
      return <MetricStat config={config} refreshIntervalS={refreshIntervalS} />
    case 'metric_graph':
      return <MetricGraph config={config} refreshIntervalS={refreshIntervalS} rangeMinutes={rangeMinutes} />
    case 'text_note':
      return (
        <TextNote
          config={config}
          editing={isEditing}
          onChange={text => onUpdateWidgetConfig?.(widget.instance_id, { ...config, text })}
        />
      )
    default: {
      const Summary = WIDGET_COMPONENTS[widget.type]
      if (!Summary) {
        return (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex items-center justify-center text-xs text-slate-400">
            Unknown widget type "{widget.type}"
          </div>
        )
      }
      return <Summary />
    }
  }
}

function WidgetCard({
  widget, isEditing, readOnly, refreshIntervalS, rangeMinutes,
  onRemove, onConfigure, onUpdateWidgetConfig,
}: {
  widget: DashboardWidget
  isEditing: boolean
  readOnly: boolean
  refreshIntervalS: number
  rangeMinutes: number
  onRemove?: () => void
  onConfigure?: () => void
  onUpdateWidgetConfig?: (instanceId: string, config: MetricWidgetConfig) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const def = findWidgetDef(widget.type)
  const canConfigure = isEditing && !!def?.isMetric

  const exportPng = async () => {
    if (!cardRef.current) return
    try {
      const { toPng } = await import('html-to-image')
      const url = await toPng(cardRef.current, { pixelRatio: 2, backgroundColor: '#ffffff' })
      const a = document.createElement('a')
      a.href = url
      const title = widget.config?.title || def?.label || widget.type
      a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`
      a.click()
    } catch { /* ignore export errors */ }
  }

  return (
    <div className="relative h-full group">
      {!readOnly && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-xl shadow-md px-2 py-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {isEditing && (
            <>
              <div
                className="widget-drag-handle flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors select-none"
                title="Drag to move"
              >
                <Icons.Grip />
              </div>
              <div className="w-px h-4 bg-slate-200" />
            </>
          )}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={exportPng}
            title="Export as PNG"
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          {canConfigure && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onConfigure}
              title="Configure"
              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            >
              <Icons.Settings />
            </button>
          )}
          {isEditing && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={onRemove}
              title="Remove widget"
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        ref={cardRef}
        className={`h-full overflow-auto rounded-2xl ${isEditing && !readOnly ? 'ring-2 ring-blue-200 ring-offset-1' : ''}`}
        style={{ cursor: isEditing && !readOnly ? 'default' : undefined }}
      >
        {renderWidget(widget, refreshIntervalS, rangeMinutes, isEditing, onUpdateWidgetConfig)}
      </div>
    </div>
  )
}

export function DashboardGrid({
  widgets, timeRange, refreshIntervalS, isEditing = false, readOnly = false,
  onLayoutChange, onRemoveWidget, onUpdateWidgetConfig, onConfigureWidget,
}: DashboardGridProps) {
  const [containerWidth, setContainerWidth] = useState(1200)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const ro = new ResizeObserver(entries => setContainerWidth(entries[0].contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const rangeMinutes = timeRangeToMinutes(timeRange)

  if (widgets.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-400 py-16">
        {readOnly ? 'This dashboard has no widgets yet.' : 'No widgets yet — click "Add widget" to get started.'}
      </div>
    )
  }

  return (
    <div ref={containerRef}>
      <GridLayout
        className="layout"
        layout={widgets.map(w => ({
          i: w.instance_id, x: w.x, y: w.y, w: w.w, h: w.h,
          minW: findWidgetDef(w.type)?.minW ?? 2,
          minH: findWidgetDef(w.type)?.minH ?? 2,
        }))}
        cols={12}
        rowHeight={120}
        width={containerWidth}
        margin={[16, 16]}
        containerPadding={[0, 0]}
        isDraggable={isEditing && !readOnly}
        isResizable={isEditing && !readOnly}
        onLayoutChange={l => onLayoutChange?.(l as Array<{ i: string; x: number; y: number; w: number; h: number }>)}
        draggableHandle=".widget-drag-handle"
        resizeHandles={['se']}
        useCSSTransforms
      >
        {widgets.map(w => (
          <div key={w.instance_id}>
            <WidgetCard
              widget={w}
              isEditing={isEditing}
              readOnly={readOnly}
              refreshIntervalS={refreshIntervalS}
              rangeMinutes={rangeMinutes}
              onRemove={() => onRemoveWidget?.(w.instance_id)}
              onConfigure={() => onConfigureWidget?.(w.instance_id)}
              onUpdateWidgetConfig={onUpdateWidgetConfig}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  )
}
