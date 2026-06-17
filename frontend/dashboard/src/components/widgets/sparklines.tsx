// ── Mini sparkline ────────────────────────────────────────────────────────────

export function MiniSparkline({ inSeries, outSeries, w = 96, h = 32 }: {
  inSeries: [number, number][]
  outSeries: [number, number][]
  w?: number
  h?: number
}) {
  const all = [...inSeries, ...outSeries]
  if (all.length < 2) return <div style={{ width: w, height: h }} className="flex items-center justify-center text-[9px] text-slate-300">no data</div>

  const maxV   = Math.max(...all.map(([, v]) => v), 1)
  const allT   = all.map(([t]) => t)
  const minT   = Math.min(...allT)
  const rangeT = (Math.max(...allT) - minT) || 1

  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 1 - (v / maxV) * (h - 3)
  const pts = (s: [number, number][]) => s.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const area = (s: [number, number][]) => {
    if (s.length < 2) return ''
    const p = s.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' L ')
    return `M ${sx(s[0][0])},${h} L ${p} L ${sx(s.at(-1)![0])},${h} Z`
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      {inSeries.length >= 2 && <>
        <path d={area(inSeries)} fill="#0891b2" fillOpacity={0.15} />
        <polyline points={pts(inSeries)} fill="none" stroke="#0891b2" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </>}
      {outSeries.length >= 2 && <>
        <path d={area(outSeries)} fill="#f59e0b" fillOpacity={0.15} />
        <polyline points={pts(outSeries)} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </>}
    </svg>
  )
}

// ── Generic metric sparkline ─────────────────────────────────────────────────

export function MetricSparkline({ series, w = 120, h = 32, color = '#3b82f6' }: {
  series: [number, number][]
  w?: number
  h?: number
  color?: string
}) {
  if (series.length < 2) return <div style={{ width: w, height: h }} className="flex items-center justify-center text-[9px] text-slate-300">no data</div>

  const values = series.map(([, v]) => v)
  const maxV   = Math.max(...values)
  const minV   = Math.min(...values, 0)
  const rangeV = (maxV - minV) || 1
  const allT   = series.map(([t]) => t)
  const minT   = Math.min(...allT)
  const rangeT = (Math.max(...allT) - minT) || 1

  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 1 - ((v - minV) / rangeV) * (h - 3)
  const pts = series.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const area = `M ${sx(series[0][0])},${h} L ${pts.split(' ').join(' L ')} L ${sx(series.at(-1)![0])},${h} Z`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={area} fill={color} fillOpacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Alert trend sparkline ─────────────────────────────────────────────────────

export function AlertTrendSparkline({ series, w = 120, h = 20 }: { series: [number, number][]; w?: number; h?: number }) {
  if (series.length < 2) return null
  const maxV   = Math.max(...series.map(([, v]) => v), 1)
  const minT   = series[0][0]
  const maxT   = series.at(-1)![0]
  const rangeT = (maxT - minT) || 1
  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 1 - (v / maxV) * (h - 3)
  const pts = series.map(([t, v]) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const first = series[0], last = series.at(-1)!
  const areaPath = `M ${sx(first[0])},${h} L ${pts.split(' ').join(' L ')} L ${sx(last[0])},${h} Z`
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={areaPath} fill="#dc2626" fillOpacity={0.12} />
      <polyline points={pts} fill="none" stroke="#dc2626" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
