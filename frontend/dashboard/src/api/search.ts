import api from './client'

export type ResultType = 'device' | 'interface' | 'alert' | 'bgp_peer' | 'config' | 'address'

export interface SearchResult {
  type: ResultType
  id: string
  title: string
  subtitle: string | null
  url: string
  meta: string | null
}

export interface SearchResponse {
  results: SearchResult[]
}

export const fetchSearch = (q: string) =>
  api.get<SearchResponse>('/search', { params: { q } }).then(r => r.data)
