import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchSavedViews, createSavedView, updateSavedView, deleteSavedView } from '../api/savedViews'
import { useCurrentUser, useRole, hasRole } from '../hooks/useCurrentUser'

interface Props {
  page: string
  query: string
  onApply: (query: string) => void
}

export default function SavedViewsMenu({ page, query, onApply }: Props) {
  const qc = useQueryClient()
  const role = useRole()
  const { data: me } = useCurrentUser()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: views = [] } = useQuery({
    queryKey: ['saved-views', page],
    queryFn:  () => fetchSavedViews(page),
    enabled:  open,
  })

  const createMutation = useMutation({
    mutationFn: createSavedView,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saved-views', page] })
      setName('')
      setShared(false)
      setError(null)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? 'Failed to save view')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { query: string } }) => updateSavedView(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', page] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteSavedView,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', page] }),
  })

  const mine   = views.filter(v => v.user_id === me?.id)
  const shared_ = views.filter(v => v.user_id !== me?.id)

  const handleSave = () => {
    if (!name.trim()) return
    createMutation.mutate({ page, name: name.trim(), query, is_shared: shared })
  }

  const apply = (q: string) => {
    onApply(q)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border text-slate-500 border-slate-200 hover:border-slate-400 transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 0 1 2-2h6.5L19 8.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5z"/>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 3v5h5"/>
        </svg>
        Views
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6"/></svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-2 w-64"
          onMouseLeave={() => setOpen(false)}>
          {views.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400">No saved views yet</div>
          )}

          {mine.length > 0 && (
            <>
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">My views</div>
              {mine.map(v => (
                <div key={v.id} className="flex items-center justify-between gap-1 px-3 py-1.5 hover:bg-slate-50 group">
                  <button onClick={() => apply(v.query)} className="flex-1 text-left text-xs text-slate-700 truncate">
                    {v.name}
                    {v.is_shared && <span className="ml-1.5 text-[10px] text-blue-500">shared</span>}
                  </button>
                  <span className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
                    {v.query !== query && (
                      <button onClick={() => updateMutation.mutate({ id: v.id, data: { query } })}
                        className="text-slate-400 hover:text-blue-600 leading-none text-[10px]"
                        title="Update to current filters" aria-label={`Update view "${v.name}" to current filters`}>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"/></svg>
                      </button>
                    )}
                    <button onClick={() => deleteMutation.mutate(v.id)}
                      className="text-slate-400 hover:text-red-600 leading-none"
                      title="Delete view" aria-label={`Delete view "${v.name}"`}>×</button>
                  </span>
                </div>
              ))}
            </>
          )}

          {shared_.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide border-t border-slate-100 mt-1">Shared</div>
              {shared_.map(v => (
                <button key={v.id} onClick={() => apply(v.query)}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 truncate">
                  {v.name}
                  {v.owner_name && <span className="ml-1.5 text-[10px] text-slate-400">by {v.owner_name}</span>}
                </button>
              ))}
            </>
          )}

          <div className="px-3 pt-2 mt-1 border-t border-slate-100 space-y-1.5">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Name this view…"
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center justify-between">
              {hasRole(role, 'operator') ? (
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                  <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} className="rounded border-slate-300 text-blue-600"/>
                  Share with tenant
                </label>
              ) : <span />}
              <button onClick={handleSave} disabled={!name.trim() || createMutation.isPending}
                className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                Save view
              </button>
            </div>
            {error && <div className="text-[11px] text-red-600">{error}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
