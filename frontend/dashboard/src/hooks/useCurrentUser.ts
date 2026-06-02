import { useQuery } from '@tanstack/react-query'
import api from '../api/client'

export interface Me {
  id: string
  username: string
  email: string
  role: string
  full_name: string | null
  is_platform_admin: boolean
  platform_role: string | null
  tenant_id: string
  tenant_name: string
}

const RANK: Record<string, number> = { readonly: 0, operator: 1, admin: 2, superadmin: 3 }

export function useCurrentUser() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn:  () => api.get<Me>('/auth/me').then(r => r.data),
    staleTime: 60_000,
  })
}

export function useRole(): string {
  const { data } = useCurrentUser()
  return data?.role ?? 'readonly'
}

/** Returns true if userRole meets or exceeds minRole in the hierarchy. */
export function hasRole(userRole: string, minRole: string): boolean {
  return (RANK[userRole] ?? 0) >= (RANK[minRole] ?? 0)
}
