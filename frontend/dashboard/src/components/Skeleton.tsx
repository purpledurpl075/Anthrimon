const pulse = 'animate-pulse bg-slate-200 dark:bg-slate-700 rounded'

export function SkeletonLine({ w = 'w-full', h = 'h-3' }: { w?: string; h?: string }) {
  return <div className={`${pulse} ${w} ${h}`} />
}

export function SkeletonStatPill() {
  return (
    <div className="flex items-center gap-3">
      <div className={`${pulse} h-8 w-20 rounded-md`} />
      <div className={`${pulse} h-8 w-20 rounded-md`} />
      <div className={`${pulse} h-8 w-20 rounded-md`} />
      <div className={`${pulse} h-8 w-20 rounded-md`} />
    </div>
  )
}

export function SkeletonCard({ h = 'h-32' }: { h?: string }) {
  return (
    <div className={`${pulse} ${h} w-full rounded-lg`} />
  )
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="w-full">
      <div className="flex gap-4 px-5 py-3 border-b border-slate-100 dark:border-slate-800">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className={`${pulse} h-3 rounded`} style={{ width: `${100 / cols}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-5 py-3 border-b border-slate-50 dark:border-slate-800/50">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className={`${pulse} h-3 rounded`} style={{ width: `${60 + Math.random() * 30}%`, maxWidth: `${100 / cols}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonChart({ h = 'h-44' }: { h?: string }) {
  return (
    <div className={`${pulse} ${h} w-full rounded-lg`} />
  )
}

export function SkeletonPage() {
  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-900 p-6 space-y-4">
      <SkeletonLine w="w-48" h="h-5" />
      <SkeletonLine w="w-32" h="h-3" />
      <div className="mt-6">
        <SkeletonTable />
      </div>
    </div>
  )
}

export function SkeletonDetailPage() {
  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-900 p-6 space-y-4">
      <SkeletonLine w="w-48" h="h-5" />
      <SkeletonLine w="w-64" h="h-3" />
      <div className="grid grid-cols-4 gap-3 mt-4">
        <SkeletonCard h="h-20" />
        <SkeletonCard h="h-20" />
        <SkeletonCard h="h-20" />
        <SkeletonCard h="h-20" />
      </div>
      <SkeletonChart />
    </div>
  )
}

export function SkeletonInline() {
  return <div className={`${pulse} h-3 w-16 inline-block align-middle rounded`} />
}
