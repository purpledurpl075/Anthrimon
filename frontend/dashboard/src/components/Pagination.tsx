interface Props {
  total: number
  limit: number
  offset: number
  onChange: (offset: number) => void
}

export default function Pagination({ total, limit, offset, onChange }: Props) {
  if (total <= limit) return null

  const page = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)
  const hasPrev = offset > 0
  const hasNext = offset + limit < total

  const pages: (number | '...')[] = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      pages.push(i)
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...')
    }
  }

  return (
    <div className="flex items-center justify-between px-1 py-3">
      <span className="text-xs text-slate-500">
        {offset + 1}–{Math.min(offset + limit, total)} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={!hasPrev}
          className="px-2.5 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous page"
        >
          ‹ Prev
        </button>
        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="px-1 text-xs text-slate-400">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onChange((p - 1) * limit)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                p === page
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onChange(offset + limit)}
          disabled={!hasNext}
          className="px-2.5 py-1 text-xs rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Next page"
        >
          Next ›
        </button>
      </div>
    </div>
  )
}
