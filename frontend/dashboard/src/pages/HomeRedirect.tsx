import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchDashboards } from '../api/dashboards'

/** Lands the user on their default dashboard (or first available one). */
export default function HomeRedirect() {
  const { data: dashboards, isLoading } = useQuery({
    queryKey: ['dashboards'],
    queryFn: fetchDashboards,
    retry: false,
  })

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-slate-400">Loading…</div>
  }

  const target = dashboards?.find(d => d.is_default) ?? dashboards?.[0]
  return <Navigate to={target ? `/dashboards/${target.id}` : '/dashboards'} replace />
}
