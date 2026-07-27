import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createSchedule, deleteRun, deleteSchedule, downloadRun, fetchRuns, fetchSchedules, previewReport, runReportNow,
  updateSchedule, type ReportFormat, type ReportRun, type ReportType, type ScheduledReport,
} from '../api/reports'
import { fetchSites, type SiteOption } from '../api/devices'

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  capacity: 'Capacity & Utilisation', sla: 'SLA / Uptime', inventory: 'Inventory',
  compliance: 'Config Compliance', alert_summary: 'Alert Summary / MTTR',
  config_changes: 'Config Change History', flow_top_talkers: 'Top Talkers / Flow',
  interface_health: 'Interface Errors / Health', bgp_health: 'BGP / Routing Health',
  syslog_security: 'Syslog / Security Events',
  bundle: 'Bundle (multiple types)',
}
// The 10 real, data-backed types — everything except the synthetic "bundle".
const REAL_TYPES = (Object.keys(REPORT_TYPE_LABEL) as ReportType[]).filter(t => t !== 'bundle')
// Types with a meaningful "vs. previous period" comparison — mirrors the
// backend's comparisons.py::REPORT_DELTA_FUNCS keys exactly.
const COMPARISON_TYPES = new Set<ReportType>([
  'capacity', 'sla', 'compliance', 'alert_summary', 'config_changes',
  'flow_top_talkers', 'interface_health', 'bgp_health',
])
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily at 06:00 UTC', value: '0 6 * * *' },
  { label: 'Weekly, Monday 06:00 UTC', value: '0 6 * * 1' },
  { label: 'Monthly, 1st at 06:00 UTC', value: '0 6 1 * *' },
]
const DATE_PRESETS = [
  { label: 'Default window', value: '' },
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
  { label: 'Custom range…', value: 'custom' },
]

