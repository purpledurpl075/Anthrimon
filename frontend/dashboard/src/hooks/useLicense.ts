import { useQuery } from '@tanstack/react-query'
import { fetchLicense } from '../api/license'

/** License status, fetched at boot. Mirrors useCurrentUser's caching. */
export function useLicense() {
  return useQuery({
    queryKey: ['license'],
    queryFn: fetchLicense,
    staleTime: 60_000,
  })
}
