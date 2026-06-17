import api from './client'

export interface LicenseStatus {
  valid: boolean
  modules: string[]
  max_devices: number
  tenant: string | null
  lic_id: string | null
  expires_at: string | null
  machine_bound: boolean
  machine_match: boolean
  reason: string
  machine_fingerprint: string
  newly_mounted_modules?: string[]
}

export const fetchLicense = () =>
  api.get<LicenseStatus>('/license').then((r) => r.data)

export const deleteLicense = () =>
  api.delete<LicenseStatus>('/platform/license').then((r) => r.data)

/** Download the machine-bound license request as a file (uses raw fetch for the
 *  blob + auth header, matching the codebase's download helpers). */
export async function downloadLicenseRequest(): Promise<void> {
  const token = localStorage.getItem('token')
  const res = await fetch('/api/v1/platform/license/request', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Request download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'anthrimon-license-request.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Upload a license file (multipart). Raw fetch — the JSON api wrapper can't
 *  send FormData. Returns the new license status, or throws with the server detail. */
export async function uploadLicense(file: File): Promise<LicenseStatus> {
  const token = localStorage.getItem('token')
  const fd = new FormData()
  fd.append('file', file, file.name)
  const res = await fetch('/api/v1/platform/license', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`
    try { msg = (await res.json()).detail ?? msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json()
}