function StatusBadge({ status }: { status: ReportRun['status'] }) {
  const cls = {
    success: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    running: 'bg-blue-100 text-blue-600',
    pending: 'bg-slate-100 text-slate-500',
  }[status]
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${cls}`}>{status}</span>
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

// ── Shared filter controls (date range / site / compare / bundle types) ────

interface FilterState {
  datePreset: string
  start: string
  end: string
  siteId: string
  compare: boolean
  bundleTypes: ReportType[]
}

const emptyFilterState = (): FilterState => ({
  datePreset: '', start: '', end: '', siteId: '', compare: false, bundleTypes: [],
})

function filterStateToFilters(state: FilterState): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (state.datePreset === 'custom') {
    if (state.start && state.end) {
      filters.start = new Date(state.start).toISOString()
      filters.end = new Date(state.end).toISOString()
    }
  } else if (state.datePreset) {
    filters.window_days = parseInt(state.datePreset, 10)
  }
  if (state.siteId) filters.site_id = state.siteId
  if (state.compare) filters.compare = true
  if (state.bundleTypes.length > 0) filters.report_types = state.bundleTypes
  return filters
}

/** filters dict -> FilterState, for prefilling the edit-schedule modal from
 * an existing ScheduledReport.filters (best-effort — unknown/legacy keys
 * like a bare `window`/`window_days` from before this feature just fall
 * back to the default-window preset). */
function filtersToFilterState(filters: Record<string, unknown>): FilterState {
  const state = emptyFilterState()
  if (typeof filters.start === 'string' && typeof filters.end === 'string') {
    state.datePreset = 'custom'
    state.start = filters.start.slice(0, 10)
    state.end = filters.end.slice(0, 10)
  } else if (typeof filters.window_days === 'number') {
    state.datePreset = String(filters.window_days)
  }
  if (typeof filters.site_id === 'string') state.siteId = filters.site_id
  if (filters.compare === true) state.compare = true
  if (Array.isArray(filters.report_types)) state.bundleTypes = filters.report_types as ReportType[]
  return state
}

function FilterFields({
  reportType, state, setState, sites,
}: {
  reportType: ReportType
  state: FilterState
  setState: (updater: (s: FilterState) => FilterState) => void
  sites: SiteOption[]
}) {
  const isBundle = reportType === 'bundle'
  const toggleBundleType = (t: ReportType) =>
    setState(s => ({
      ...s,
      bundleTypes: s.bundleTypes.includes(t) ? s.bundleTypes.filter(x => x !== t) : [...s.bundleTypes, t],
    }))

  return (
    <>
      {reportType !== 'inventory' && (
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date range</label>
          <select value={state.datePreset} onChange={e => setState(s => ({ ...s, datePreset: e.target.value }))}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {state.datePreset === 'custom' && (
            <div className="flex gap-2 mt-2">
              <input type="date" value={state.start} onChange={e => setState(s => ({ ...s, start: e.target.value }))}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="date" value={state.end} onChange={e => setState(s => ({ ...s, end: e.target.value }))}
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Site (optional)</label>
        <select value={state.siteId} onChange={e => setState(s => ({ ...s, siteId: e.target.value }))}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All sites</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </div>
      {COMPARISON_TYPES.has(reportType) && (
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={state.compare} onChange={e => setState(s => ({ ...s, compare: e.target.checked }))}
            className="rounded border-slate-300 text-blue-600" />
          Compare to previous period
        </label>
      )}
      {isBundle && (
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Report types to include</label>
          <div className="grid grid-cols-2 gap-1.5 border border-slate-200 rounded-lg p-2.5 max-h-40 overflow-y-auto">
            {REAL_TYPES.map(t => (
              <label key={t} className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={state.bundleTypes.includes(t)} onChange={() => toggleBundleType(t)}
                  className="rounded border-slate-300 text-blue-600" />
                {REPORT_TYPE_LABEL[t]}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ── Preview modal ────────────────────────────────────────────────────────────

function PreviewModal({ html, onClose }: { html: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-slate-800">Preview</h2>
          <button onClick={onClose} aria-label="Close preview" className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <iframe title="Report preview" srcDoc={html} className="flex-1 w-full rounded-b-2xl" />
      </div>
    </div>
  )
}

function usePreview() {
  const [html, setHtml] = useState<string | null>(null)
  const preview = useMutation({
    mutationFn: (body: { report_type: ReportType; filters?: Record<string, unknown> }) => previewReport(body),
    onSuccess: setHtml,
  })
  return { preview, html, close: () => setHtml(null) }
}

// ── New schedule form ───────────────────────────────────────────────────────

function NewScheduleForm({ sites, onClose, onCreated }: { sites: SiteOption[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [reportType, setReportType] = useState<ReportType>('capacity')
  const [formats, setFormats] = useState<ReportFormat[]>(['pdf'])
  const [cron, setCron] = useState(CRON_PRESETS[0].value)
  const [customCron, setCustomCron] = useState(false)
  const [recipients, setRecipients] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailNote, setEmailNote] = useState('')
  const [filterState, setFilterState] = useState<FilterState>(emptyFilterState())
  const { preview, html, close } = usePreview()

  const create = useMutation({
    mutationFn: () => createSchedule({
      name: name.trim(),
      report_type: reportType,
      formats,
      filters: filterStateToFilters(filterState),
      recurrence_cron: cron.trim(),
      recipients: recipients.split(',').map(r => r.trim()).filter(Boolean),
      email_subject: emailSubject.trim() || null,
      email_note: emailNote.trim() || null,
    }),
    onSuccess: () => { onCreated(); onClose() },
  })

  const toggleFormat = (f: ReportFormat) =>
    setFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  const bundleReady = reportType !== 'bundle' || filterState.bundleTypes.length > 0

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-slate-800">New scheduled report</h2>
          <button onClick={onClose} aria-label="Close dialog" className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Monthly capacity report"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Report type</label>
            <select value={reportType} onChange={e => setReportType(e.target.value as ReportType)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map(t => (
                <option key={t} value={t}>{REPORT_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <FilterFields reportType={reportType} state={filterState} setState={setFilterState} sites={sites} />
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Format</label>
            <div className="flex gap-3">
              {(['pdf', 'csv'] as ReportFormat[]).map(f => (
                <label key={f} className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={formats.includes(f)} onChange={() => toggleFormat(f)}
                    className="rounded border-slate-300 text-blue-600" />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Schedule</label>
            {!customCron ? (
              <select value={cron} onChange={e => {
                if (e.target.value === '__custom__') { setCustomCron(true); return }
                setCron(e.target.value)
              }} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                <option value="__custom__">Custom cron expression…</option>
              </select>
            ) : (
              <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 6 * * *"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email recipients (comma-separated)</label>
            <input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="ops@example.com, noc@example.com"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email subject (optional)</label>
            <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Defaults to [Company] Report type report"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email intro note (optional)</label>
            <textarea value={emailNote} onChange={e => setEmailNote(e.target.value)} rows={2} placeholder="Extra line included above the report attachment"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {create.isError && (
            <p className="text-xs text-red-500">{(create.error as any)?.response?.data?.detail ?? 'Failed to create schedule'}</p>
          )}
          {preview.isError && (
            <p className="text-xs text-red-500">{(preview.error as Error)?.message ?? 'Preview failed'}</p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={() => preview.mutate({ report_type: reportType, filters: filterStateToFilters(filterState) })}
            disabled={!bundleReady || preview.isPending}
            className="px-4 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">
            {preview.isPending ? 'Rendering…' : 'Preview'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={() => create.mutate()} disabled={!name.trim() || formats.length === 0 || !bundleReady || create.isPending}
            className="px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create schedule'}
          </button>
        </div>
      </div>
      {html != null && <PreviewModal html={html} onClose={close} />}
    </div>
  )
}

// ── Edit schedule modal ──────────────────────────────────────────────────────

function EditScheduleModal({ sched, sites, onClose, onSaved }: {
  sched: ScheduledReport; sites: SiteOption[]; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(sched.name)
  const [formats, setFormats] = useState<ReportFormat[]>(sched.formats)
  const [cron, setCron] = useState(sched.recurrence_cron)
  const [recipients, setRecipients] = useState(sched.recipients.join(', '))
  const [emailSubject, setEmailSubject] = useState(sched.email_subject ?? '')
  const [emailNote, setEmailNote] = useState(sched.email_note ?? '')
  const [filterState, setFilterState] = useState<FilterState>(filtersToFilterState(sched.filters))
  const { preview, html, close } = usePreview()

  const save = useMutation({
    mutationFn: () => updateSchedule(sched.id, {
      name: name.trim(),
      formats,
      filters: filterStateToFilters(filterState),
      recurrence_cron: cron.trim(),
      recipients: recipients.split(',').map(r => r.trim()).filter(Boolean),
      email_subject: emailSubject.trim() || null,
      email_note: emailNote.trim() || null,
    }),
    onSuccess: () => { onSaved(); onClose() },
  })

  const toggleFormat = (f: ReportFormat) =>
    setFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  const bundleReady = sched.report_type !== 'bundle' || filterState.bundleTypes.length > 0

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-slate-800">Edit "{sched.name}"</h2>
          <button onClick={onClose} aria-label="Close dialog" className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <p className="text-xs text-slate-400">Report type: {REPORT_TYPE_LABEL[sched.report_type]} (fixed after creation)</p>
          <FilterFields reportType={sched.report_type} state={filterState} setState={setFilterState} sites={sites} />
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Format</label>
            <div className="flex gap-3">
              {(['pdf', 'csv'] as ReportFormat[]).map(f => (
                <label key={f} className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={formats.includes(f)} onChange={() => toggleFormat(f)}
                    className="rounded border-slate-300 text-blue-600" />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Schedule (cron)</label>
            <input value={cron} onChange={e => setCron(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email recipients (comma-separated)</label>
            <input value={recipients} onChange={e => setRecipients(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email subject (optional)</label>
            <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Email intro note (optional)</label>
            <textarea value={emailNote} onChange={e => setEmailNote(e.target.value)} rows={2}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {save.isError && (
            <p className="text-xs text-red-500">{(save.error as any)?.response?.data?.detail ?? 'Failed to save'}</p>
          )}
          {preview.isError && (
            <p className="text-xs text-red-500">{(preview.error as Error)?.message ?? 'Preview failed'}</p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={() => preview.mutate({ report_type: sched.report_type, filters: filterStateToFilters(filterState) })}
            disabled={!bundleReady || preview.isPending}
            className="px-4 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">
            {preview.isPending ? 'Rendering…' : 'Preview'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!name.trim() || formats.length === 0 || !bundleReady || save.isPending}
            className="px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      {html != null && <PreviewModal html={html} onClose={close} />}
    </div>
  )
}

// ── Run now card ─────────────────────────────────────────────────────────────

function RunNowCard({ sites, onRun }: { sites: SiteOption[]; onRun: () => void }) {
  const [reportType, setReportType] = useState<ReportType>('capacity')
  const [format, setFormat] = useState<ReportFormat>('pdf')
  const [filterState, setFilterState] = useState<FilterState>(emptyFilterState())
  const { preview, html, close } = usePreview()

  const run = useMutation({
    mutationFn: () => runReportNow({ report_type: reportType, format, filters: filterStateToFilters(filterState) }),
    onSuccess: onRun,
  })

  const bundleReady = reportType !== 'bundle' || filterState.bundleTypes.length > 0

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Run a report now</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-1">Type</label>
          <select value={reportType} onChange={e => setReportType(e.target.value as ReportType)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map(t => (
              <option key={t} value={t}>{REPORT_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-1">Format</label>
          <select value={format} onChange={e => setFormat(e.target.value as ReportFormat)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="pdf">PDF</option>
            <option value="csv">CSV</option>
          </select>
        </div>
        {reportType !== 'inventory' && (
          <div>
            <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-1">Date range</label>
            <select value={filterState.datePreset} onChange={e => setFilterState(s => ({ ...s, datePreset: e.target.value }))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        )}
        {filterState.datePreset === 'custom' && (
          <>
            <input type="date" value={filterState.start} onChange={e => setFilterState(s => ({ ...s, start: e.target.value }))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <input type="date" value={filterState.end} onChange={e => setFilterState(s => ({ ...s, end: e.target.value }))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </>
        )}
        <div>
          <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-1">Site</label>
          <select value={filterState.siteId} onChange={e => setFilterState(s => ({ ...s, siteId: e.target.value }))}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All sites</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </div>
        {COMPARISON_TYPES.has(reportType) && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer pb-1.5">
            <input type="checkbox" checked={filterState.compare} onChange={e => setFilterState(s => ({ ...s, compare: e.target.checked }))}
              className="rounded border-slate-300 text-blue-600" />
            Compare
          </label>
        )}
        <button onClick={() => preview.mutate({ report_type: reportType, filters: filterStateToFilters(filterState) })}
          disabled={!bundleReady || preview.isPending}
          className="px-4 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">
          {preview.isPending ? 'Rendering…' : 'Preview'}
        </button>
        <button onClick={() => run.mutate()} disabled={!bundleReady || run.isPending}
          className="px-4 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50">
          {run.isPending ? 'Starting…' : 'Run now'}
        </button>
        {run.isSuccess && <span className="text-xs text-green-600">Started — see Recent runs below.</span>}
      </div>
      {reportType === 'bundle' && (
        <div className="mt-3">
          <FilterFields reportType={reportType} state={filterState} setState={setFilterState} sites={sites} />
        </div>
      )}
      {preview.isError && (
        <p className="text-xs text-red-500 mt-2">{(preview.error as Error)?.message ?? 'Preview failed'}</p>
      )}
      {html != null && <PreviewModal html={html} onClose={close} />}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<ScheduledReport | null>(null)

  const { data: schedules = [], isLoading: schedulesLoading } = useQuery({
    queryKey: ['report-schedules'], queryFn: fetchSchedules,
  })
  const { data: runs = [], isLoading: runsLoading } = useQuery({
    queryKey: ['report-runs'], queryFn: fetchRuns, refetchInterval: 5_000,
  })
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: fetchSites })

  const toggleEnabled = useMutation({
    mutationFn: (s: ScheduledReport) => updateSchedule(s.id, { is_enabled: !s.is_enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }),
  })
  const removeRun = useMutation({
    mutationFn: (id: string) => deleteRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-runs'] }),
  })

  const invalidateRuns = () => qc.invalidateQueries({ queryKey: ['report-runs'] })

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">Advanced Reports</h1>
        <p className="text-sm text-slate-500 mt-0.5">Scheduled, branded PDF/CSV reports across capacity, SLA, compliance, alerts, and more.</p>
      </div>

      <RunNowCard sites={sites} onRun={invalidateRuns} />

      <div className="bg-white rounded-2xl border border-slate-200">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Scheduled reports</h3>
          <button onClick={() => setShowNew(true)}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            + New schedule
          </button>
        </div>
        {schedulesLoading ? (
          <div className="p-6 text-sm text-slate-400">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">No scheduled reports yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {schedules.map(s => (
              <div key={s.id} className="px-5 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-800 truncate">{s.name}</span>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wide">{REPORT_TYPE_LABEL[s.report_type]}</span>
                    {s.consecutive_failures > 0 && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700"
                        title={`${s.consecutive_failures} consecutive failure${s.consecutive_failures !== 1 ? 's' : ''}`}>
                        {s.consecutive_failures}× failing
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5 font-mono">{s.recurrence_cron}</div>
                </div>
                <div className="text-xs text-slate-400 shrink-0 text-right">
                  <div>Next: {fmtDate(s.next_run_at)}</div>
                  <div>Last: {fmtDate(s.last_run_at)}</div>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0 cursor-pointer">
                  <input type="checkbox" checked={s.is_enabled} onChange={() => toggleEnabled.mutate(s)}
                    className="rounded border-slate-300 text-blue-600" />
                  Enabled
                </label>
                <button onClick={() => setEditing(s)}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 shrink-0">
                  Edit
                </button>
                <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) remove.mutate(s.id) }}
                  aria-label={`Delete schedule "${s.name}"`}
                  className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200">
        <div className="px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-800">Recent runs</h3>
        </div>
        {runsLoading ? (
          <div className="p-6 text-sm text-slate-400">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">No report runs yet — try "Run now" above.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {runs.map(r => (
              <div key={r.id} className="px-5 py-2.5 flex items-center gap-4">
                <span className="text-sm text-slate-700 flex-1">{REPORT_TYPE_LABEL[r.report_type]}</span>
                <span className="text-xs text-slate-400 uppercase w-10">{r.format}</span>
                <StatusBadge status={r.status} />
                <span className="text-xs text-slate-400 w-20 text-right">{fmtBytes(r.file_size_bytes)}</span>
                <span className="text-xs text-slate-400 w-40 text-right">{fmtDate(r.started_at)}</span>
                {r.status === 'success' ? (
                  <button onClick={() => downloadRun(r)}
                    className="text-xs font-medium text-blue-600 hover:underline shrink-0">Download</button>
                ) : r.status === 'failed' ? (
                  <span className="text-xs text-red-500 shrink-0" title={r.error ?? ''}>Failed</span>
                ) : (
                  <span className="text-xs text-slate-300 shrink-0">—</span>
                )}
                <button onClick={() => { if (confirm('Delete this saved report?')) removeRun.mutate(r.id) }}
                  aria-label={`Delete ${REPORT_TYPE_LABEL[r.report_type]} report from ${fmtDate(r.started_at)}`}
                  className="p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors shrink-0">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewScheduleForm sites={sites} onClose={() => setShowNew(false)} onCreated={() => qc.invalidateQueries({ queryKey: ['report-schedules'] })} />
      )}
      {editing && (
        <EditScheduleModal sched={editing} sites={sites} onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['report-schedules'] })} />
      )}
    </div>
  )
}
