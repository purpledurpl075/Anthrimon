const BASE = '/api/v1'

let _redirecting = false

async function request<T>(method: string, path: string, body?: unknown): Promise<{ data: T }> {
  if (_redirecting) return Promise.reject(new Error('Session expired'))

  const token = localStorage.getItem('token')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    if (!_redirecting) {
      _redirecting = true
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(new Error('Unauthorized'))
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    return Promise.reject({ response: { status: res.status, data: err } })
  }

  // 204 No Content
  if (res.status === 204) return { data: undefined as T }

  return { data: await res.json() }
}

const api = {
  get:    <T>(path: string, opts?: { params?: Record<string, unknown> }) => {
    const url = opts?.params
      ? `${path}?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(opts.params)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => [k, String(v)])
          )
        )}`
      : path
    return request<T>('GET', url)
  },
  post:   <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch:  <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put:    <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

export default api
