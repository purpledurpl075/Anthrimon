import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDevices, fetchDeviceInterfaces } from '../../api/devices'
import { fetchMetricCatalog } from '../../api/metrics'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { MetricWidgetConfig } from './metricWidgetConfig'

interface Props {
  widgetType:    string
  initialConfig: MetricWidgetConfig
  onSave:  (config: MetricWidgetConfig) => void
  onClose: () => void
}

const inputCls = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const labelCls = 'block text-xs font-medium text-slate-600 mb-1'

export function WidgetConfigModal({ widgetType, initialConfig, onSave, onClose }: Props) {
  const [title, setTitle]       = useState(initialConfig.title ?? '')
  const [deviceId, setDeviceId] = useState(initialConfig.device_id ?? '')
  const [metricId, setMetricId] = useState(initialConfig.metric_id ?? '')
  const [ifaceName, setIfaceName] = useState(initialConfig.interface_name ?? '')
  const [warn, setWarn] = useState(initialConfig.thresholds?.warn?.toString() ?? '')
  const [crit, setCrit] = useState(initialConfig.thresholds?.crit?.toString() ?? '')
  const [thresholdsTouched, setThresholdsTouched] = useState(!!initialConfig.thresholds)
  const [text, setText] = useState(initialConfig.text ?? '')

  const isTextNote = widgetType === 'text_note'
  const showThresholds = widgetType === 'metric_gauge' || widgetType === 'metric_stat'

  const { data: devicesResp } = useQuery({
    queryKey: ['devices-all'],
    queryFn:  () => fetchDevices({ limit: 500 }),
    enabled:  !isTextNote,
  })
  const devices = devicesResp?.items ?? []

  const { data: catalog = [] } = useQuery({
    queryKey: ['metric-catalog'],
    queryFn:  fetchMetricCatalog,
    staleTime: 300_000,
    enabled:  !isTextNote,
  })

  const selectedMetric = catalog.find(m => m.id === metricId)
  const isInterfaceMetric = selectedMetric?.category === 'interface'

  const { data: interfaces = [] } = useQuery({
    queryKey: ['device-interfaces', deviceId],
    queryFn:  () => fetchDeviceInterfaces(deviceId),
    enabled:  !!deviceId && isInterfaceMetric,
  })

  // Clear the interface selection once the chosen metric is no longer interface-scoped.
  useEffect(() => {
    if (selectedMetric && selectedMetric.category !== 'interface') setIfaceName('')
  }, [selectedMetric])

  // Prefill thresholds from the registry's defaults for the selected metric,
  // unless the user has already touched (or this widget already had) custom thresholds.
  useEffect(() => {
    if (!thresholdsTouched && selectedMetric?.thresholds) {
      setWarn(String(selectedMetric.thresholds.warn))
      setCrit(String(selectedMetric.thresholds.crit))
    }
  }, [selectedMetric, thresholdsTouched])

  const trapRef = useFocusTrap<HTMLDivElement>(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSave = isTextNote
    ? true
    : !!deviceId && !!metricId && (!isInterfaceMetric || !!ifaceName)

  const handleSave = () => {
    if (isTextNote) {
      onSave({ title: title || undefined, text })
      return
    }
    const device = devices.find(d => d.id === deviceId)
    const config: MetricWidgetConfig = {
      title:     title || undefined,
      device_id: deviceId,
      device_name: device ? (device.fqdn ?? device.hostname) : undefined,
      metric_id: metricId,
    }
    if (isInterfaceMetric) config.interface_name = ifaceName
    if (showThresholds) {
      config.thresholds = (warn !== '' && crit !== '')
        ? { warn: Number(warn), crit: Number(crit) }
        : null
    }
    onSave(config)
  }

  const deviceMetrics    = catalog.filter(m => m.category === 'device')
  const interfaceMetrics = catalog.filter(m => m.category === 'interface')

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Configure widget">
      <div ref={trapRef} className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-800">Configure widget</h2>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className={labelCls}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder={selectedMetric?.label ?? 'Untitled'}
              className={inputCls} />
          </div>

          {isTextNote ? (
            <div>
              <label className={labelCls}>Text</label>
              <textarea value={text} onChange={e => setText(e.target.value)}
                rows={6} placeholder="Write a note…" className={`${inputCls} resize-none`} />
            </div>
          ) : (
            <>
              <div>
                <label className={labelCls}>Device</label>
                <select value={deviceId} onChange={e => setDeviceId(e.target.value)} className={inputCls}>
                  <option value="">Select a device…</option>
                  {devices.map(d => (
                    <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelCls}>Metric</label>
                <select value={metricId} onChange={e => setMetricId(e.target.value)} className={inputCls}>
                  <option value="">Select a metric…</option>
                  {deviceMetrics.length > 0 && (
                    <optgroup label="Device">
                      {deviceMetrics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  )}
                  {interfaceMetrics.length > 0 && (
                    <optgroup label="Interface">
                      {interfaceMetrics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>

              {isInterfaceMetric && (
                <div>
                  <label className={labelCls}>Interface</label>
                  <select value={ifaceName} onChange={e => setIfaceName(e.target.value)} className={inputCls} disabled={!deviceId}>
                    <option value="">{deviceId ? 'Select an interface…' : 'Select a device first'}</option>
                    {interfaces.map(i => (
                      <option key={i.id} value={i.name}>{i.name}{i.description ? ` — ${i.description}` : ''}</option>
                    ))}
                  </select>
                </div>
              )}

              {showThresholds && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Warning threshold</label>
                    <input type="number" value={warn}
                      onChange={e => { setWarn(e.target.value); setThresholdsTouched(true) }}
                      placeholder={selectedMetric?.thresholds?.warn?.toString() ?? '—'} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Critical threshold</label>
                    <input type="number" value={crit}
                      onChange={e => { setCrit(e.target.value); setThresholdsTouched(true) }}
                      placeholder={selectedMetric?.thresholds?.crit?.toString() ?? '—'} className={inputCls} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
