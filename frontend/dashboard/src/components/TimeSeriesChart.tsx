import React, { useState, useEffect, useRef } from 'react'

// ── Helpers ────────────────────────────────────────────────────────────────

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const step = Math.pow(10, exp)
  for (const m of [1, 2, 5, 10]) if (m * step >= v) return m * step
  return 10 * step
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Series {
  name:  string
  color: string
  data:  [number, number][]
}

interface Props {
  series:  Series[]
  height?: number
  yFmt?:   (v: number) => string
  empty?:  string
  live?:   boolean
}

// ── Chart ──────────────────────────────────────────────────────────────────

const M = { top: 10, right: 16, bottom: 28, left: 56 }

export default function TimeSeriesChart({ series, height = 180, yFmt = String, empty = 'No data', live = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [w, setW]       = useState(700)
  const [hoverI, setHI] = useState<number | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(e => setW(e[0].contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const allPts = series.flatMap(s => s.data)
  if (allPts.length === 0) {
    return (
      <div ref={containerRef} style={{ height }} className="flex items-center justify-center text-slate-300 text-sm">
        {empty}
      </div>
    )
  }

  const maxV   = niceMax(Math.max(...allPts.map(([, v]) => v), 1))
  const minT   = Math.min(...allPts.map(([t]) => t))
  const maxT   = Math.max(...allPts.map(([t]) => t))
  const rangeT = maxT - minT || 1
  const iW     = w - M.left - M.right
  const iH     = height - M.top - M.bottom

  const sx = (t: number) => M.left + ((t - minT) / rangeT) * iW
  const sy = (v: number) => M.top + iH - Math.max(0, Math.min(1, v / maxV)) * iH

  const yTicks  = [0.25, 0.5, 0.75, 1.0].map(f => maxV * f)
  const xTicks  = 5
  const refData = series.find(s => s.data.length > 0)?.data ?? []

  const linePts  = (data: [number, number][]) =>
    data.length < 2 ? '' : data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')
  const areaPath = (data: [number, number][]) => {
    if (data.length < 2) return ''
    const line = data.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' L ')
    return `M ${sx(data[0][0])},${sy(0)} L ${line} L ${sx(data.at(-1)![0])},${sy(0)} Z`
  }

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx   = e.clientX - rect.left - M.left
    if (mx < 0 || mx > iW || refData.length === 0) { setHI(null); return }
    const t = minT + (mx / iW) * rangeT
    let ni = 0, minD = Infinity
    refData.forEach(([pt], idx) => {
      const d = Math.abs(pt - t)
      if (d < minD) { minD = d; ni = idx }
    })
    setHI(ni)
  }

  const hoverT = hoverI != null ? (refData[hoverI]?.[0] ?? null) : null
  const hoverX = hoverT != null ? sx(hoverT) : null

  return (
    <div ref={containerRef} className="w-full relative select-none">
      <svg width={w} height={height} onMouseMove={onMouseMove} onMouseLeave={() => setHI(null)} style={{ cursor: 'crosshair' }}>
        {yTicks.map(v => (
          <g key={v}>
            <line x1={M.left} x2={w - M.right} y1={sy(v)} y2={sy(v)} stroke="#f1f5f9" strokeWidth={1} />
            <text x={M.left - 6} y={sy(v)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#94a3b8">
              {yFmt(v)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={w - M.right} y1={sy(0)} y2={sy(0)} stroke="#e2e8f0" strokeWidth={1} />

        {Array.from({ length: xTicks }, (_, i) => {
          const frac    = i / (xTicks - 1)
          const t       = minT + frac * rangeT
          const secsAgo = maxT - t
          const label   = live
            ? (i === xTicks - 1 ? 'now' : `-${Math.round(secsAgo)}s`)
            : (i === xTicks - 1 ? 'now'
              : secsAgo >= 3600 ? `${Math.round(secsAgo / 3600)}h`
              : `${Math.round(secsAgo / 60)}m`)
          return (
            <text key={i} x={sx(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="#94a3b8">
              {label}
            </text>
          )
        })}

        {series.map(s => s.data.length >= 2 && (
          <g key={s.name}>
            <path d={areaPath(s.data)} fill={s.color} fillOpacity={0.12} />
            <polyline points={linePts(s.data)} fill="none" stroke={s.color} strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ))}

        {hoverX != null && (
          <>
            <line x1={hoverX} x2={hoverX} y1={M.top} y2={height - M.bottom}
              stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 2" />
            {series.map(s => {
              const pt = s.data[hoverI!]
              return pt ? (
                <circle key={s.name} cx={sx(pt[0])} cy={sy(pt[1])} r={3.5}
                  fill={s.color} stroke="white" strokeWidth={1.5} />
              ) : null
            })}
          </>
        )}
      </svg>

      {hoverI != null && hoverX != null && (
        <div
          className="absolute bg-slate-800 text-white text-[11px] rounded-lg px-2.5 py-2 shadow-xl pointer-events-none z-10 whitespace-nowrap"
          style={{ top: M.top, left: hoverX + (hoverX > w * 0.65 ? -200 : 12) }}
        >
          {series.map(s => {
            const pt = s.data[hoverI!]
            return pt ? (
              <div key={s.name} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                <span className="text-slate-300 w-20">{s.name}</span>
                <span className="font-semibold font-mono">{yFmt(pt[1])}</span>
              </div>
            ) : null
          })}
        </div>
      )}
    </div>
  )
}
