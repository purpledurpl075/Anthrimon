import api from './client'

export interface SavedView {
  id: string
  page: string
  name: string
  query: string
  is_shared: boolean
  user_id: string
  owner_name: string | null
  created_at: string
  updated_at: string
}

export interface SavedViewCreate {
  page: string
  name: string
  query: string
  is_shared: boolean
}

export const fetchSavedViews = (page: string) =>
  api.get<SavedView[]>('/saved-views', { params: { page } }).then(r => r.data)

export const createSavedView = (data: SavedViewCreate) =>
  api.post<SavedView>('/saved-views', data).then(r => r.data)

export interface SavedViewUpdate {
  name?: string
  query?: string
  is_shared?: boolean
}

export const updateSavedView = (id: string, data: SavedViewUpdate) =>
  api.patch<SavedView>(`/saved-views/${id}`, data).then(r => r.data)

export const deleteSavedView = (id: string) =>
  api.delete<void>(`/saved-views/${id}`)
