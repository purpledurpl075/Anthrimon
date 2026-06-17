import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { DashboardGrid } from '../components/DashboardGrid'
import { useDashboardWidgets } from '../hooks/useDashboardWidgets'

export default function KioskPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()

  const ids = useMemo(
    () => (params.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    [params],
  )
  const intervalS = Math.max(10, Number(params.get('interval')) || 30)

  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (ids.length <= 1) return
    const timer = setInterval(() => setIndex(i => (i + 1) % ids.length), intervalS * 1000)
    return () => clearInterval(timer)
  }, [ids.length, intervalS])

  useEffect(() => {
    if (index >= ids.length) setIndex(0)
  }, [ids.length, index])

  const currentId = ids[index] ?? ''
  const { dashboard, isLoading, widgets, timeRange, refreshIntervalS } = useDashboardWidgets(currentId)

  if (ids.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 dark:bg-slate-900 text-slate-500">
        <p className="text-sm">No dashboards selected for kiosk mode.</p>
        <button
          onClick={() => navigate('/dashboards')}
          className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors"
        >
          Back to Dashboards
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <button
        onClick={() => navigate('/dashboards')}
        title="Exit kiosk mode"
        className="fixed top-4 right-4 z-50 p-2 rounded-full bg-white/30 text-slate-400 opacity-40 hover:opacity-100 hover:bg-white hover:text-slate-600 hover:shadow-md transition-all"
      >
        <X className="w-5 h-5" />
      </button>

      {ids.length > 1 && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5">
          {ids.map((dashId, i) => (
            <button
              key={dashId}
              onClick={() => setIndex(i)}
              title={`Dashboard ${i + 1}`}
              className={`h-2 rounded-full transition-all ${i === index ? 'bg-slate-600 w-6' : 'bg-slate-300 w-2 hover:bg-slate-400'}`}
            />
          ))}
        </div>
      )}

      <div className="p-4 md:p-6">
        {isLoading || !dashboard ? (
          <div className="flex items-center justify-center h-[60vh] text-slate-400 text-sm">Loading…</div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-slate-700 dark:text-slate-300 mb-4">{dashboard.name}</h1>
            <DashboardGrid widgets={widgets} timeRange={timeRange} refreshIntervalS={refreshIntervalS} readOnly />
          </>
        )}
      </div>
    </div>
  )
}
