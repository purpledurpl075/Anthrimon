import { useQuery } from '@tanstack/react-query'
import { fetchSyslogMessages } from '../../api/overview'
import { SEV_LABEL, SEV_FEED_COLOR } from './shared'

// ── Syslog live feed ──────────────────────────────────────────────────────────

export function SyslogFeedWidget() {
  const { data, isLoading } = useQuery({
    queryKey:        ['syslog-feed'],
    queryFn:         () => fetchSyslogMessages(3, 10),
    refetchInterval: 15_000,
    staleTime:       10_000,
  })
  const messages: any[] = (data as any)?.messages ?? []

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <h3 className="text-sm font-semibold text-slate-800">Syslog — critical &amp; above</h3>
        </div>
        <span className="text-[10px] text-slate-400">live · 15 s</span>
      </div>
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-slate-400">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-green-600 font-medium">✓ No critical messages</p>
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 divide-y divide-slate-50">
          {messages.map((m: any, i: number) => (
            <div key={i} className="px-4 py-2.5 hover:bg-slate-50">
              <div className="flex items-start gap-2">
                <span
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 text-white"
                  style={{ backgroundColor: SEV_FEED_COLOR[m.severity] ?? '#dc2626' }}
                >
                  {SEV_LABEL[m.severity] ?? 'CRIT'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-slate-400 font-mono">{m.hostname || m.device_name} · {m.program}</p>
                  <p className="text-xs text-slate-700 truncate mt-0.5">{m.message}</p>
                </div>
                <span className="text-[9px] text-slate-300 shrink-0 tabular-nums">
                  {new Date(m.ts).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
