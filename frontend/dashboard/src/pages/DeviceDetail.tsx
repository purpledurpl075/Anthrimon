import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow, Controls, Background, MiniMap,
  useNodesState, useEdgesState, Handle, Position,
  type NodeProps, type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { fetchDevice, fetchDeviceHealth, fetchDeviceHealthHistory, fetchDeviceLatency, fetchDeviceInterfaces, fetchDeviceBaselines, overrideBaseline, deleteDevice, patchDevice, setAlertExclusions, fetchDeviceCredentials, linkDeviceCredential, unlinkDeviceCredential, runSnmpDiag, fetchDeviceNeighbors, fetchDeviceOSPF, fetchDeviceAddresses, fetchDeviceRoutes, fetchDeviceVlans, fetchDeviceStp, fetchDeviceTraps, discoverSnmpEngineId, type AddressEntry, type VlanEntry, type StpPort, type BaselineRow, type TrapEvent } from '../api/devices'
import TimeSeriesChart from '../components/TimeSeriesChart'
import { fetchCredentials } from '../api/credentials'
import { fetchConfigStatus, fetchBackups, fetchDiffs, fetchBackup, fetchDiff, triggerCollect, fetchComplianceResults, deployConfig, rollbackConfig, fetchGoldenConfigResults, fetchGitLog, fetchGitShow, type ConfigBackupMeta, type ConfigDiffMeta, type GoldenConfigResult, type GitLogEntry } from '../api/config'
import { fetchAlerts } from '../api/alerts'
import { fetchCollectors } from '../api/collectors'
import { fetchDeviceBGPSessions, fetchBGPSessionEvents, fetchBGPPrefixHistory, type BGPSession, type BGPSessionEvent, type BGPPeerSeries } from '../api/bgp'
import { fetchMaintenanceWindows, createMaintenanceWindow, deleteMaintenanceWindow, type MaintenanceWindow } from '../api/maintenance'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'
import { formatAge, formatUptime } from '../utils/time'
import ErrorState from '../components/ErrorState'

function formatSpeed(bps: number | string | null) {
  if (!bps) return '—'
  const n = Number(bps)
  if (n >= 1_000_000_000) return `${n / 1_000_000_000}G`
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  if (n >= 1_000) return `${n / 1_000}K`
  return `${n}`
}

function formatBytes(bytes: number | string | null) {
  if (!bytes) return '—'
  const gb = Number(bytes) / 1_073_741_824
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = Number(bytes) / 1_048_576
  return `${mb.toFixed(0)} MB`
}

function MemBar({ used, total }: { used: number | string | null; total: number | string | null }) {
  if (!used || !total) return <span className="text-slate-400 text-sm">—</span>
  const pct = Math.round((Number(used) / Number(total)) * 100)
  const colour = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{formatBytes(used)} / {formatBytes(total)}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function GearIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{title}</p>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text' }: { value: string | number; onChange: (v: string) => void; type?: string }) {
  return (
    <input
      type={type} value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3">
      <p className="text-xs font-medium text-slate-400">{title}</p>
      <p className="text-xs text-slate-300 mt-0.5">{description}</p>
    </div>
  )
}

// ── Neighbors ────────────────────────────────────────────────────────────────

const isSwitch  = (c: string[]) => c.includes('bridge') || c.includes('switch') || c.includes('repeater')
const isRouter  = (c: string[]) => c.includes('router')
const isAP      = (c: string[]) => c.includes('wlanAccessPoint') && !isSwitch(c) && !isRouter(c)
const isPhone   = (c: string[]) => c.includes('telephone')

function nodeColor(caps: string[]): string {
  if (isRouter(caps) && !isSwitch(caps)) return '#2563eb'  // blue  — pure router
  if (isSwitch(caps))                    return '#16a34a'  // green — switch/bridge (may also route)
  if (isAP(caps))                        return '#7c3aed'  // purple
  if (isPhone(caps))                     return '#ea580c'  // orange
  return '#475569'
}

interface TopoNode {
  key:   string
  label: string
  ip:    string | null
  caps:  string[]
  localPort:  string
  remotePort: string | null
  protocol: 'lldp' | 'cdp'
}

// ── Device type icons ─────────────────────────────────────────────────────────

const IconRouter = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="14" width="20" height="6" rx="2"/>
    <path d="M6 14V9a6 6 0 0 1 12 0v5"/>
    <circle cx="12" cy="9" r="1" fill="currentColor" stroke="none"/>
    <line x1="6" y1="17" x2="6" y2="17.01"/><line x1="10" y1="17" x2="10" y2="17.01"/>
  </svg>
)

const IconSwitch = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="8" width="20" height="8" rx="2"/>
    <line x1="6" y1="8" x2="6" y2="4"/><line x1="10" y1="8" x2="10" y2="4"/>
    <line x1="14" y1="8" x2="14" y2="4"/><line x1="18" y1="8" x2="18" y2="4"/>
    <line x1="6" y1="16" x2="6" y2="20"/><line x1="18" y1="16" x2="18" y2="20"/>
    <circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="12" r="1" fill="currentColor" stroke="none"/>
    <circle cx="14" cy="12" r="1" fill="currentColor" stroke="none"/>
    <circle cx="18" cy="12" r="1" fill="currentColor" stroke="none"/>
  </svg>
)

const IconAP = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
    <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
    <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>
  </svg>
)

const IconPhone = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
  </svg>
)

const IconUnknown = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
    <circle cx="12" cy="17" r="0.5" fill="currentColor"/>
  </svg>
)

function DeviceIcon({ caps }: { caps: string[] }) {
  if (isRouter(caps) && !isSwitch(caps)) return <IconRouter />
  if (isSwitch(caps)) return <IconSwitch />
  if (isAP(caps))     return <IconAP />
  if (isPhone(caps))  return <IconPhone />
  return <IconUnknown />
}

// MAC address pattern — used to avoid showing raw MACs as device names
const isMacAddr = (s: string) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(s)

// ── React Flow custom nodes ───────────────────────────────────────────────────

const centerHandle: React.CSSProperties = {
  opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1,
  top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
}

function CenterNode({ data }: NodeProps) {
  return (
    <div className="rounded-2xl bg-slate-800 border-2 border-slate-500 px-5 py-4 shadow-xl w-40 text-center">
      <Handle type="source" position={Position.Right} style={centerHandle} />
      <div className="flex justify-center mb-2 text-slate-300"><IconSwitch /></div>
      <div className="text-xs font-bold text-white truncate">{data.label as string}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">this device</div>
    </div>
  )
}

function NeighborNode({ data }: NodeProps) {
  const n = data as unknown as TopoNode
  const color = nodeColor(n.caps)
  // Use a friendly label — don't show raw MAC addresses as the name
  const displayLabel = (!n.label || isMacAddr(n.label)) ? 'Unknown Device' : n.label
  const showMac      = isMacAddr(n.label) ? n.label : null

  return (
    <div className="rounded-2xl bg-white border-2 shadow-md w-44 text-center"
      style={{ borderColor: color }}>
      <Handle type="target" position={Position.Left} style={centerHandle} />
      <div className="px-4 pt-4 pb-3">
        <div className="flex justify-center mb-2" style={{ color }}><DeviceIcon caps={n.caps} /></div>
        <div className="text-xs font-semibold text-slate-800 truncate">{displayLabel}</div>
        {showMac && <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">{showMac}</div>}
        {n.ip && !showMac && <div className="text-[10px] text-slate-400 font-mono mt-0.5">{n.ip}</div>}
      </div>
      <div className="border-t px-4 py-1.5 flex items-center justify-between"
        style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}>
        <span className="text-[10px] font-medium" style={{ color }}>
          {isRouter(n.caps) && !isSwitch(n.caps) ? 'Router' : isSwitch(n.caps) ? 'Switch' : isAP(n.caps) ? 'Access Point' : isPhone(n.caps) ? 'Phone' : 'Unknown'}
        </span>
        <span className="text-[9px] text-slate-400 font-mono">{n.protocol.toUpperCase()}</span>
      </div>
    </div>
  )
}

const NODE_TYPES = { center: CenterNode, neighbor: NeighborNode }

// ── Topology map ──────────────────────────────────────────────────────────────

function NeighborMap({ deviceName, nodes: topoNodes }: { deviceName: string; nodes: TopoNode[] }) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [hideProtocol, setHideProtocol] = useState<Set<string>>(new Set())
  const [hideCaps, setHideCaps] = useState<Set<string>>(new Set())

  const toggleKey    = (k: string) => setHiddenKeys(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const toggleProto  = (p: string) => setHideProtocol(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })
  const toggleCapCat = (c: string) => setHideCaps(s => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n })

  const capCategory = (caps: string[]) =>
    isRouter(caps) && !isSwitch(caps) ? 'router' : isSwitch(caps) ? 'switch' : isAP(caps) ? 'ap' : 'other'

  const isVisible = (n: TopoNode) =>
    !hiddenKeys.has(n.key) &&
    !hideProtocol.has(n.protocol) &&
    !hideCaps.has(capCategory(n.caps))

  // Radial layout — enough spacing between nodes
  const radius = Math.max(280, (topoNodes.length * 130) / (2 * Math.PI))

  const rfNodes: Node[] = useMemo(() => [
    { id: '__center__', type: 'center', position: { x: 0, y: 0 }, data: { label: deviceName }, draggable: true },
    ...topoNodes.map((n, i) => {
      const angle = (i / topoNodes.length) * 2 * Math.PI - Math.PI / 2
      return {
        id: n.key,
        type: 'neighbor',
        position: { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) },
        data: n as unknown as Record<string, unknown>,
        hidden: !isVisible(n),
        draggable: true,
      }
    }),
  ], [topoNodes, deviceName, hiddenKeys, hideProtocol, hideCaps])

  const rfEdges: Edge[] = useMemo(() => topoNodes.map(n => ({
    id: `e-${n.key}`,
    source: '__center__',
    target: n.key,
    type: 'straight',
    label: n.remotePort ? `${n.localPort} → ${n.remotePort}` : n.localPort,
    labelStyle: { fontSize: 10, fill: '#64748b' },
    labelBgStyle: { fill: 'white', fillOpacity: 0.85 },
    labelBgPadding: [4, 3] as [number, number],
    style: { stroke: '#94a3b8', strokeWidth: 1.5 },
    hidden: !isVisible(n),
  })), [topoNodes, hiddenKeys, hideProtocol, hideCaps])

  if (topoNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        No neighbor data yet — waiting for a poll cycle.
      </div>
    )
  }

  const capGroups = [
    { key: 'router', label: 'Router', color: '#2563eb' },
    { key: 'switch', label: 'Switch', color: '#16a34a' },
    { key: 'ap',     label: 'AP',     color: '#7c3aed' },
    { key: 'other',  label: 'Other',  color: '#475569' },
  ].filter(g => topoNodes.some(n => capCategory(n.caps) === g.key))

  return (
    <div className="flex gap-3">
      {/* Sidebar controls */}
      <div className="w-44 shrink-0 space-y-4 text-xs">
        <div>
          <p className="font-semibold text-slate-500 uppercase tracking-wide mb-2">Protocol</p>
          {(['lldp', 'cdp'] as const).filter(p => topoNodes.some(n => n.protocol === p)).map(p => (
            <label key={p} className="flex items-center gap-2 py-1 cursor-pointer select-none">
              <input type="checkbox" checked={!hideProtocol.has(p)} onChange={() => toggleProto(p)}
                className="rounded border-slate-300 text-blue-600" />
              <span className={`font-medium ${hideProtocol.has(p) ? 'text-slate-300' : 'text-slate-600'}`}>
                {p.toUpperCase()}
              </span>
            </label>
          ))}
        </div>

        <div>
          <p className="font-semibold text-slate-500 uppercase tracking-wide mb-2">Type</p>
          {capGroups.map(g => (
            <label key={g.key} className="flex items-center gap-2 py-1 cursor-pointer select-none">
              <input type="checkbox" checked={!hideCaps.has(g.key)} onChange={() => toggleCapCat(g.key)}
                className="rounded border-slate-300" />
              <span className="flex items-center gap-1.5" style={{ opacity: hideCaps.has(g.key) ? 0.3 : 1 }}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: g.color }} />
                <span className="text-slate-600">{g.label}</span>
              </span>
            </label>
          ))}
        </div>

        <div>
          <p className="font-semibold text-slate-500 uppercase tracking-wide mb-2">Nodes</p>
          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {topoNodes.map(n => (
              <label key={n.key} className="flex items-center gap-2 py-0.5 cursor-pointer select-none">
                <input type="checkbox" checked={!hiddenKeys.has(n.key)} onChange={() => toggleKey(n.key)}
                  className="rounded border-slate-300 text-blue-600 shrink-0" />
                <span className={`truncate ${hiddenKeys.has(n.key) ? 'text-slate-300' : 'text-slate-600'}`}>
                  {n.label}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 rounded-xl border border-slate-200 overflow-hidden" style={{ height: 640 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Controls />
          <MiniMap nodeStrokeWidth={2} nodeColor={n => n.type === 'center' ? '#1e293b' : '#e2e8f0'} pannable zoomable />
          <Background color="#f1f5f9" gap={24} />
        </ReactFlow>
      </div>
    </div>
  )
}

function NeighborsSection({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const [view, setView] = useState<'list' | 'map'>('list')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['neighbors', deviceId],
    queryFn: () => fetchDeviceNeighbors(deviceId),
    staleTime: 60_000,
  })

  const lldp = data?.lldp ?? []
  const cdp  = data?.cdp  ?? []

  const { data: ospfData = [] } = useQuery({
    queryKey: ['ospf', deviceId],
    queryFn: () => fetchDeviceOSPF(deviceId),
    staleTime: 30_000,
  })

  const { data: bgpSessions = [] } = useQuery({
    queryKey: ['bgp-sessions', deviceId],
    queryFn:  () => fetchDeviceBGPSessions(deviceId),
    staleTime: 30_000,
  })

  const total = lldp.length + cdp.length + ospfData.length + bgpSessions.length

  // Merged node list for the map — deduplicate by remote name
  const topoNodes: TopoNode[] = [
    ...lldp.map(n => ({
      key:        n.remote_system_name || n.remote_chassis_id || n.local_port,
      label:      n.remote_system_name || n.remote_chassis_id || '',
      ip:         n.remote_mgmt_ip,
      caps:       n.capabilities,
      localPort:  n.local_port,
      remotePort: n.remote_port,
      protocol:   'lldp' as const,
    })),
    ...cdp
      .filter(n => !lldp.some(l => l.remote_system_name === n.remote_device))
      .map(n => ({
        key:        n.remote_device || n.local_port,
        label:      n.remote_device || '?',
        ip:         n.remote_mgmt_ip,
        caps:       n.capabilities,
        localPort:  n.local_port,
        remotePort: n.remote_port,
        protocol:   'cdp' as const,
      })),
  ]

  if (isLoading) return <p className="text-xs text-slate-400 p-4">Loading…</p>

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex items-center justify-between border-b border-slate-100 px-1 mb-3">
        <div className="flex">
          {(['list', 'map'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize ${
                view === v ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {v === 'list' ? `List${total ? ` (${total})` : ''}` : 'Map'}
            </button>
          ))}
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50 pr-1">
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {view === 'list' && (
        <div className="space-y-3">
          {total === 0 && <p className="text-xs text-slate-400">No neighbors discovered yet.</p>}

          {lldp.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">LLDP</p>
              <div className="space-y-1.5">
                {lldp.map((n, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-500 shrink-0">{n.local_port}</span>
                      <span className="text-slate-300">→</span>
                      <span className="font-medium text-slate-700 truncate">{n.remote_system_name || n.remote_chassis_id || '—'}</span>
                      {n.remote_port && <span className="font-mono text-slate-400 shrink-0">{n.remote_port}</span>}
                    </div>
                    {(n.remote_mgmt_ip || n.capabilities.length > 0) && (
                      <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                        {n.remote_mgmt_ip && <span>{n.remote_mgmt_ip}</span>}
                        {n.capabilities.map(c => (
                          <span key={c} className="px-1 bg-slate-100 rounded text-slate-500">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {cdp.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">CDP</p>
              <div className="space-y-1.5">
                {cdp.map((n, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-500 shrink-0">{n.local_port}</span>
                      <span className="text-slate-300">→</span>
                      <span className="font-medium text-slate-700 truncate">{n.remote_device || '—'}</span>
                      {n.remote_port && <span className="font-mono text-slate-400 shrink-0">{n.remote_port}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                      {n.remote_mgmt_ip && <span>{n.remote_mgmt_ip}</span>}
                      {n.platform && <span className="italic">{n.platform}</span>}
                      {n.duplex && <span>{n.duplex} duplex</span>}
                      {n.native_vlan != null && n.native_vlan > 0 && <span>vlan {n.native_vlan}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {ospfData.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">OSPF</p>
              <div className="space-y-1.5">
                {ospfData.map((n, i) => {
                  const isFull = n.state === 'full'
                  return (
                    <div key={i} className={`rounded-lg border px-3 py-2 text-xs ${isFull ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`font-semibold px-1.5 py-0.5 rounded text-white text-[10px] ${isFull ? 'bg-green-600' : 'bg-amber-500'}`}>
                          {n.state.toUpperCase().replace('_', '-')}
                        </span>
                        <span className="font-mono text-slate-700 truncate">{n.neighbor_ip ?? n.router_id ?? '—'}</span>
                        {n.display_name && <span className="text-slate-500 shrink-0">{n.display_name}</span>}
                        {!n.display_name && n.router_id && n.router_id !== n.neighbor_ip && (
                          <span className="font-mono text-slate-400 shrink-0">{n.router_id}</span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                        {n.area && <span>area {n.area}</span>}
                        {n.interface_name && <span>{n.interface_name}</span>}
                        {n.last_state_change && <span>changed {new Date(n.last_state_change).toLocaleString()}</span>}
                        {n.inferred && <span className="text-slate-300 italic">seen from peer</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {bgpSessions.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">BGP</p>
              <div className="space-y-1.5">
                {bgpSessions.map(s => {
                  const isUp = s.session_state === 'established'
                  return (
                    <div key={s.id} className={`rounded-lg border px-3 py-2 text-xs ${isUp ? 'border-green-200 bg-green-50' : 'border-slate-200'}`}>
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: s.state_color }} />
                        <span className="font-medium capitalize" style={{ color: s.state_color }}>{s.session_state}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${s.session_type === 'iBGP' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {s.session_type}
                        </span>
                        <span className="font-mono text-slate-700">{s.peer_ip}</span>
                        {s.peer_asn && <span className="text-slate-400">AS{s.peer_asn}</span>}
                        {s.peer_router_id && s.peer_router_id !== s.peer_ip && (
                          <span className="font-mono text-slate-400 text-[10px]">{s.peer_router_id}</span>
                        )}
                      </div>
                      {isUp && (
                        <div className="mt-1 flex flex-wrap gap-2 text-slate-400">
                          {s.uptime_seconds != null && s.uptime_seconds > 0 && <span>up {fmtUptime(s.uptime_seconds)}</span>}
                          {s.prefixes_received != null && <span>{s.prefixes_received} pfx rx</span>}
                          {s.flap_count > 1 && <span className="text-amber-500">{s.flap_count} flaps</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'map' && (
        <NeighborMap deviceName={deviceName} nodes={topoNodes} />
      )}
    </div>
  )
}

// ── Routes ────────────────────────────────────────────────────────────────────

const PROTO_STYLE: Record<string, string> = {
  connected: 'bg-green-100 text-green-700',
  static:    'bg-yellow-100 text-yellow-700',
  ospf:      'bg-blue-100 text-blue-700',
  bgp:       'bg-purple-100 text-purple-700',
  isis:      'bg-orange-100 text-orange-700',
  rip:       'bg-pink-100 text-pink-700',
  eigrp:     'bg-cyan-100 text-cyan-700',
  other:     'bg-slate-100 text-slate-500',
}

const PROTO_LABEL: Record<string, string> = {
  connected: 'Connected', static: 'Static', ospf: 'OSPF',
  bgp: 'BGP', isis: 'IS-IS', rip: 'RIP', eigrp: 'EIGRP', other: 'Other',
}

function RoutesSection({ deviceId }: { deviceId: string }) {
  const [protoFilter, setProto] = useState<string>('all')

  const { data: allRoutes = [], isLoading } = useQuery({
    queryKey: ['routes', deviceId],
    queryFn:  () => fetchDeviceRoutes(deviceId, undefined),
    staleTime: 30_000,
  })

  // Derive which protocols actually have routes
  const presentProtos = Array.from(new Set(allRoutes.map(r => r.protocol))).sort()
  const protocols = ['all', ...presentProtos]

  const routes = protoFilter === 'all'
    ? allRoutes
    : allRoutes.filter(r => r.protocol === protoFilter)

  return (
    <div className="space-y-3">
      {/* Protocol filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {protocols.map(p => (
          <button key={p} onClick={() => setProto(p)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
              protoFilter === p
                ? 'bg-slate-800 text-white border-slate-800'
                : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
            }`}>
            {p === 'all' ? 'All' : (PROTO_LABEL[p] ?? p.toUpperCase())}
          </button>
        ))}
        {routes.length > 0 && (
          <span className="text-xs text-slate-400 ml-1">{routes.length} route{routes.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : routes.length === 0 ? (
        <p className="text-xs text-slate-400">
          {protoFilter === 'all' ? 'No route data yet — waiting for a poll cycle.' : `No ${protoFilter} routes.`}
        </p>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200" style={{ maxHeight: 480 }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">Protocol</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Destination</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Next Hop</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Interface</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-16">Metric</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {routes.map((r, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${PROTO_STYLE[r.protocol] ?? PROTO_STYLE.other}`}>
                      {r.protocol}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono font-medium text-slate-700">{r.destination}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">{r.next_hop ?? <span className="text-slate-300 not-italic">direct</span>}</td>
                  <td className="px-3 py-2 text-slate-500">{r.interface_name ?? <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-slate-400">{r.metric ?? <span className="text-slate-300">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── VLANs ─────────────────────────────────────────────────────────────────────

function VLANsSection({ deviceId }: { deviceId: string }) {
  const { data: vlans = [], isLoading } = useQuery({
    queryKey: ['vlans', deviceId],
    queryFn: () => fetchDeviceVlans(deviceId),
    staleTime: 30_000,
  })

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : vlans.length === 0 ? (
        <p className="text-xs text-slate-400">No VLAN data — device may not support Q-BRIDGE-MIB</p>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200" style={{ maxHeight: 480 }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">VLAN ID</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Name</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Tagged Ports</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Untagged Ports</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {vlans.map((v: VlanEntry) => {
                const tagged   = v.ports.filter(p => p.tagged).map(p => p.interface)
                const untagged = v.ports.filter(p => !p.tagged).map(p => p.interface)
                return (
                  <tr key={v.vlan_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600">
                        {v.vlan_id}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{v.name ?? <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-slate-500">{tagged.length > 0 ? tagged.join(', ') : <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 text-slate-500">{untagged.length > 0 ? untagged.join(', ') : <span className="text-slate-300">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── STP ───────────────────────────────────────────────────────────────────────

const STP_STATE_STYLE: Record<string, string> = {
  forwarding: 'bg-green-100 text-green-700',
  blocking:   'bg-amber-100 text-amber-700',
  listening:  'bg-amber-100 text-amber-700',
  learning:   'bg-amber-100 text-amber-700',
  disabled:   'bg-slate-100 text-slate-500',
}

const STP_ROLE_STYLE: Record<string, string> = {
  root:        'bg-blue-100 text-blue-700',
  designated:  'bg-green-100 text-green-700',
  alternate:   'bg-amber-100 text-amber-700',
  backup:      'bg-amber-100 text-amber-700',
  unknown:     'bg-slate-100 text-slate-500',
}

function STPSection({ deviceId }: { deviceId: string }) {
  const { data: ports = [], isLoading } = useQuery({
    queryKey: ['stp', deviceId],
    queryFn: () => fetchDeviceStp(deviceId),
    staleTime: 30_000,
  })

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : ports.length === 0 ? (
        <p className="text-xs text-slate-400">No STP data — device may not support BRIDGE-MIB</p>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200" style={{ maxHeight: 480 }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Interface</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">State</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ports.map((p: StpPort, i: number) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-700">{p.interface}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${STP_STATE_STYLE[p.state] ?? STP_STATE_STYLE.disabled}`}>
                      {p.state}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${STP_ROLE_STYLE[p.role] ?? STP_ROLE_STYLE.unknown}`}>
                      {p.role}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Address table ─────────────────────────────────────────────────────────────

function AddressesSection({ deviceId }: { deviceId: string }) {
  const [search, setSearch]     = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'arp' | 'mac'>('all')
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => setDebouncedSearch(v), 300)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['addresses', deviceId, debouncedSearch, typeFilter],
    queryFn: () => fetchDeviceAddresses(deviceId, {
      search: debouncedSearch || undefined,
      type: typeFilter === 'all' ? undefined : typeFilter,
      limit: 500,
    }),
    staleTime: 60_000,
  })

  const items = data?.items ?? []

  const typeBadge = (e: AddressEntry) => (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white ${
      e.type === 'arp' ? 'bg-cyan-600' : 'bg-violet-600'
    }`}>{e.type.toUpperCase()}</span>
  )

  return (
    <div className="flex flex-col h-full space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search MAC or IP…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          {(['all', 'arp', 'mac'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 transition-colors ${
                typeFilter === t ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-50'
              }`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        {data && <span className="text-xs text-slate-400 shrink-0">{data.total} entries</span>}
      </div>

      {/* Table */}
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-400">
          {debouncedSearch ? 'No matches.' : 'No address data yet — waiting for a poll cycle.'}
        </p>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200" style={{ maxHeight: 520 }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-12">Type</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">MAC</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">IP</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Port</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-16">VLAN</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((e, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-3 py-2">{typeBadge(e)}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">{e.mac}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">{e.ip ?? <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {e.port
                      ? e.port_iface_id
                        ? <Link to={`/devices/${deviceId}/interfaces/${e.port_iface_id}`} className="font-mono text-blue-600 hover:underline">{e.port}</Link>
                        : <span className="font-mono">{e.port}</span>
                      : <span className="text-slate-300">—</span>}
                    {e.vlan_interface && (
                      <span className="ml-1.5 text-[10px] text-slate-400 font-mono">({e.vlan_interface})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{e.vlan ?? <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-slate-400">{e.entry_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Credential assignment ─────────────────────────────────────────────────────

const CRED_TYPE_LABEL: Record<string, string> = {
  snmp_v2c: 'SNMP v2c', snmp_v3: 'SNMP v3', ssh: 'SSH',
  gnmi_tls: 'gNMI TLS', api_token: 'API Token', netconf: 'NETCONF',
}

function CredentialSection({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const canOperate = hasRole(useRole(), 'operator')
  const [selectedId, setSelectedId] = useState('')
  const [priority, setPriority]     = useState('0')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [errMsg, setErrMsg]         = useState('')

  const { data: assigned = [], isLoading } = useQuery({
    queryKey: ['device-creds', deviceId],
    queryFn: () => fetchDeviceCredentials(deviceId),
  })
  const { data: all = [] } = useQuery({
    queryKey: ['credentials-all'],
    queryFn: () => fetchCredentials(true),
  })

  const unassignedIds = new Set(assigned.map(a => a.credential_id))
  const available = all.filter(c => !unassignedIds.has(c.id))

  const linkMut = useMutation({
    mutationFn: () => linkDeviceCredential(deviceId, selectedId, Number(priority)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['device-creds', deviceId] }); setSelectedId(''); setErrMsg('') },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Failed to assign'),
  })

  const unlinkMut = useMutation({
    mutationFn: (credId: string) => unlinkDeviceCredential(deviceId, credId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['device-creds', deviceId] }); setConfirmDel(null) },
  })

  if (isLoading) return <p className="text-xs text-slate-400">Loading…</p>

  return (
    <div className="space-y-2">
      {assigned.length === 0 && <p className="text-xs text-slate-400">No credentials assigned.</p>}
      {assigned.map(a => (
        <div key={a.credential_id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs">
          <div>
            <span className="font-medium text-slate-700">{a.name}</span>
            <span className="ml-2 text-slate-400">{CRED_TYPE_LABEL[a.type] ?? a.type}</span>
            <span className="ml-2 text-slate-300">priority {a.priority}</span>
          </div>
          {canOperate && (confirmDel === a.credential_id ? (
            <div className="flex items-center gap-2">
              <button onClick={() => unlinkMut.mutate(a.credential_id)} className="text-red-600 hover:underline">Remove</button>
              <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:underline">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDel(a.credential_id)} aria-label="Remove credential" className="text-slate-400 hover:text-red-500">✕</button>
          ))}
        </div>
      ))}

      {canOperate && available.length > 0 && (
        <div className="flex gap-2 pt-1">
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Assign credential…</option>
            {available.map(c => <option key={c.id} value={c.id}>{c.name} ({CRED_TYPE_LABEL[c.type] ?? c.type})</option>)}
          </select>
          <input type="number" value={priority} onChange={e => setPriority(e.target.value)}
            placeholder="Pri" className="w-14 border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={() => linkMut.mutate()} disabled={!selectedId || linkMut.isPending}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            Assign
          </button>
        </div>
      )}
      {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
    </div>
  )
}

// ── SNMP engine ID badge + discover ────────────────────────────────────────────

function EngineIdBadge({ deviceId, engineId: initialEngineId, remoteCollector }: {
  deviceId: string
  engineId: string | null
  remoteCollector: boolean
}) {
  const queryClient = useQueryClient()
  const [engineId, setEngineId] = useState(initialEngineId)

  const mutation = useMutation({
    mutationFn: () => discoverSnmpEngineId(deviceId),
    onSuccess: (data) => {
      setEngineId(data.engine_id)
      queryClient.invalidateQueries({ queryKey: ['device', deviceId] })
    },
  })

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-slate-500 font-medium">Engine ID</span>
      {engineId ? (
        <span className="font-mono text-slate-400">{engineId}</span>
      ) : (
        <span className="text-amber-500">not set</span>
      )}
      {remoteCollector && !engineId && (
        <span className="text-slate-400 text-[10px]">auto-discovers on next poll</span>
      )}
      {!remoteCollector && (
        <>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? 'Discovering…' : engineId ? 'Re-discover' : 'Discover'}
          </button>
          {mutation.isError && (
            <span className="text-amber-400 text-[10px]" title={(mutation.error as any)?.response?.data?.detail ?? 'Discovery failed'}>
              failed — check SSH creds
            </span>
          )}
        </>
      )}
    </span>
  )
}

// ── SNMP diagnostic ────────────────────────────────────────────────────────────

function SnmpDiagSection({ deviceId }: { deviceId: string }) {
  const [result, setResult]   = useState<Awaited<ReturnType<typeof runSnmpDiag>> | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState('')

  async function run() {
    setRunning(true); setResult(null); setError('')
    try {
      const r = await runSnmpDiag(deviceId)
      setResult(r)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Request failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={run} disabled={running}
        className="w-full border border-slate-300 text-slate-600 text-sm rounded-lg py-2 hover:bg-slate-50 disabled:opacity-50 transition-colors">
        {running ? 'Running…' : 'Run SNMP diagnostic'}
      </button>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && (
        <div className={`rounded-lg border p-3 text-xs space-y-2 ${result.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center justify-between">
            <span className={`font-semibold ${result.success ? 'text-green-700' : 'text-red-700'}`}>
              {result.success ? 'Reachable' : 'Failed'}
            </span>
            <span className="text-slate-400">
              {result.credential_name} · {CRED_TYPE_LABEL[result.credential_type] ?? result.credential_type}
              {result.response_ms != null && ` · ${result.response_ms}ms`}
            </span>
          </div>
          {result.error && <p className="text-red-600">{result.error}</p>}
          {result.results.map(r => (
            <div key={r.oid} className="flex gap-3">
              <span className="text-slate-500 w-24 shrink-0">{r.oid}</span>
              <span className="text-slate-700 break-all">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Maintenance windows ────────────────────────────────────────────────────────

function MaintenanceBadge({ deviceId }: { deviceId: string }) {
  const { data: windows = [] } = useQuery({
    queryKey: ['maintenance', deviceId],
    queryFn: () => fetchMaintenanceWindows({ device_id: deviceId }),
  })
  if (!windows.some(w => w.is_active)) return null
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      In maintenance
    </span>
  )
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function MaintenanceSection({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const canOperate = hasRole(useRole(), 'operator')
  const [showForm, setShowForm]     = useState(false)
  const [name, setName]             = useState('')
  const [startsAt, setStartsAt]     = useState('')
  const [endsAt, setEndsAt]         = useState('')
  const [isRecurring, setIsRecurring] = useState(false)
  const [cron, setCron]             = useState('0 2 * * 6')
  const [errMsg, setErrMsg]         = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const { data: windows = [], isLoading } = useQuery({
    queryKey: ['maintenance', deviceId],
    queryFn: () => fetchMaintenanceWindows({ device_id: deviceId }),
  })

  const createMut = useMutation({
    mutationFn: () => createMaintenanceWindow({
      name,
      device_selector: { device_ids: [deviceId] },
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(endsAt).toISOString(),
      is_recurring: isRecurring,
      recurrence_cron: isRecurring ? cron : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance', deviceId] })
      setShowForm(false); setName(''); setStartsAt(''); setEndsAt(''); setErrMsg('')
    },
    onError: (e: any) => setErrMsg(e?.response?.data?.detail ?? 'Failed to create window'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMaintenanceWindow(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance', deviceId] }); setConfirmDel(null) },
  })

  if (isLoading) return <p className="text-xs text-slate-400">Loading…</p>

  return (
    <div className="space-y-3">
      {windows.length === 0 && !showForm && (
        <p className="text-xs text-slate-400">No maintenance windows scheduled.</p>
      )}

      {windows.map(w => (
        <div key={w.id} className={`rounded-lg border px-3 py-2 text-xs space-y-0.5 ${w.is_active ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">{w.name}</span>
            <div className="flex items-center gap-2">
              {w.is_active && (
                <span className="px-1.5 py-0.5 bg-amber-200 text-amber-800 rounded text-xs font-medium">Active</span>
              )}
              {w.is_recurring && (
                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">Recurring</span>
              )}
              {canOperate && (confirmDel === w.id ? (
                <>
                  <button onClick={() => deleteMut.mutate(w.id)} className="text-red-600 hover:underline">Confirm</button>
                  <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:underline">Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirmDel(w.id)} className="text-slate-400 hover:text-red-600">Delete</button>
              ))}
            </div>
          </div>
          {w.is_recurring
            ? <p className="text-slate-400">Cron: <code>{w.recurrence_cron}</code> · duration {Math.round((new Date(w.ends_at).getTime() - new Date(w.starts_at).getTime()) / 60000)} min</p>
            : <p className="text-slate-400">{fmt(w.starts_at)} → {fmt(w.ends_at)}</p>
          }
        </div>
      ))}

      {showForm ? (
        <div className="rounded-lg border border-slate-200 p-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Scheduled maintenance"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Start</label>
              <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">End</label>
              <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)}
              className="rounded border-slate-300 text-blue-600" />
            Recurring
          </label>
          {isRecurring && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cron expression</label>
              <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 2 * * 6"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">Standard 5-field cron. Start/end define the duration per occurrence.</p>
            </div>
          )}
          {errMsg && <p className="text-xs text-red-600">{errMsg}</p>}
          <div className="flex gap-2">
            <button onClick={() => createMut.mutate()} disabled={!name || !startsAt || !endsAt || createMut.isPending}
              className="flex-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {createMut.isPending ? 'Saving…' : 'Schedule'}
            </button>
            <button onClick={() => { setShowForm(false); setErrMsg('') }}
              className="flex-1 text-sm text-slate-500 border border-slate-200 rounded-lg py-2 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      ) : canOperate ? (
        <button onClick={() => setShowForm(true)}
          className="w-full mt-1 border border-slate-300 text-slate-600 text-sm rounded-lg py-2 hover:bg-slate-50 transition-colors">
          + Schedule downtime
        </button>
      ) : null}
    </div>
  )
}

// ── Health tab ─────────────────────────────────────────────────────────────────

const HEALTH_RANGES = [
  { label: '1h',  hours: 1   },
  { label: '6h',  hours: 6   },
  { label: '24h', hours: 24  },
  { label: '7d',  hours: 168 },
  { label: '30d', hours: 720 },
]

function fmtPct(v: number)  { return `${v.toFixed(1)}%` }
function fmtTemp(v: number) { return `${v.toFixed(1)}°C` }
function fmtBytes(b: number) {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  return `${(b / 1_048_576).toFixed(0)} MB`
}

function HealthTab({ deviceId, currentHealth }: { deviceId: string; currentHealth: any }) {
  const [hours, setHours] = useState(1)

  const { data: hist, isLoading } = useQuery({
    queryKey:        ['device-health-history', deviceId, hours],
    queryFn:         () => fetchDeviceHealthHistory(deviceId, hours),
    staleTime:       30_000,
    refetchInterval: 60_000,
  })

  // Baseline stats for CPU and memory (rolling, device-level)
  const { data: blData } = useQuery({
    queryKey:  ['device-baselines', deviceId],
    queryFn:   () => fetchDeviceBaselines(deviceId),
    staleTime: 5 * 60_000,
  })
  const cpuBl  = blData?.baselines?.['cpu_util_pct']?.find(r => r.bucket_type === 'rolling') ?? null
  const memBl  = blData?.baselines?.['mem_util_pct']?.find(r => r.bucket_type === 'rolling') ?? null

  const { data: latency } = useQuery({
    queryKey:        ['device-latency', deviceId, hours],
    queryFn:         () => fetchDeviceLatency(deviceId, hours),
    staleTime:       30_000,
    refetchInterval: 60_000,
  })

  const temps: { sensor: string; celsius: number; ok: boolean }[] = currentHealth?.temperatures ?? []
  const domTemps    = temps.filter(t => t.sensor.toLowerCase().includes('dom'))
  const systemTemps = temps.filter(t => !t.sensor.toLowerCase().includes('dom'))

  const cpuNow = currentHealth?.cpu_util_pct != null ? Number(currentHealth.cpu_util_pct) : null
  const memNow = currentHealth?.mem_util_pct != null ? Number(currentHealth.mem_util_pct) : null
  const memUsed  = currentHealth?.mem_used_bytes
  const memTotal = currentHealth?.mem_total_bytes

  return (
    <div className="p-5 space-y-5">
      {/* Time range */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">Historical data from VictoriaMetrics</p>
        <div className="flex rounded-lg overflow-hidden border border-slate-200">
          {HEALTH_RANGES.map(r => (
            <button key={r.hours} onClick={() => setHours(r.hours)}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                hours === r.hours ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
              } ${r.hours !== 1 ? 'border-l border-slate-200' : ''}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* CPU */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>
                <path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">CPU Utilisation</p>
              {cpuNow != null && (
                <p className="text-xs text-slate-400">
                  Current: <span className="font-semibold" style={{ color: cpuNow > 90 ? '#dc2626' : cpuNow > 70 ? '#f59e0b' : '#16a34a' }}>
                    {cpuNow.toFixed(1)}%
                  </span>
                </p>
              )}
            </div>
          </div>
          {cpuNow != null && (
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-800">{cpuNow.toFixed(1)}%</p>
              <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1">
                <div className="h-full rounded-full"
                  style={{ width: `${Math.min(cpuNow, 100)}%`, backgroundColor: cpuNow > 90 ? '#dc2626' : cpuNow > 70 ? '#f59e0b' : '#7c3aed' }} />
              </div>
            </div>
          )}
        </div>
        <div className="px-4 pt-3 pb-2 bg-white">
          {isLoading ? (
            <div className="h-44 flex items-center justify-center text-slate-300 text-sm">Loading…</div>
          ) : (
            <TimeSeriesChart height={160} yFmt={fmtPct}
              series={[{ name: 'CPU', color: '#7c3aed', data: (hist?.cpu_pct ?? []) as [number,number][] }]} />
          )}
          {cpuBl && cpuBl.mean != null && (
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
              <span className="inline-block w-2 h-2 rounded-full bg-violet-200 shrink-0" />
              <span>
                14d baseline: <span className="font-medium text-slate-500">{cpuBl.mean.toFixed(1)}%</span> avg
                {cpuBl.stddev != null && cpuBl.stddev > 0 && (
                  <> · alert floor <span className="font-medium text-slate-500">{Math.min(100, cpuBl.mean + 3 * cpuBl.stddev).toFixed(1)}%</span> (mean + 3σ)</>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Memory */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M4 7h16M4 7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M9 11h.01M12 11h.01M15 11h.01"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">Memory</p>
              {memUsed && memTotal && (
                <p className="text-xs text-slate-400">
                  {fmtBytes(memUsed)} / {fmtBytes(memTotal)}
                  {memNow != null && <span className="ml-1 font-semibold text-blue-600">{memNow.toFixed(1)}%</span>}
                </p>
              )}
            </div>
          </div>
          {memNow != null && (
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-800">{memNow.toFixed(1)}%</p>
              <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1">
                <div className="h-full rounded-full bg-blue-500"
                  style={{ width: `${Math.min(memNow, 100)}%` }} />
              </div>
            </div>
          )}
        </div>
        <div className="px-4 pt-3 pb-2 bg-white">
          {isLoading ? (
            <div className="h-44 flex items-center justify-center text-slate-300 text-sm">Loading…</div>
          ) : (
            <TimeSeriesChart height={160} yFmt={fmtPct}
              series={[{ name: 'Memory', color: '#2563eb', data: (hist?.mem_pct ?? []) as [number,number][] }]} />
          )}
          {memBl && memBl.mean != null && (
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-200 shrink-0" />
              <span>
                14d baseline: <span className="font-medium text-slate-500">{memBl.mean.toFixed(1)}%</span> avg
                {memBl.stddev != null && memBl.stddev > 0 && (
                  <> · alert floor <span className="font-medium text-slate-500">{Math.min(100, memBl.mean + 3 * memBl.stddev).toFixed(1)}%</span> (mean + 3σ)</>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Uptime */}
      {currentHealth?.uptime_seconds != null && (
        <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex items-center gap-4">
          <div className="w-8 h-8 rounded-xl bg-green-100 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div>
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Uptime</p>
            <p className="text-lg font-bold text-slate-800">{formatUptime(currentHealth.uptime_seconds)}</p>
          </div>
          <div className="ml-auto text-xs text-slate-400">
            Last polled {currentHealth.collected_at ? formatAge(new Date(currentHealth.collected_at).toISOString()) : '—'}
          </div>
        </div>
      )}

      {/* System temperature sensors */}
      {systemTemps.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">System Temperature Sensors</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {systemTemps.map((t, i) => (
              <div key={i} className={`rounded-xl border px-4 py-3 ${t.ok ? 'bg-white border-slate-200' : 'bg-red-50 border-red-200'}`}>
                <p className="text-[10px] font-medium text-slate-400 truncate mb-1">{t.sensor}</p>
                <p className={`text-xl font-bold ${t.ok ? 'text-slate-800' : 'text-red-600'}`}>{t.celsius}°C</p>
                {hist?.temp_series?.[t.sensor] && hist.temp_series[t.sensor].length >= 2 && (
                  <div className="mt-2">
                    <TimeSeriesChart height={40} yFmt={fmtTemp}
                      series={[{ name: t.sensor, color: t.ok ? '#64748b' : '#dc2626', data: hist.temp_series[t.sensor] as [number,number][] }]} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Optical Transceivers (DOM) */}
      {(() => {
        // dBm signal quality — returns tier info for coloring + labeling
        const NO_LIGHT_SENTINEL = -40
        function domQuality(dbm: number | null): { label: string; color: string; bg: string; bars: number } {
          if (dbm === null || dbm <= NO_LIGHT_SENTINEL)
            return { label: 'No light', color: 'text-slate-300',   bg: 'bg-slate-300',   bars: 0 }
          if (dbm < -30) return { label: 'Critical',  color: 'text-red-600',    bg: 'bg-red-600',    bars: 1 }
          if (dbm < -20) return { label: 'Poor',      color: 'text-orange-500', bg: 'bg-orange-500', bars: 2 }
          if (dbm < -12) return { label: 'Marginal',  color: 'text-yellow-500', bg: 'bg-yellow-500', bars: 3 }
          if (dbm < -5)  return { label: 'Good',      color: 'text-green-600',  bg: 'bg-green-600',  bars: 4 }
          return              { label: 'Strong',     color: 'text-emerald-600', bg: 'bg-emerald-600', bars: 4 }
        }

        // 4-bar signal strength indicator (phone-style)
        function SignalBars({ bars, bg }: { bars: number; bg: string }) {
          const heights = ['h-1.5', 'h-2.5', 'h-3.5', 'h-4.5']
          return (
            <span className="inline-flex items-end gap-[2px]">
              {heights.map((h, i) => (
                <span key={i} className={`w-1 rounded-sm ${h} ${i < bars ? bg : 'bg-slate-200'}`} />
              ))}
            </span>
          )
        }

        const domIfaces = Array.from(new Set([
          ...domTemps.map(t => t.sensor.replace(/DOM Temperature Sensor for /i, '').trim()),
          ...Object.keys(hist?.dom_tx ?? {}),
          ...Object.keys(hist?.dom_rx ?? {}),
          ...Object.keys(hist?.dom_tx_now ?? {}),
          ...Object.keys(hist?.dom_rx_now ?? {}),
        ])).filter(Boolean)

        if (domIfaces.length === 0) return null

        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Optical Transceivers (DOM)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {domIfaces.map(iface => {
                const tempEntry = domTemps.find(t =>
                  t.sensor.replace(/DOM Temperature Sensor for /i, '').trim() === iface
                )
                // Prefer instant-query current value; fall back to last range point
                const txNow = hist?.dom_tx_now?.[iface] ?? hist?.dom_tx?.[iface]?.at(-1)?.[1] ?? null
                const rxNow = hist?.dom_rx_now?.[iface] ?? hist?.dom_rx?.[iface]?.at(-1)?.[1] ?? null
                const txSeries = (hist?.dom_tx?.[iface] ?? []) as [number,number][]
                const rxSeries = (hist?.dom_rx?.[iface] ?? []) as [number,number][]

                const txQ = domQuality(txNow)
                const rxQ = domQuality(rxNow)
                const noLight = txNow !== null && rxNow !== null
                  && txNow <= NO_LIGHT_SENTINEL && rxNow <= NO_LIGHT_SENTINEL

                return (
                  <div key={iface} className={`bg-white rounded-xl border overflow-hidden ${noLight ? 'border-slate-100 opacity-60' : 'border-slate-200'}`}>
                    {/* Header */}
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                      <svg className="w-3.5 h-3.5 text-cyan-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
                      </svg>
                      <span className="text-xs font-semibold text-slate-700">{iface}</span>
                      {noLight && (
                        <span className="ml-auto text-[10px] font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">No light</span>
                      )}
                      {tempEntry && !noLight && (
                        <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${tempEntry.ok ? 'bg-slate-100 text-slate-500' : 'bg-red-100 text-red-600'}`}>
                          {tempEntry.celsius}°C
                        </span>
                      )}
                    </div>

                    <div className="px-4 py-3 space-y-2.5">
                      {/* Tx / Rx power current values */}
                      <div className="grid grid-cols-2 gap-3">
                        {/* Tx */}
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Tx Power</p>
                          {txNow !== null && txNow > NO_LIGHT_SENTINEL ? (
                            <>
                              <p className={`text-base font-bold leading-none ${txQ.color}`}>
                                {txNow.toFixed(2)} <span className="text-[10px] font-normal text-slate-400">dBm</span>
                              </p>
                              <div className="flex items-center gap-1.5 mt-1">
                                <SignalBars bars={txQ.bars} bg={txQ.bg} />
                                <span className={`text-[9px] font-semibold ${txQ.color}`}>{txQ.label}</span>
                              </div>
                            </>
                          ) : (
                            <p className="text-base font-bold text-slate-300">—</p>
                          )}
                        </div>
                        {/* Rx */}
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Rx Power</p>
                          {rxNow !== null && rxNow > NO_LIGHT_SENTINEL ? (
                            <>
                              <p className={`text-base font-bold leading-none ${rxQ.color}`}>
                                {rxNow.toFixed(2)} <span className="text-[10px] font-normal text-slate-400">dBm</span>
                              </p>
                              <div className="flex items-center gap-1.5 mt-1">
                                <SignalBars bars={rxQ.bars} bg={rxQ.bg} />
                                <span className={`text-[9px] font-semibold ${rxQ.color}`}>{rxQ.label}</span>
                              </div>
                            </>
                          ) : (
                            <p className="text-base font-bold text-slate-300">—</p>
                          )}
                        </div>
                      </div>

                      {/* Sparkline */}
                      {(txSeries.length >= 2 || rxSeries.length >= 2) && (
                        <TimeSeriesChart height={48} yFmt={v => `${v.toFixed(1)}`}
                          series={[
                            ...(txSeries.length >= 2 ? [{ name: 'Tx', color: '#0891b2', data: txSeries }] : []),
                            ...(rxSeries.length >= 2 ? [{ name: 'Rx', color: '#f59e0b', data: rxSeries }] : []),
                          ]} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* FIB Route Counts */}
      {(() => {
        const ipv4 = hist?.fib_routes?.['ipv4'] ?? null
        const ipv6 = hist?.fib_routes?.['ipv6'] ?? null
        if (ipv4 === null && ipv6 === null) return null
        const ipv4Trend = (hist?.fib_trend?.['ipv4'] ?? []) as [number, number][]
        const ipv6Trend = (hist?.fib_trend?.['ipv6'] ?? []) as [number, number][]
        const fmtRoutes = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}k` : String(n)
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">FIB Route Table</p>
            <div className="grid grid-cols-2 gap-3">
              {ipv4 !== null && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-700">IPv4 Routes</span>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-2xl font-bold text-slate-800">{fmtRoutes(ipv4)}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">total FIB entries</p>
                    {ipv4Trend.length >= 2 && (
                      <div className="mt-2">
                        <TimeSeriesChart height={40} yFmt={v => fmtRoutes(v)}
                          series={[{ name: 'IPv4', color: '#6366f1', data: ipv4Trend }]} />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {ipv6 !== null && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-700">IPv6 Routes</span>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-2xl font-bold text-slate-800">{fmtRoutes(ipv6)}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">total FIB entries</p>
                    {ipv6Trend.length >= 2 && (
                      <div className="mt-2">
                        <TimeSeriesChart height={40} yFmt={v => fmtRoutes(v)}
                          series={[{ name: 'IPv6', color: '#06b6d4', data: ipv6Trend }]} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* TCAM / Hardware Utilisation */}
      {(() => {
        const rows = hist?.tcam ?? []
        if (rows.length === 0) return null
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">TCAM / Hardware Utilisation</p>
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
              {rows.map((row, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-slate-700 truncate">{row.resource}</span>
                      {row.feature && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full shrink-0">{row.feature}</span>}
                      {row.chip && <span className="text-[10px] text-slate-400 shrink-0">· {row.chip}</span>}
                    </div>
                    <span className={`text-xs font-bold shrink-0 ml-3 ${row.pct >= 90 ? 'text-red-600' : row.pct >= 75 ? 'text-amber-500' : 'text-slate-700'}`}>
                      {row.pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(row.pct, 100)}%`,
                          backgroundColor: row.pct >= 90 ? '#dc2626' : row.pct >= 75 ? '#f59e0b' : '#6366f1',
                        }} />
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0 w-28 text-right">
                      {row.used.toLocaleString()} / {row.max.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Interface Health — flaps, err-disabled, ACL drops */}
      {(() => {
        const flaps     = hist?.if_flaps      ?? {}
        const aclDrops  = hist?.if_acl_drops  ?? {}
        const errPorts  = hist?.if_err_disabled ?? []
        const flapList  = Object.entries(flaps).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
        const aclList   = Object.entries(aclDrops).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
        if (flapList.length === 0 && errPorts.length === 0 && aclList.length === 0) return null
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Interface Health</p>
            <div className="space-y-3">
              {/* Err-disabled */}
              {errPorts.length > 0 && (
                <div className="bg-red-50 rounded-xl border border-red-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-red-200 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-red-600 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
                    </svg>
                    <span className="text-xs font-semibold text-red-700">Err-Disabled Ports ({errPorts.length})</span>
                  </div>
                  <div className="divide-y divide-red-100">
                    {errPorts.map((p, i) => (
                      <div key={i} className="px-4 py-2.5 flex items-center justify-between">
                        <span className="text-xs font-semibold text-red-800">{p.if_name}</span>
                        <span className="text-[10px] text-red-600 bg-red-100 px-2 py-0.5 rounded-full">{p.reason || 'unknown'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Flapping interfaces */}
              {flapList.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-amber-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    <span className="text-xs font-semibold text-slate-700">Interface Flaps (since last restart)</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {flapList.slice(0, 10).map(([iface, count], i) => (
                      <div key={i} className="px-4 py-2.5 flex items-center justify-between">
                        <span className="text-xs font-medium text-slate-700">{iface}</span>
                        <span className={`text-xs font-bold ${count >= 10 ? 'text-red-600' : count >= 3 ? 'text-amber-500' : 'text-slate-500'}`}>
                          {count} flap{count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                    {flapList.length > 10 && (
                      <div className="px-4 py-2 text-[10px] text-slate-400">+{flapList.length - 10} more</div>
                    )}
                  </div>
                </div>
              )}
              {/* ACL drops */}
              {aclList.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <span className="text-xs font-semibold text-slate-700">ACL Drops</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {aclList.slice(0, 10).map(([iface, count], i) => (
                      <div key={i} className="px-4 py-2.5 flex items-center justify-between">
                        <span className="text-xs font-medium text-slate-700">{iface}</span>
                        <span className="text-xs font-bold text-slate-600">{count.toLocaleString()} pkts</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Aruba CX: Hardware Health (fans + PSUs) */}
      {(() => {
        const psus = hist?.cx_psus ?? []
        const fans = hist?.cx_fans ?? []
        if (psus.length === 0 && fans.length === 0) return null
        const faultPSUs = psus.filter(p => !p.ok)
        const faultFans = fans.filter(f => !f.ok)
        const allOK = faultPSUs.length === 0 && faultFans.length === 0
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Hardware Health</p>
            <div className="space-y-3">
              {/* PSUs */}
              {psus.length > 0 && (
                <div className={`rounded-2xl border overflow-hidden ${faultPSUs.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
                  <div className={`px-5 py-3 border-b flex items-center gap-2 ${faultPSUs.length > 0 ? 'border-red-200' : 'border-slate-100'}`}>
                    <svg className={`w-4 h-4 shrink-0 ${faultPSUs.length > 0 ? 'text-red-500' : 'text-green-500'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    <span className={`text-xs font-semibold ${faultPSUs.length > 0 ? 'text-red-700' : 'text-slate-700'}`}>
                      Power Supplies
                    </span>
                    <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${faultPSUs.length > 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                      {faultPSUs.length > 0 ? `${faultPSUs.length} fault` : 'All OK'}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {psus.map((p, i) => (
                      <div key={i} className="px-5 py-3 flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${p.ok ? 'bg-green-400' : 'bg-red-500'}`} />
                        <span className="text-xs font-semibold text-slate-700 flex-1">{p.name}</span>
                        {p.max_w > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-amber-400"
                                style={{ width: `${Math.min(p.max_w > 0 ? p.power_w / p.max_w * 100 : 0, 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-slate-500 shrink-0">{p.power_w}W / {p.max_w}W</span>
                          </div>
                        ) : p.power_w > 0 ? (
                          <span className="text-[10px] text-slate-500">{p.power_w}W</span>
                        ) : null}
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${p.ok ? 'bg-green-50 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {p.ok ? 'OK' : 'FAULT'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Fans */}
              {fans.length > 0 && (
                <div className={`rounded-2xl border overflow-hidden ${faultFans.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
                  <div className={`px-5 py-3 border-b flex items-center gap-2 ${faultFans.length > 0 ? 'border-red-200' : 'border-slate-100'}`}>
                    <svg className={`w-4 h-4 shrink-0 ${faultFans.length > 0 ? 'text-red-500' : 'text-green-500'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M12 12c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
                    </svg>
                    <span className={`text-xs font-semibold ${faultFans.length > 0 ? 'text-red-700' : 'text-slate-700'}`}>
                      Fans
                    </span>
                    <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${faultFans.length > 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                      {faultFans.length > 0 ? `${faultFans.length} fault` : 'All OK'}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {fans.map((f, i) => (
                      <div key={i} className="px-5 py-3 flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${f.ok ? 'bg-green-400' : 'bg-red-500'}`} />
                        <span className="text-xs font-semibold text-slate-700 flex-1">{f.name}</span>
                        {f.speed_pct > 0 && (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-cyan-400"
                                style={{ width: `${Math.min(f.speed_pct, 100)}%` }} />
                            </div>
                            <span className="text-[10px] text-slate-500 shrink-0">{f.speed_pct}%</span>
                          </div>
                        )}
                        {f.rpm > 0 && <span className="text-[10px] text-slate-400 shrink-0">{f.rpm.toLocaleString()} RPM</span>}
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${f.ok ? 'bg-green-50 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {f.ok ? 'OK' : 'FAULT'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Aruba CX: VSX State */}
      {(() => {
        const vsx = hist?.cx_vsx ?? null
        if (!vsx) return null
        const stateColor = vsx.state === 'in-sync' ? 'text-green-700 bg-green-100' : vsx.state === 'standalone' ? 'text-slate-600 bg-slate-100' : 'text-red-600 bg-red-100'
        return (
          <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex items-center gap-4">
            <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>
                <path d="M10 7h4M7 10v4M17 10v4M10 17h4"/>
              </svg>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">VSX (Virtual Switching)</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${stateColor}`}>{vsx.state}</span>
                <span className="text-xs text-slate-500">{vsx.role}</span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Aruba CX: CoPP Drops */}
      {(() => {
        const copp = hist?.cx_copp ?? []
        if (copp.length === 0) return null
        const total = copp.reduce((s, r) => s + r.drop_pkts, 0)
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Control Plane Policing (CoPP) Drops</p>
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Top classes by dropped packets</span>
                <span className="text-[10px] text-slate-400">{total.toLocaleString()} total drops</span>
              </div>
              <div className="divide-y divide-slate-50">
                {copp.map((r, i) => {
                  const pct = total > 0 ? r.drop_pkts / total * 100 : 0
                  return (
                    <div key={i} className="px-5 py-2.5 flex items-center gap-3">
                      <span className="text-xs font-medium text-slate-700 flex-1 truncate">{r.class}</span>
                      <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden shrink-0">
                        <div className="h-full bg-orange-400 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-bold text-slate-600 w-20 text-right shrink-0">{r.drop_pkts.toLocaleString()}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Aruba CX: Loop Protection */}
      {(() => {
        const loops = hist?.cx_loops ?? []
        if (loops.length === 0) return null
        return (
          <div className="bg-red-50 rounded-xl border border-red-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-red-200 flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-red-600 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/>
              </svg>
              <span className="text-xs font-semibold text-red-700">Loop Detected ({loops.length} port{loops.length !== 1 ? 's' : ''})</span>
            </div>
            <div className="px-4 py-2.5 flex flex-wrap gap-2">
              {loops.map((iface, i) => (
                <span key={i} className="text-xs font-semibold text-red-700 bg-red-100 px-2 py-1 rounded-lg">{iface}</span>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Cisco: Hardware Health (fans + PSUs via CISCO-ENVMON-MIB) */}
      {(() => {
        const fans = hist?.cisco_fans ?? []
        const psus = hist?.cisco_psus ?? []
        if (fans.length === 0 && psus.length === 0) return null
        const faultFans = fans.filter(f => !f.ok)
        const faultPSUs = psus.filter(p => !p.ok)
        const renderRow = (unit: { name: string; ok: boolean }, i: number) => (
          <div key={i} className="px-5 py-2.5 flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full shrink-0 ${unit.ok ? 'bg-green-400' : 'bg-red-500'}`} />
            <span className="text-xs font-medium text-slate-700 flex-1">{unit.name}</span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${unit.ok ? 'bg-green-50 text-green-700' : 'bg-red-100 text-red-600'}`}>
              {unit.ok ? 'OK' : 'FAULT'}
            </span>
          </div>
        )
        const hasFault = faultFans.length > 0 || faultPSUs.length > 0
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Hardware Health</p>
            <div className="space-y-3">
              {psus.length > 0 && (
                <div className={`rounded-2xl border overflow-hidden ${faultPSUs.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
                  <div className={`px-5 py-3 border-b flex items-center gap-2 ${faultPSUs.length > 0 ? 'border-red-200' : 'border-slate-100'}`}>
                    <svg className={`w-4 h-4 shrink-0 ${faultPSUs.length > 0 ? 'text-red-500' : 'text-green-500'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    <span className={`text-xs font-semibold ${faultPSUs.length > 0 ? 'text-red-700' : 'text-slate-700'}`}>Power Supplies</span>
                    <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${faultPSUs.length > 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                      {faultPSUs.length > 0 ? `${faultPSUs.length} fault` : 'All OK'}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">{psus.map(renderRow)}</div>
                </div>
              )}
              {fans.length > 0 && (
                <div className={`rounded-2xl border overflow-hidden ${faultFans.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
                  <div className={`px-5 py-3 border-b flex items-center gap-2 ${faultFans.length > 0 ? 'border-red-200' : 'border-slate-100'}`}>
                    <svg className={`w-4 h-4 shrink-0 ${faultFans.length > 0 ? 'text-red-500' : 'text-green-500'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M12 12c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/>
                    </svg>
                    <span className={`text-xs font-semibold ${faultFans.length > 0 ? 'text-red-700' : 'text-slate-700'}`}>Fans</span>
                    <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${faultFans.length > 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                      {faultFans.length > 0 ? `${faultFans.length} fault` : 'All OK'}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">{fans.map(renderRow)}</div>
                </div>
              )}
              {!hasFault && (
                <p className="text-[10px] text-slate-400 px-1">All hardware units reporting normal via CISCO-ENVMON-MIB</p>
              )}
            </div>
          </div>
        )
      })()}

      {/* Cisco: Memory Pools */}
      {(() => {
        const pools = hist?.cisco_mem_pools ?? []
        if (pools.length === 0) return null
        const fmtBytes = (b: number) => b >= 1_073_741_824 ? `${(b/1_073_741_824).toFixed(1)}G` : b >= 1_048_576 ? `${(b/1_048_576).toFixed(0)}M` : `${(b/1024).toFixed(0)}K`
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Memory Pools</p>
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
              {pools.map((p, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-slate-700">{p.pool}</span>
                    <span className={`text-xs font-bold shrink-0 ml-3 ${p.pct >= 90 ? 'text-red-600' : p.pct >= 75 ? 'text-amber-500' : 'text-slate-700'}`}>
                      {p.pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(p.pct, 100)}%`, backgroundColor: p.pct >= 90 ? '#dc2626' : p.pct >= 75 ? '#f59e0b' : '#2563eb' }} />
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0 w-28 text-right">
                      {fmtBytes(p.used)} / {fmtBytes(p.used + p.free)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Cisco: Interface Queue Drops + Resets */}
      {(() => {
        const inDrops  = hist?.cisco_if_in_drops  ?? {}
        const outDrops = hist?.cisco_if_out_drops ?? {}
        const resets   = hist?.cisco_if_resets    ?? {}
        const inList   = Object.entries(inDrops).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1])
        const outList  = Object.entries(outDrops).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1])
        const resetList = Object.entries(resets).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1])
        if (inList.length === 0 && outList.length === 0 && resetList.length === 0) return null
        return (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Interface Statistics</p>
            <div className="space-y-3">
              {resetList.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-amber-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    <span className="text-xs font-semibold text-slate-700">Interface Resets (since boot)</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {resetList.slice(0, 10).map(([iface, count], i) => (
                      <div key={i} className="px-4 py-2.5 flex items-center justify-between">
                        <span className="text-xs font-medium text-slate-700">{iface}</span>
                        <span className={`text-xs font-bold ${count >= 10 ? 'text-red-600' : count >= 3 ? 'text-amber-500' : 'text-slate-500'}`}>
                          {count} reset{count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                    {resetList.length > 10 && <div className="px-4 py-2 text-[10px] text-slate-400">+{resetList.length - 10} more</div>}
                  </div>
                </div>
              )}
              {(inList.length > 0 || outList.length > 0) && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <span className="text-xs font-semibold text-slate-700">Queue Drops</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    {Array.from(new Set([...inList.map(([k])=>k), ...outList.map(([k])=>k)])).slice(0,10).map((iface, i) => {
                      const inD  = inDrops[iface]  ?? 0
                      const outD = outDrops[iface] ?? 0
                      return (
                        <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                          <span className="text-xs font-medium text-slate-700 flex-1">{iface}</span>
                          {inD > 0  && <span className="text-[10px] bg-orange-50 text-orange-600 px-1.5 py-0.5 rounded font-medium">↓ {inD.toLocaleString()} in</span>}
                          {outD > 0 && <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-medium">↑ {outD.toLocaleString()} out</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ICMP Latency */}
      {(() => {
        const hasRtt  = (latency?.rtt_avg_ms?.length ?? 0) > 0
        const hasLoss = (latency?.loss_pct?.length ?? 0) > 0
        if (!hasRtt && !hasLoss) return null
        const lossNow = latency?.loss_pct?.at(-1)?.[1] ?? null
        const rttNow  = latency?.rtt_avg_ms?.at(-1)?.[1] ?? null
        return (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">ICMP Synthetic Probe</p>

            {/* RTT */}
            {hasRtt && (
              <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center">
                      <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">Round-Trip Time</p>
                      {rttNow != null && (
                        <p className="text-xs text-slate-400">
                          Latest avg: <span className="font-semibold" style={{ color: rttNow > 200 ? '#dc2626' : rttNow > 100 ? '#f59e0b' : '#16a34a' }}>
                            {rttNow.toFixed(1)} ms
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                  {rttNow != null && (
                    <p className="text-2xl font-bold text-slate-800">{rttNow.toFixed(1)} ms</p>
                  )}
                </div>
                <div className="px-4 pt-3 pb-2 bg-white">
                  <TimeSeriesChart height={120} yFmt={v => `${v.toFixed(1)} ms`}
                    series={[
                      { name: 'Min', color: '#6ee7b7', data: (latency?.rtt_min_ms ?? []) as [number,number][] },
                      { name: 'Avg', color: '#10b981', data: (latency?.rtt_avg_ms ?? []) as [number,number][] },
                      { name: 'Max', color: '#059669', data: (latency?.rtt_max_ms ?? []) as [number,number][] },
                    ]} />
                </div>
              </div>
            )}

            {/* Packet loss */}
            {hasLoss && (
              <div className="bg-slate-50 rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center">
                      <svg className="w-4 h-4 text-orange-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-800">Packet Loss</p>
                      {lossNow != null && (
                        <p className="text-xs text-slate-400">
                          Latest: <span className="font-semibold" style={{ color: lossNow >= 50 ? '#dc2626' : lossNow > 0 ? '#f59e0b' : '#16a34a' }}>
                            {lossNow.toFixed(1)}%
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                  {lossNow != null && (
                    <p className="text-2xl font-bold text-slate-800">{lossNow.toFixed(1)}%</p>
                  )}
                </div>
                <div className="px-4 pt-3 pb-2 bg-white">
                  <TimeSeriesChart height={100} yFmt={fmtPct}
                    series={[{ name: 'Loss', color: '#f97316', data: (latency?.loss_pct ?? []) as [number,number][] }]} />
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {temps.length === 0 && !currentHealth && (
        <div className="text-center py-8 text-slate-400 text-sm">No health data available yet.</div>
      )}
    </div>
  )
}

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const role = useRole()
  const canOperate = hasRole(role, 'operator')
  const canAdmin   = hasRole(role, 'admin')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  type TabKey = 'interfaces' | 'neighbors' | 'addresses' | 'routes' | 'vlans' | 'stp' | 'health' | 'config' | 'bgp' | 'traps'
  const VALID_TABS: TabKey[] = ['interfaces', 'neighbors', 'addresses', 'routes', 'vlans', 'stp', 'health', 'config', 'bgp', 'traps']
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const tab: TabKey = rawTab && VALID_TABS.includes(rawTab as TabKey) ? rawTab as TabKey : 'interfaces'
  const setTab = useCallback((t: TabKey) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', t)
      return next
    }, { replace: false })
  }, [setSearchParams])

  // Check if device has any SSH/API credential — hides Config tab if not
  const { data: deviceCredsForTab = [] } = useQuery({
    queryKey:  ['device-creds-tab', id],
    queryFn:   () => fetchDeviceCredentials(id!),
    enabled:   !!id,
    staleTime: 120_000,
  })
  const hasConfigCred = deviceCredsForTab.some(
    c => ['ssh', 'api_token', 'netconf'].includes(c.type)
  )

  // Lightweight count queries for tab badges — long staleTime, no refetch interval
  const { data: bgpSessionsForBadge = [] } = useQuery({
    queryKey:  ['bgp-sessions', id],
    queryFn:   () => fetchDeviceBGPSessions(id!),
    enabled:   !!id,
    staleTime: 60_000,
  })
  const bgpCount = bgpSessionsForBadge.length
  const bgpDownCount = bgpSessionsForBadge.filter(s => s.session_state !== 'established').length

  const deleteMutation = useMutation({
    mutationFn: () => deleteDevice(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      navigate('/devices')
    },
  })

  const { data: device, isLoading, isError, refetch } = useQuery({
    queryKey: ['device', id],
    queryFn: () => fetchDevice(id!),
    enabled: !!id,
  })

  // Used to detect "status is bad but no device_down alert has fired yet" —
  // surfaces an explicit Pending pill so operators don't think alerting broke.
  const { data: openDeviceAlerts } = useQuery({
    queryKey: ['device-open-alerts', id],
    queryFn: () => fetchAlerts({ device_id: id!, status: 'open', limit: 50 }),
    enabled: !!id,
    refetchInterval: 15_000,
  })
  const hasOpenDeviceDown = !!openDeviceAlerts?.items?.some(
    a => (a.context?.metric as string | undefined) === 'device_down',
  )
  const pendingDeviceDown =
    !!device && ['unreachable', 'down'].includes(device.status) && !hasOpenDeviceDown

  const { data: health } = useQuery({
    queryKey: ['device-health', id],
    queryFn: () => fetchDeviceHealth(id!),
    enabled: !!id,
    refetchInterval: 15_000,
    retry: false,
  })

  const { data: interfaces, isLoading: ifaceLoading } = useQuery({
    queryKey: ['device-interfaces', id],
    queryFn: () => fetchDeviceInterfaces(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  })

  const { data: baselines } = useQuery({
    queryKey: ['device-baselines', id],
    queryFn: () => fetchDeviceBaselines(id!),
    enabled: !!id,
    staleTime: 5 * 60_000,  // baselines are computed hourly — no need to hammer the API
  })

  // Build a lookup map: interface_id → BaselineRow for interface_down metric
  const ifaceDownBaselines = React.useMemo(() => {
    const rows = baselines?.baselines?.['interface_down'] ?? []
    const map: Record<string, BaselineRow> = {}
    for (const row of rows) {
      if (row.interface_id) map[row.interface_id] = row
    }
    return map
  }, [baselines])

  // SNMP form state — initialised from device once loaded
  const [snmpVersion, setSnmpVersion] = useState('')
  const [snmpPort, setSnmpPort] = useState('')
  const [pollingInterval, setPollingInterval] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState('')
  const [ignoredMetrics, setIgnoredMetrics] = useState<string[]>([])
  const [ignoredIfaces, setIgnoredIfaces] = useState<string[]>([])
  const [overrideMetric, setOverrideMetric] = useState('cpu_util_pct')
  const [overrideThreshold, setOverrideThreshold] = useState('')
  const [overrideSeverity, setOverrideSeverity] = useState('warning')
  const [overrideMsg, setOverrideMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const exclusionMutation = useMutation({
    mutationFn: () => setAlertExclusions(id!, ignoredMetrics, ignoredIfaces),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device', id] }),
  })

  const overrideMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      import('../api/client').then(m => m.default.post('/alert-rules', body)),
    onSuccess: () => {
      setOverrideThreshold('')
      setOverrideMsg({ ok: true, text: 'Override rule created.' })
    },
    onError: () => setOverrideMsg({ ok: false, text: 'Failed to create override.' }),
  })

  const patchMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => patchDevice(id!, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device', id] }),
  })

  if (isLoading || !device) return <div className="p-8 text-slate-500">Loading…</div>
  if (isError) return <ErrorState message="Failed to load device." onRetry={() => refetch()} />

  const upIfaces = interfaces?.filter((i) => i.oper_status === 'up').length ?? 0
  const totalIfaces = interfaces?.length ?? 0

  const openSettings = () => {
    setSnmpVersion(device.snmp_version)
    setSnmpPort(String(device.snmp_port))
    setPollingInterval(String(device.polling_interval_s))
    setTagInput('')
    setTagError('')
    const excl = (device as any).alert_exclusions ?? { metrics: [], interface_ids: [] }
    setIgnoredMetrics(excl.metrics ?? [])
    setIgnoredIfaces(excl.interface_ids ?? [])
    setConfirmDelete(false)
    setSettingsOpen(true)
  }

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag) return
    const current: string[] = device.tags ?? []
    if (current.includes(tag)) { setTagError('Tag already exists'); return }
    setTagError('')
    patchMutation.mutate({ tags: [...current, tag] }, {
      onSuccess: () => { setTagInput(''); queryClient.invalidateQueries({ queryKey: ['device', id] }) },
    })
  }

  const removeTag = (tag: string) => {
    const current: string[] = device.tags ?? []
    patchMutation.mutate({ tags: current.filter(t => t !== tag) })
  }

  const saveSnmp = () => patchMutation.mutate({
    snmp_version: snmpVersion,
    snmp_port: Number(snmpPort),
    polling_interval_s: Number(pollingInterval),
  })

  const typeColor = DEVICE_TYPE_COLOR[device.device_type] ?? '#475569'
  const statusColor: Record<string, string> = {
    up: '#16a34a', down: '#dc2626', unreachable: '#f97316', unknown: '#94a3b8',
  }
  const sc = statusColor[device.status] ?? '#94a3b8'
  const statusLabel: Record<string, string> = {
    up: 'Up', down: 'Down', unreachable: 'Unreachable', unknown: 'Unknown',
  }

  return (
    <div className="min-h-screen bg-slate-50">

      {/* Breadcrumb */}
      <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between">
        <nav className="flex items-center gap-1.5 text-xs text-slate-400">
          <Link to="/devices" className="hover:text-blue-600 transition-colors flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
            Devices
          </Link>
          <span>/</span>
          <span className="text-slate-600 font-medium">{device.fqdn ?? device.hostname}</span>
        </nav>
        <button
          onClick={openSettings}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
        >
          <GearIcon />
          Settings
        </button>
      </div>

      {/* Hero */}
      <div className="bg-white border-b border-slate-200" style={{ borderLeft: `4px solid ${typeColor}` }}>
        <div className="px-6 py-5 flex items-start gap-5">
          {/* Device type icon */}
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 mt-0.5"
            style={{ backgroundColor: `${typeColor}18` }}>
            <span style={{ color: typeColor }}>
              <DeviceTypeIcon type={device.device_type} size={28} />
            </span>
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap mb-1">
              <h1 className="text-xl font-bold text-slate-900 truncate">
                {device.fqdn ?? device.hostname}
              </h1>
              {/* Status */}
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
                style={{ backgroundColor: `${sc}15`, color: sc }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sc }} />
                {statusLabel[device.status] ?? device.status}
              </span>
              {pendingDeviceDown && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                  title="The device is unreachable but the device_down rule's duration gate hasn't expired yet. An alert will fire if the failure continues."
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  Alert pending
                </span>
              )}
              <MaintenanceBadge deviceId={id!} />
            </div>

            <div className="flex items-center gap-3 flex-wrap text-sm text-slate-500 mb-3">
              <span className="flex items-center gap-1" style={{ color: typeColor }}>
                <DeviceTypeIcon type={device.device_type} size={13} />
                <span className="font-medium">{DEVICE_TYPE_LABEL[device.device_type] ?? device.device_type}</span>
              </span>
              <span className="text-slate-300">·</span>
              <VendorBadge vendor={device.vendor} />
              <span className="text-slate-300">·</span>
              <span className="font-mono text-slate-600">{device.mgmt_ip}</span>
              {device.fqdn && device.fqdn !== device.hostname && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-400">{device.hostname}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-4 flex-wrap text-xs text-slate-400">
              {device.platform && (
                <span><span className="text-slate-500 font-medium">Platform</span> {device.platform}</span>
              )}
              {device.os_version && (
                <span><span className="text-slate-500 font-medium">OS</span> {device.os_version}</span>
              )}
              <span><span className="text-slate-500 font-medium">SNMP</span> {device.snmp_version?.toUpperCase() ?? '—'} :{device.snmp_port}</span>
              {(device.snmp_version === 'v3' || device.snmp_engine_id) && (
                <EngineIdBadge deviceId={device.id} engineId={device.snmp_engine_id ?? null} remoteCollector={!!device.collector_id} />
              )}
              {(device.tags ?? []).length > 0 && (
                <div className="flex items-center gap-1.5">
                  {(device.tags ?? []).map((tag: string) => (
                    <span key={tag} className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-medium">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Health metrics row */}
        <div className="grid grid-cols-2 md:grid-cols-4 border-t border-slate-100 divide-x divide-slate-100">
          {/* CPU */}
          <div className="px-3 py-3 md:px-5 md:py-4">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">CPU</p>
            {health?.cpu_util_pct != null ? (
              <>
                <p className="text-2xl font-bold text-slate-800 mb-2">{Number(health.cpu_util_pct).toFixed(1)}%</p>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(Number(health.cpu_util_pct), 100)}%`,
                      backgroundColor: Number(health.cpu_util_pct) > 90 ? '#dc2626' : Number(health.cpu_util_pct) > 70 ? '#f59e0b' : '#16a34a',
                    }} />
                </div>
              </>
            ) : <p className="text-2xl font-bold text-slate-300">—</p>}
          </div>

          {/* Memory */}
          <div className="px-3 py-3 md:px-5 md:py-4">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Memory</p>
            {health?.mem_used_bytes && health?.mem_total_bytes ? (
              <>
                <p className="text-2xl font-bold text-slate-800 mb-2">
                  {Math.round((Number(health.mem_used_bytes) / Number(health.mem_total_bytes)) * 100)}%
                </p>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(Math.round((Number(health.mem_used_bytes) / Number(health.mem_total_bytes)) * 100), 100)}%` }} />
                </div>
                <p className="text-[10px] text-slate-400 mt-1">{formatBytes(health.mem_used_bytes)} / {formatBytes(health.mem_total_bytes)}</p>
              </>
            ) : <p className="text-2xl font-bold text-slate-300">—</p>}
          </div>

          {/* Uptime */}
          <div className="px-3 py-3 md:px-5 md:py-4">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Uptime</p>
            <p className="text-2xl font-bold text-slate-800">{formatUptime(health?.uptime_seconds ?? null)}</p>
            {health?.temperatures && health.temperatures.length > 0 && (
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {health.temperatures.map((t, i) => (
                  <span key={i} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${t.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {t.celsius}°C
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Interfaces */}
          <div className="px-3 py-3 md:px-5 md:py-4">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Interfaces</p>
            <p className="text-2xl font-bold text-slate-800">
              {upIfaces}
              <span className="text-base font-normal text-slate-400"> / {totalIfaces}</span>
            </p>
            {totalIfaces > 0 && (
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
                <div className="h-full rounded-full bg-green-500 transition-all"
                  style={{ width: `${Math.round((upIfaces / totalIfaces) * 100)}%` }} />
              </div>
            )}
            <p className="text-[10px] text-slate-400 mt-1">ports up</p>
          </div>
        </div>
      </div>

      {/* Settings drawer */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-30" onClick={() => setSettingsOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-80 bg-white shadow-xl z-40 flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-700">
                <GearIcon />
                <span className="text-sm font-semibold">Device settings</span>
              </div>
              <button onClick={() => setSettingsOpen(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">

              <Section title="SNMP">
                <Field label="Version">
                  <Select value={snmpVersion} onChange={setSnmpVersion} options={[
                    { value: 'v2c', label: 'v2c' },
                    { value: 'v3',  label: 'v3' },
                    { value: 'v1',  label: 'v1' },
                  ]} />
                </Field>
                <Field label="Port">
                  <Input value={snmpPort} onChange={setSnmpPort} type="number" />
                </Field>
                <Field label="Polling interval (s)">
                  <Input value={pollingInterval} onChange={setPollingInterval} type="number" />
                </Field>
                <button
                  onClick={saveSnmp}
                  disabled={patchMutation.isPending}
                  className="w-full mt-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {patchMutation.isPending ? 'Saving…' : 'Save SNMP settings'}
                </button>
                {patchMutation.isSuccess && <p className="text-xs text-green-600 mt-1">Saved.</p>}
                {patchMutation.isError && <p className="text-xs text-red-600 mt-1">Save failed.</p>}
              </Section>

              <CollectorSection deviceId={id!} currentCollectorId={(device as any).collector_id ?? null} onSave={(cid) => patchMutation.mutate({ collector_id: cid })} />


              <Section title="Tags">
                <div className="flex flex-wrap gap-1.5 mb-2 min-h-[24px]">
                  {(device.tags ?? []).length === 0 && (
                    <span className="text-xs text-slate-400">No tags</span>
                  )}
                  {(device.tags ?? []).map((tag: string) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                      {tag}
                      <button onClick={() => removeTag(tag)} aria-label={`Remove tag "${tag}"`} className="text-slate-400 hover:text-red-500 leading-none">×</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={tagInput}
                    onChange={e => { setTagInput(e.target.value); setTagError('') }}
                    onKeyDown={e => e.key === 'Enter' && addTag()}
                    placeholder="core, edge, uplink…"
                    className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button onClick={addTag} disabled={!tagInput.trim()}
                    className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 disabled:opacity-40">
                    Add
                  </button>
                </div>
                {tagError && <p className="text-xs text-red-500 mt-1">{tagError}</p>}
                <p className="text-xs text-slate-400 mt-1">Tags are used by alert policies to target specific devices.</p>
              </Section>

              <Section title="Alert ignores">
                <p className="text-xs text-slate-400 mb-2">Silence specific alert types for this device. Interface-specific ignores only affect interface down alerts.</p>

                {/* Metric ignores */}
                <p className="text-xs font-medium text-slate-500 mb-1.5">Ignore metrics</p>
                <div className="space-y-1 mb-3">
                  {['cpu_util_pct','mem_util_pct','device_down','temperature','uptime'].map(metric => (
                    <label key={metric} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={ignoredMetrics.includes(metric)}
                        onChange={e => setIgnoredMetrics(prev =>
                          e.target.checked ? [...prev, metric] : prev.filter(m => m !== metric)
                        )}
                        className="rounded border-slate-300 text-blue-600" />
                      {metric.replace(/_/g, ' ')}
                    </label>
                  ))}
                </div>

                {/* Interface-specific ignores */}
                <p className="text-xs font-medium text-slate-500 mb-1.5">Ignore specific interfaces (interface down alerts)</p>
                <div className="space-y-1 mb-3 max-h-32 overflow-y-auto">
                  {(interfaces ?? []).filter(i => i.admin_status === 'up').map(iface => (
                    <label key={iface.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input type="checkbox"
                        checked={ignoredIfaces.includes(iface.id)}
                        onChange={e => setIgnoredIfaces(prev =>
                          e.target.checked ? [...prev, iface.id] : prev.filter(i => i !== iface.id)
                        )}
                        className="rounded border-slate-300 text-blue-600" />
                      <span className="font-mono">{iface.name}</span>
                      {iface.description && <span className="text-slate-400 truncate">{iface.description}</span>}
                    </label>
                  ))}
                  {(interfaces ?? []).filter(i => i.admin_status === 'up').length === 0 && (
                    <p className="text-xs text-slate-400">No admin-up interfaces loaded</p>
                  )}
                </div>

                <button
                  onClick={() => exclusionMutation.mutate()}
                  disabled={exclusionMutation.isPending}
                  className="w-full bg-slate-700 text-white text-sm rounded-lg py-2 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {exclusionMutation.isPending ? 'Saving…' : 'Save ignores'}
                </button>
                {exclusionMutation.isSuccess && <p className="text-xs text-green-600 mt-1">Saved.</p>}
              </Section>

              <Section title="Alert overrides">
                <p className="text-xs text-slate-400 mb-2">
                  Override global alert thresholds for this device specifically.
                  Device-level rules take priority over policy rules.
                </p>
                <Field label="Metric">
                  <Select value={overrideMetric} onChange={setOverrideMetric} options={[
                    { value: 'cpu_util_pct', label: 'CPU %' },
                    { value: 'mem_util_pct', label: 'Memory %' },
                    { value: 'device_down',  label: 'Device down' },
                    { value: 'interface_down', label: 'Interface down' },
                  ]} />
                </Field>
                {(overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct') && (
                  <Field label="Threshold (%)">
                    <Input value={overrideThreshold} onChange={setOverrideThreshold} type="number" />
                  </Field>
                )}
                <Field label="Severity">
                  <Select value={overrideSeverity} onChange={setOverrideSeverity} options={[
                    { value: 'critical', label: 'Critical' },
                    { value: 'major',    label: 'Major' },
                    { value: 'warning',  label: 'Warning' },
                    { value: 'info',     label: 'Info' },
                  ]} />
                </Field>
                <button
                  onClick={() => {
                    setOverrideMsg(null)
                    const hasThreshold = overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct'
                    overrideMutation.mutate({
                      name: `${device.fqdn ?? device.hostname} — ${overrideMetric} override`,
                      metric: overrideMetric,
                      condition: 'gt',
                      threshold: hasThreshold ? Number(overrideThreshold) : null,
                      duration_seconds: 0,
                      severity: overrideSeverity,
                      device_selector: { device_ids: [id] },
                    })
                  }}
                  disabled={overrideMutation.isPending || ((overrideMetric === 'cpu_util_pct' || overrideMetric === 'mem_util_pct') && !overrideThreshold)}
                  className="w-full mt-1 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {overrideMutation.isPending ? 'Creating…' : 'Create override rule'}
                </button>
                {overrideMsg && (
                  <p className={`text-xs mt-1 ${overrideMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {overrideMsg.text}
                  </p>
                )}
              </Section>

              <Section title="Credentials">
                <CredentialSection deviceId={id!} />
              </Section>

              <Section title="SNMP Diagnostic">
                <SnmpDiagSection deviceId={id!} />
              </Section>

              <Section title="Alerting">
                <PlaceholderSection title="Alert thresholds" description="Per-device CPU, memory and interface alert rules — coming soon" />
              </Section>

              <Section title="Maintenance">
                <MaintenanceSection deviceId={id!} />
              </Section>

              {canAdmin && (
                <Section title="Danger zone">
                  {confirmDelete ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
                      <p className="text-xs text-red-700 font-medium">Remove {device.fqdn ?? device.hostname}?</p>
                      <p className="text-xs text-red-500">This will delete all interfaces, health data and alerts for this device.</p>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => deleteMutation.mutate()}
                          disabled={deleteMutation.isPending}
                          className="flex-1 bg-red-600 text-white text-xs rounded-lg py-1.5 hover:bg-red-700 disabled:opacity-50"
                        >
                          {deleteMutation.isPending ? 'Removing…' : 'Confirm remove'}
                        </button>
                        <button onClick={() => setConfirmDelete(false)} className="flex-1 text-xs text-slate-500 border border-slate-200 rounded-lg py-1.5 hover:bg-slate-50">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full text-sm text-red-600 border border-red-200 rounded-lg py-2 hover:bg-red-50 transition-colors"
                    >
                      Remove device
                    </button>
                  )}
                </Section>
              )}
            </div>
          </div>
        </>
      )}


      <main className="p-6 space-y-4">

        {/* Tabbed panel — sidebar + content */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-1 min-h-0" style={{ minHeight: 480 }}>

          {/* Left sidebar nav */}
          <div className="w-48 shrink-0 border-r border-slate-200 bg-slate-50 overflow-y-auto">
            <nav className="py-1">

              {/* Network */}
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-4 pt-3 pb-1">Network</p>
              <button onClick={() => setTab('interfaces')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'interfaces'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'interfaces' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
                  <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
                </svg>
                <span className="flex-1">Interfaces</span>
                {(totalIfaces ?? 0) > 0 && (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                    tab === 'interfaces' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                  }`}>{totalIfaces}</span>
                )}
              </button>
              <button onClick={() => setTab('addresses')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'addresses'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'addresses' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                  <circle cx="12" cy="9" r="2.5"/>
                </svg>
                Addresses
              </button>

              {/* Layer 2 */}
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-4 pt-3 pb-1">Layer 2</p>
              <button onClick={() => setTab('vlans')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'vlans'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'vlans' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
                </svg>
                VLANs
              </button>
              <button onClick={() => setTab('stp')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'stp'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'stp' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="12" cy="3" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/>
                  <path d="M12 5v6M12 11l-6.3 7.5M12 11l6.3 7.5"/>
                </svg>
                STP
              </button>

              {/* Routing */}
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-4 pt-3 pb-1">Routing</p>
              <button onClick={() => setTab('routes')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'routes'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'routes' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
                Routes
              </button>
              <button onClick={() => setTab('bgp')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'bgp'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'bgp' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>
                </svg>
                <span className="flex-1">BGP</span>
                {bgpDownCount > 0 ? (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 bg-red-100 text-red-600">{bgpDownCount}</span>
                ) : bgpCount > 0 ? (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                    tab === 'bgp' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                  }`}>{bgpCount}</span>
                ) : null}
              </button>
              <button onClick={() => setTab('neighbors')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'neighbors'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'neighbors' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                Neighbors
              </button>

              {/* Monitoring */}
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-4 pt-3 pb-1">Monitoring</p>
              <button onClick={() => setTab('health')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'health'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'health' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                </svg>
                Health
              </button>
              <button onClick={() => setTab('traps')}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                  tab === 'traps'
                    ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                }`}>
                <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'traps' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
                Traps
              </button>

              {/* Configuration */}
              {hasConfigCred && (
                <>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-4 pt-3 pb-1">Configuration</p>
                  <button onClick={() => setTab('config')}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors relative ${
                      tab === 'config'
                        ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                        : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                    }`}>
                    <svg className={`w-3.5 h-3.5 shrink-0 ${tab === 'config' ? 'text-blue-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    Config
                  </button>
                </>
              )}

            </nav>
          </div>

          {/* Content area */}
          <div className="flex-1 min-w-0 overflow-y-auto">

          {tab === 'interfaces' && (
            ifaceLoading ? (
              <div className="p-6 text-slate-400 text-sm">Loading interfaces…</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Name</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600 hidden md:table-cell">Description</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Speed</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Admin</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Oper</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">IP Address</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600 hidden lg:table-cell">MAC</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(interfaces ?? []).map((iface) => {
                      const ips: string[] = Array.isArray((iface as any).ip_addresses)
                        ? (iface as any).ip_addresses.map((a: any) => typeof a === 'string' ? a : a?.address ?? String(a))
                        : []
                      const bl = ifaceDownBaselines[iface.id]
                      const normallyDown = bl && !bl.force_alert && (bl.normal_up_pct ?? 1) <= 0.4
                      const upPctLabel = bl?.normal_up_pct != null
                        ? `Up ${Math.round(bl.normal_up_pct * 100)}% of last ${bl.window_days}d`
                        : null
                      return (
                        <tr
                          key={iface.id}
                          className={`cursor-pointer group transition-colors ${
                            normallyDown
                              ? 'opacity-50 hover:opacity-80 hover:bg-slate-50'
                              : 'hover:bg-blue-50/40'
                          }`}
                          onClick={() => navigate(`/devices/${id}/interfaces/${iface.id}`)}
                        >
                          <td className="px-4 py-2 font-medium font-mono text-sm transition-colors text-slate-700 group-hover:text-blue-600">
                            <span>{iface.name}</span>
                          </td>
                          <td className="px-4 py-2 text-slate-500 max-w-[180px] truncate text-xs hidden md:table-cell">{iface.description ?? '—'}</td>
                          <td className="px-4 py-2 text-slate-600 text-sm">{formatSpeed(iface.speed_bps)}</td>
                          <td className="px-4 py-2"><StatusBadge status={iface.admin_status} /></td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-1.5">
                              <StatusBadge status={iface.oper_status} />
                              {normallyDown && (
                                <span
                                  title={upPctLabel ?? 'Alerts suppressed — normally down port'}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-400 border border-slate-200 cursor-default"
                                >
                                  normally down
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-slate-500">
                            {ips.length > 0 ? ips[0] : <span className="text-slate-300">—</span>}
                            {ips.length > 1 && <span className="text-slate-400 ml-1">+{ips.length - 1}</span>}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-slate-400 hidden lg:table-cell">{iface.mac_address ?? '—'}</td>
                          <td className="px-4 py-2 text-slate-300 group-hover:text-blue-400 transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === 'neighbors' && (
            <div className="p-5">
              <NeighborsSection deviceId={id!} deviceName={device?.fqdn ?? device?.hostname ?? ''} />
            </div>
          )}

          {tab === 'addresses' && (
            <div className="p-5">
              <AddressesSection deviceId={id!} />
            </div>
          )}

          {tab === 'routes' && (
            <div className="p-5">
              <RoutesSection deviceId={id!} />
            </div>
          )}

          {tab === 'vlans' && (
            <div className="p-5">
              <VLANsSection deviceId={id!} />
            </div>
          )}

          {tab === 'stp' && (
            <div className="p-5">
              <STPSection deviceId={id!} />
            </div>
          )}
          {tab === 'health' && (
            <HealthTab deviceId={id!} currentHealth={health ?? null} />
          )}
          {tab === 'bgp' && id && (
            <div className="p-5">
              <BGPSection deviceId={id} />
            </div>
          )}
          {tab === 'config' && id && (
            <div className="p-5">
              <DeviceConfigTab deviceId={id} vendor={device?.vendor} hostname={device?.fqdn ?? device?.hostname} />
            </div>
          )}
          {tab === 'traps' && id && (
            <TrapTab deviceId={id} />
          )}

          </div>{/* end content area */}
        </div>{/* end sidebar+content panel */}

      </main>
    </div>
  )
}

// ── Collector assignment (inside settings panel) ──────────────────────────────

function CollectorSection({ deviceId, currentCollectorId, onSave }: {
  deviceId: string
  currentCollectorId: string | null
  onSave: (collectorId: string | null) => void
}) {
  const { data: collectors = [] } = useQuery({
    queryKey: ['collectors'],
    queryFn:  fetchCollectors,
  })
  const [selected, setSelected] = React.useState(currentCollectorId ?? '')

  React.useEffect(() => { setSelected(currentCollectorId ?? '') }, [currentCollectorId])

  const hasChanged = selected !== (currentCollectorId ?? '')

  return (
    <Section title="Collection">
      <p className="text-xs text-slate-400 mb-2">
        Assign this device to a remote collector. Leave blank to poll from the hub directly.
      </p>
      <Select
        value={selected}
        onChange={setSelected}
        options={[
          { value: '', label: 'Hub (local)' },
          ...collectors
            .filter(c => c.is_active)
            .map(c => ({
              value: c.id,
              label: `${c.name}${c.wg_ip ? ` (${c.wg_ip})` : ''}${c.status === 'online' ? ' ●' : c.status === 'offline' ? ' ○' : ''}`,
            })),
        ]}
      />
      {hasChanged && (
        <button
          onClick={() => onSave(selected || null)}
          className="w-full mt-2 bg-blue-600 text-white text-sm rounded-lg py-2 hover:bg-blue-700 transition-colors"
        >
          Save
        </button>
      )}
    </Section>
  )
}

// ── BGP Section ───────────────────────────────────────────────────────────────

function fmtUptime(secs: number | null): string {
  if (!secs) return '—'
  if (secs < 60)    return `${secs}s`
  if (secs < 3600)  return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`
}

// Tiny inline prefix-count sparkline
function PfxSparkline({ series, w = 80, h = 24 }: { series: [number, number][]; w?: number; h?: number }) {
  if (series.length < 2) return <span className="text-slate-300 text-[10px]">no data</span>
  const vals = series.map(([, v]) => v)
  const times = series.map(([t]) => t)
  const minV = Math.min(...vals), maxV = Math.max(...vals)
  const rangeV = maxV - minV || 1
  const minT = Math.min(...times), maxT = Math.max(...times)
  const rangeT = maxT - minT || 1
  const sx = (t: number) => ((t - minT) / rangeT) * w
  const sy = (v: number) => h - 2 - ((v - minV) / rangeV) * (h - 4)
  const pts = series.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')
  const last = vals[vals.length - 1]
  const first = vals[0]
  const delta = last - first
  const color = delta < -1 ? '#dc2626' : delta > 1 ? '#16a34a' : '#94a3b8'
  return (
    <div className="flex items-center gap-1.5">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[10px] font-mono tabular-nums" style={{ color }}>
        {delta > 0 ? `+${delta}` : delta}
      </span>
    </div>
  )
}

const BGP_STATE_CLS: Record<string, string> = {
  established: 'text-green-700 bg-green-50',
  active:      'text-amber-700 bg-amber-50',
  idle:        'text-slate-600 bg-slate-100',
  connect:     'text-blue-700 bg-blue-50',
  opensent:    'text-purple-700 bg-purple-50',
  openconfirm: 'text-purple-700 bg-purple-50',
}

function BGPEventDrawer({
  session,
  pfxSeries,
  updSeries,
}: {
  session:   BGPSession
  pfxSeries: [number, number][]
  updSeries: [number, number][]
}) {
  const { data: events = [], isLoading } = useQuery({
    queryKey:  ['bgp-events', session.id],
    queryFn:   () => fetchBGPSessionEvents(session.id),
    staleTime: 60_000,
  })

  const hasPfx = pfxSeries.length >= 2
  const hasUpd = updSeries.length >= 2

  // Build a simple SVG chart for prefix count history
  const PfxChart = ({ series, w = 320, h = 64 }: { series: [number, number][]; w?: number; h?: number }) => {
    const vals = series.map(([, v]) => v)
    const times = series.map(([t]) => t)
    const minV = Math.min(...vals), maxV = Math.max(...vals)
    const rangeV = maxV - minV || 1
    const minT = Math.min(...times), maxT = Math.max(...times)
    const rangeT = maxT - minT || 1
    const sx = (t: number) => ((t - minT) / rangeT) * w
    const sy = (v: number) => h - 2 - ((v - minV) / rangeV) * (h - 6)
    const pts = series.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' ')
    const areaD = `M${sx(times[0])},${h} L${series.map(([t, v]) => `${sx(t)},${sy(v)}`).join(' L')} L${sx(times[times.length - 1])},${h} Z`
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path d={areaD} fill="#2563eb" fillOpacity={0.08} />
        <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Min/max labels */}
        <text x={2} y={h - 2} fontSize={8} fill="#94a3b8">{Math.round(minV)}</text>
        <text x={2} y={10} fontSize={8} fill="#94a3b8">{Math.round(maxV)}</text>
      </svg>
    )
  }

  return (
    <tr>
      <td colSpan={9} className="bg-slate-50 px-6 py-4 border-b border-slate-100">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Prefix count chart */}
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
              Prefix count — 24h
            </div>
            {hasPfx ? (
              <div className="rounded-xl bg-white border border-slate-100 px-2 py-2">
                <PfxChart series={pfxSeries} />
                <div className="mt-1 text-[10px] text-slate-400 flex justify-between">
                  <span>24h ago</span>
                  <span className="font-semibold text-slate-600">
                    Now: {pfxSeries[pfxSeries.length - 1][1].toFixed(0)} prefixes
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-400 py-2">
                No history yet — data appears after the first poll cycle.
              </div>
            )}
          </div>

          {/* State transition history */}
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
              State transitions
            </div>
            {isLoading ? (
              <span className="text-xs text-slate-400">Loading…</span>
            ) : events.length === 0 ? (
              <span className="text-xs text-slate-400">
                No transitions observed yet.{' '}
                <span className="font-medium">Flap count</span> reflects the device's own lifetime counter.
              </span>
            ) : (
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {events.map(e => (
                  <div key={e.id} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400 tabular-nums w-36 shrink-0">
                      {new Date(e.recorded_at).toLocaleString()}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.prev_state] ?? 'text-slate-600 bg-slate-100'}`}>
                      {e.prev_state}
                    </span>
                    <span className="text-slate-400">→</span>
                    <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${BGP_STATE_CLS[e.new_state] ?? 'text-slate-600 bg-slate-100'}`}>
                      {e.new_state}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Update rate chart if available */}
            {hasUpd && (
              <div className="mt-3">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  UPDATE message rate (per min) — 24h
                </div>
                <div className="rounded-xl bg-white border border-slate-100 px-2 py-2">
                  <PfxChart series={updSeries} />
                </div>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

function BGPSection({ deviceId }: { deviceId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: sessions = [], isLoading } = useQuery({
    queryKey:        ['bgp-sessions', deviceId],
    queryFn:         () => fetchDeviceBGPSessions(deviceId),
    refetchInterval: 30_000,
  })

  // Prefix history — 24h time-series from VM
  const { data: history } = useQuery({
    queryKey:        ['bgp-prefix-history', deviceId],
    queryFn:         () => fetchBGPPrefixHistory(deviceId, 24),
    staleTime:       5 * 60_000,
    refetchInterval: 5 * 60_000,
    enabled:         sessions.length > 0,
  })

  // Build lookup: peer_ip → { pfx: series, upd: series }
  const pfxByPeer = useMemo((): Record<string, [number, number][]> => {
    const m: Record<string, [number, number][]> = {}
    for (const s of history?.prefix_count ?? []) m[s.peer_ip] = s.values
    return m
  }, [history])

  const updByPeer = useMemo((): Record<string, [number, number][]> => {
    const m: Record<string, [number, number][]> = {}
    for (const s of history?.update_rate ?? []) m[s.peer_ip] = s.values
    return m
  }, [history])

  // Prefetch event history for all sessions so drawer opens instantly
  useEffect(() => {
    sessions.forEach(s => {
      queryClient.prefetchQuery({
        queryKey:  ['bgp-events', s.id],
        queryFn:   () => fetchBGPSessionEvents(s.id),
        staleTime: 60_000,
      })
    })
  }, [sessions, queryClient])

  const established = sessions.filter(s => s.session_state === 'established').length
  const flappers    = sessions.filter(s => s.flap_count > 1).length

  return (
    <div className="space-y-4">
      {sessions.length > 0 && (
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-600">
            <span className="font-semibold text-slate-800">{established}</span>/{sessions.length} peers established
          </span>
          {established < sessions.length && (
            <span className="text-xs font-medium text-red-500 bg-red-50 px-2 py-0.5 rounded">
              {sessions.length - established} down
            </span>
          )}
          {flappers > 0 && (
            <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
              {flappers} flapping
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <p className="text-sm text-slate-400">No BGP sessions found</p>
          <p className="text-xs text-slate-300 mt-1">BGP data is collected via SNMP bgpPeerTable (RFC 1657)</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">State</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Type</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Peer IP</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Peer AS</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">Pfx Rx</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">24h Trend</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">Updates In/Out</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">Flaps</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">Uptime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {sessions.map(s => (
                <React.Fragment key={s.id}>
                  <tr
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.state_color }} />
                        <span className="text-xs font-medium capitalize" style={{ color: s.state_color }}>
                          {s.session_state}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        s.session_type === 'iBGP'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>
                        {s.session_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-slate-700">{s.peer_ip}</div>
                      {s.peer_router_id && s.peer_router_id !== s.peer_ip && (
                        <div className="font-mono text-[10px] text-slate-400">{s.peer_router_id}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {s.peer_asn ? `AS${s.peer_asn}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 text-right tabular-nums font-medium">
                      {s.prefixes_received?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PfxSparkline series={pfxByPeer[s.peer_ip] ?? []} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 text-right tabular-nums">
                      {s.in_updates > 0 || s.out_updates > 0
                        ? `${s.in_updates.toLocaleString()} / ${s.out_updates.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.flap_count > 1 ? (
                        <span className="text-xs font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                          {s.flap_count}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 text-right tabular-nums">
                      {s.session_state === 'established' ? fmtUptime(s.uptime_seconds) : '—'}
                    </td>
                  </tr>
                  {expanded === s.id && (
                    <BGPEventDrawer
                      session={s}
                      pfxSeries={pfxByPeer[s.peer_ip] ?? []}
                      updSeries={updByPeer[s.peer_ip] ?? []}
                    />
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Device Config Tab ─────────────────────────────────────────────────────────

// Mirror of the backend _vendor_key() + supported-vendor set (configmgmt/
// rollback.py + collector.py).  Kept in sync so the Rollback button only shows
// when the API would actually accept the rollback — otherwise the user fills
// out the whole confirm modal only to get a 422.
const ROLLBACK_NETMIKO_KEYS = [
  'arista', 'cisco_ios', 'cisco_iosxe', 'cisco_iosxr', 'cisco_nxos',
  'juniper', 'procurve', 'hp_procurve', 'aruba_cx', 'fortios', 'ubiquiti',
]
const ROLLBACK_SUPPORTED_KEYS = new Set([
  'aruba_cx', 'arista', 'cisco_ios', 'cisco_iosxe', 'cisco_iosxr', 'cisco_nxos', 'juniper',
])

function rollbackVendorKey(vendor?: string): string {
  const v = (vendor ?? '').toLowerCase()
  for (const k of ROLLBACK_NETMIKO_KEYS) if (v.includes(k)) return k
  if (v.includes('eos') || v.includes('arista')) return 'arista'
  if (v.includes('ios') || v.includes('cisco')) return 'cisco_ios'
  return 'cisco_ios'  // backend's safe fallback
}

function rollbackSupported(vendor?: string): boolean {
  return ROLLBACK_SUPPORTED_KEYS.has(rollbackVendorKey(vendor))
}

function goldenScoreStyle(score: number) {
  if (score >= 90) return { badge: 'bg-green-100 text-green-700', bar: '#16a34a' }
  if (score >= 70) return { badge: 'bg-yellow-100 text-yellow-700', bar: '#ca8a04' }
  return { badge: 'bg-red-100 text-red-700', bar: '#dc2626' }
}

function DeviceGoldenResultRow({ result }: { result: GoldenConfigResult }) {
  const [open, setOpen] = useState(false)
  const score = Number(result.score)
  const style = goldenScoreStyle(score)

  return (
    <div className={score < 70 ? 'bg-red-50/30' : ''}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${style.badge}`}>
          {score.toFixed(0)}%
        </span>
        <span className="text-sm text-slate-700 flex-1 truncate">{result.golden_config_name}</span>
        <div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden shrink-0">
          <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: style.bar }} />
        </div>
        <span className="text-xs text-slate-400 shrink-0 w-24 text-right">{result.matched_lines}/{result.total_lines} lines</span>
        <span className="text-xs text-slate-400 shrink-0">{formatAge(result.checked_at)}</span>
        <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      {open && (
        <div className="px-5 pb-4">
          {result.missing_lines.length === 0 ? (
            <p className="text-xs text-green-600 px-3 py-2">All golden lines present.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Missing lines ({result.missing_lines.length})</p>
              {result.missing_lines.map((line, i) => (
                <div key={i} className="font-mono text-[11px] text-red-700 bg-red-50 px-3 py-1.5 rounded-lg whitespace-pre-wrap">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DeviceConfigTab({ deviceId, vendor, hostname }: { deviceId: string; vendor?: string; hostname?: string }) {
  const qc = useQueryClient()
  const [view, setView] = useState<'history' | 'compliance' | 'deploy'>('history')
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null)
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null)
  const [selectedGitCommit, setSelectedGitCommit] = useState<string | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<ConfigBackupMeta | null>(null)

  const { data: status } = useQuery({
    queryKey: ['config-status', deviceId],
    queryFn:  () => fetchConfigStatus(deviceId),
    refetchInterval: 30_000,
  })

  const { data: backups = [] } = useQuery({
    queryKey: ['config-backups', deviceId],
    queryFn:  () => fetchBackups(deviceId),
    enabled:  view === 'history',
  })

  const { data: diffs = [] } = useQuery({
    queryKey: ['config-diffs', deviceId],
    queryFn:  () => fetchDiffs(deviceId),
    enabled:  view === 'history',
  })

  const { data: selectedDiff } = useQuery({
    queryKey: ['config-diff', selectedDiffId],
    queryFn:  () => fetchDiff(selectedDiffId!),
    enabled:  !!selectedDiffId,
  })

  const { data: selectedBackup } = useQuery({
    queryKey: ['config-backup', selectedBackupId],
    queryFn:  () => fetchBackup(selectedBackupId!),
    enabled:  !!selectedBackupId,
  })

  const { data: compliance = [] } = useQuery({
    queryKey: ['compliance-results', deviceId],
    queryFn:  () => fetchComplianceResults(deviceId),
    enabled:  view === 'compliance',
  })

  const { data: goldenResults = [] } = useQuery({
    queryKey: ['golden-config-results', deviceId],
    queryFn:  () => fetchGoldenConfigResults(deviceId),
    enabled:  view === 'compliance',
  })

  const { data: gitLog = [] } = useQuery({
    queryKey: ['git-log', deviceId],
    queryFn:  () => fetchGitLog(deviceId),
    enabled:  view === 'history',
  })

  const { data: gitShow } = useQuery({
    queryKey: ['git-show', deviceId, selectedGitCommit],
    queryFn:  () => fetchGitShow(deviceId, selectedGitCommit!),
    enabled:  !!selectedGitCommit,
  })

  const handleCollect = async () => {
    setCollecting(true)
    try {
      await triggerCollect(deviceId)
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['config-status', deviceId] })
        qc.invalidateQueries({ queryKey: ['config-backups', deviceId] })
        qc.invalidateQueries({ queryKey: ['config-diffs', deviceId] })
        setCollecting(false)
      }, 5000)
    } catch {
      setCollecting(false)
    }
  }

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
  }

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4 text-sm">
          {status?.has_backup ? (
            <>
              <span className="text-slate-600" title="Config is polled hourly — only changes are stored as snapshots">
                Last change: <span className="font-medium">{status.last_collected ? fmtTime(status.last_collected) : '—'}</span>
              </span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-600">{status.backup_count} snapshots</span>
              {status.compliance_total > 0 && (
                <>
                  <span className="text-slate-400">·</span>
                  <span className={status.compliance_fail_count > 0 ? 'text-red-600 font-medium' : 'text-green-600'}>
                    {status.compliance_fail_count > 0
                      ? `${status.compliance_fail_count}/${status.compliance_total} compliance failures`
                      : `${status.compliance_total} policies passing`}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="text-slate-400">No config captured yet</span>
          )}
        </div>
        <button onClick={handleCollect} disabled={collecting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50">
          <svg className={`w-3.5 h-3.5 ${collecting ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/>
          </svg>
          {collecting ? 'Collecting…' : 'Collect now'}
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-slate-100">
        {(['history', 'compliance', 'deploy'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`px-4 py-2 text-xs font-medium capitalize border-b-2 transition-colors ${
              view === v ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {v}
          </button>
        ))}
      </div>

      {view === 'history' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Backup timeline */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Snapshots</h3>
              <span className="text-xs text-slate-400">{backups.length} total</span>
            </div>
            {backups.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-400">No snapshots yet</div>
            ) : (
              <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
                {backups.map(b => (
                  <div key={b.id}
                    onClick={() => { setSelectedBackupId(b.id === selectedBackupId ? null : b.id); setSelectedDiffId(null); setSelectedGitCommit(null) }}
                    className={`w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left cursor-pointer ${selectedBackupId === b.id ? 'bg-blue-50' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-700">{fmtTime(b.collected_at)}</div>
                      <div className="text-[10px] font-mono text-slate-400 mt-0.5">{b.config_hash.slice(0, 12)}… · {(b.size_bytes / 1024).toFixed(1)} KB</div>
                    </div>
                    {b.is_latest ? (
                      <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded shrink-0">latest</span>
                    ) : rollbackSupported(vendor) ? (
                      <button
                        onClick={e => { e.stopPropagation(); setRollbackTarget(b) }}
                        className="text-[10px] font-semibold text-amber-700 border border-amber-200 bg-amber-50 hover:bg-amber-100 rounded px-2 py-0.5 transition-colors shrink-0"
                        title="Roll the device's running config back to this snapshot"
                      >
                        ⟲ Rollback
                      </button>
                    ) : (
                      <button
                        disabled
                        onClick={e => e.stopPropagation()}
                        className="text-[10px] font-semibold text-slate-400 border border-slate-200 bg-slate-50 rounded px-2 py-0.5 shrink-0 cursor-not-allowed"
                        title={`Rollback isn't available for ${vendor ?? 'this vendor'} — ProCurve needs TFTP; FortiOS/Ubiquiti need vendor APIs. HTTP config-replace isn't supported on this platform.`}
                      >
                        ⟲ Rollback
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Config viewer / diff viewer */}
          <div className="space-y-4">
            {/* Changes */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Changes</h3>
                <span className="text-xs text-slate-400">{diffs.length} recorded</span>
              </div>
              {diffs.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-slate-400">No changes detected yet</div>
              ) : (
                <div className="divide-y divide-slate-50 max-h-48 overflow-y-auto">
                  {diffs.map(d => (
                    <button key={d.id} onClick={() => { setSelectedDiffId(d.id === selectedDiffId ? null : d.id); setSelectedBackupId(null); setSelectedGitCommit(null) }}
                      className={`w-full flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50 transition-colors text-left ${selectedDiffId === d.id ? 'bg-blue-50' : ''}`}>
                      <div className="flex-1">
                        <div className="text-xs font-medium text-slate-700">{fmtTime(d.created_at)}</div>
                      </div>
                      <span className="text-[10px] text-green-600 font-mono">+{d.lines_added}</span>
                      <span className="text-[10px] text-red-500 font-mono">-{d.lines_removed}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Git history */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Git history</h3>
                <span className="text-xs text-slate-400">{gitLog.length} commit{gitLog.length !== 1 ? 's' : ''}</span>
              </div>
              {gitLog.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-slate-400">No git history yet</div>
              ) : (
                <div className="divide-y divide-slate-50 max-h-48 overflow-y-auto">
                  {gitLog.map(c => {
                    const triggeredBy = c.body.split('\n').find(l => l.startsWith('Triggered-by:'))?.replace('Triggered-by:', '').trim()
                    return (
                      <button key={c.hash} onClick={() => { setSelectedGitCommit(c.hash === selectedGitCommit ? null : c.hash); setSelectedDiffId(null); setSelectedBackupId(null) }}
                        className={`w-full flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50 transition-colors text-left ${selectedGitCommit === c.hash ? 'bg-blue-50' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-slate-700 truncate">{c.subject}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{fmtTime(c.date)}{triggeredBy ? ` · ${triggeredBy}` : ''}</div>
                        </div>
                        <span className="text-[10px] font-mono text-slate-400 shrink-0">{c.hash.slice(0, 8)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Selected diff, backup, or git revision text */}
            {selectedDiff && (
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Diff</h3>
                  <button onClick={() => setSelectedDiffId(null)} className="text-slate-300 hover:text-slate-500">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <pre className="p-4 text-[11px] font-mono overflow-auto max-h-72 bg-slate-950 text-slate-300 leading-relaxed">
                  {selectedDiff.diff_text.split('\n').map((line, i) => (
                    <div key={i} className={
                      line.startsWith('+') && !line.startsWith('+++') ? 'text-green-400' :
                      line.startsWith('-') && !line.startsWith('---') ? 'text-red-400' :
                      line.startsWith('@@') ? 'text-blue-400' : ''
                    }>{line}</div>
                  ))}
                </pre>
              </div>
            )}

            {selectedBackup && !selectedDiff && (
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Config — {fmtTime(selectedBackup.collected_at)}</h3>
                  <button onClick={() => setSelectedBackupId(null)} className="text-slate-300 hover:text-slate-500">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <pre className="p-4 text-[11px] font-mono overflow-auto max-h-96 bg-slate-950 text-green-400 leading-relaxed">{selectedBackup.config_text}</pre>
              </div>
            )}

            {gitShow && !selectedDiff && !selectedBackup && (
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Config @ {gitShow.commit.slice(0, 10)}</h3>
                  <button onClick={() => setSelectedGitCommit(null)} className="text-slate-300 hover:text-slate-500">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <pre className="p-4 text-[11px] font-mono overflow-auto max-h-96 bg-slate-950 text-green-400 leading-relaxed">{gitShow.config_text}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'compliance' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Compliance</h3>
              <Link to="/config" className="text-xs text-blue-600 hover:underline">Manage policies →</Link>
            </div>
            {compliance.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-400">
                No compliance results — <Link to="/config" className="text-blue-600 hover:underline">create a policy</Link> to get started
              </div>
            ) : (
              <div className="divide-y divide-slate-50">
                {compliance.map(r => (
                  <div key={r.id} className="px-5 py-3 flex items-center gap-3">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize shrink-0 ${
                      r.status === 'pass' ? 'bg-green-100 text-green-700' : r.status === 'fail' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'
                    }`}>{r.status}</span>
                    <span className="text-sm text-slate-700 flex-1">{r.policy_name}</span>
                    {r.status === 'fail' && (
                      <span className="text-xs text-red-500">{r.findings.filter((f: any) => f.status === 'fail').length} failing</span>
                    )}
                    <span className="text-xs text-slate-400">{new Date(r.checked_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Golden config drift */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Golden config drift</h3>
              <Link to="/config" className="text-xs text-blue-600 hover:underline">Manage golden configs →</Link>
            </div>
            {goldenResults.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-400">
                No golden config results — <Link to="/config" className="text-blue-600 hover:underline">create a golden config</Link> to get started
              </div>
            ) : (
              <div className="divide-y divide-slate-50">
                {goldenResults.map(r => <DeviceGoldenResultRow key={r.id} result={r} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'deploy' && (
        <DeployPanel deviceId={deviceId} vendor={vendor} />
      )}

      {rollbackTarget && (
        <RollbackModal
          deviceId={deviceId}
          deviceHostname={hostname ?? ''}
          target={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
          onSuccess={() => {
            setRollbackTarget(null)
            qc.invalidateQueries({ queryKey: ['config-backups', deviceId] })
            qc.invalidateQueries({ queryKey: ['config-diffs', deviceId] })
          }}
        />
      )}
    </div>
  )
}

// ── Rollback modal ────────────────────────────────────────────────────────────

function RollbackModal({
  deviceId, deviceHostname, target, onClose, onSuccess,
}: {
  deviceId: string
  deviceHostname: string
  target:   ConfigBackupMeta
  onClose:  () => void
  onSuccess: () => void
}) {
  const fmtTime = (iso: string) => new Date(iso).toLocaleString()
  const [reason, setReason]   = useState('')
  const [save, setSave]       = useState(true)
  const [hostConfirm, setHostConfirm] = useState('')
  const [busy, setBusy]       = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError]     = useState<string | null>(null)
  const [result, setResult]   = useState<{vendor: string; vrf: string; output: string} | null>(null)

  // Tick a 1-second elapsed counter while the rollback is in flight.  The device
  // fetches the snapshot over HTTP and applies its native replace — Aruba CX in
  // particular can take a couple of minutes — this lets the operator see the
  // request is still active rather than staring at a frozen spinner.
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const start = Date.now()
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [busy])

  // Pull both the target backup and the current latest so we can render a diff preview.
  const { data: targetFull } = useQuery({
    queryKey: ['config-backup', target.id],
    queryFn:  () => fetchBackup(target.id),
  })
  const { data: backups = [] } = useQuery({
    queryKey: ['config-backups', deviceId],
    queryFn:  () => fetchBackups(deviceId),
  })
  const latest = backups.find(b => b.is_latest)
  const { data: latestFull } = useQuery({
    queryKey: ['config-backup', latest?.id],
    queryFn:  () => fetchBackup(latest!.id),
    enabled:  !!latest,
  })

  const diff = useMemo(() => {
    if (!targetFull?.config_text || !latestFull?.config_text) return null
    const curLines = latestFull.config_text.split('\n')
    const tgtLines = targetFull.config_text.split('\n')
    const curSet = new Set(curLines)
    const tgtSet = new Set(tgtLines)
    const removed = curLines.filter(l => !tgtSet.has(l) && l.trim())
    const added   = tgtLines.filter(l => !curSet.has(l) && l.trim())
    return { added, removed }
  }, [targetFull, latestFull])

  const hostMatch = hostConfirm === deviceHostname

  async function doRollback() {
    if (!reason.trim()) {
      setError('Please provide a reason — it goes to the audit log.')
      return
    }
    if (!hostMatch) {
      setError(`Type the device hostname exactly to confirm: ${deviceHostname}`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await rollbackConfig(deviceId, target.id, reason, deviceHostname, save)
      setResult({ vendor: r.vendor, vrf: r.vrf, output: r.output })
    } catch (e) {
      const err = e as { response?: { data?: { detail?: string } } }
      setError(err.response?.data?.detail ?? (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">Roll back to snapshot</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {fmtTime(target.collected_at)} — <span className="font-mono">{target.config_hash.slice(0, 12)}…</span>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="text-slate-300 hover:text-slate-500 text-xl leading-none">×</button>
        </div>

        {result ? (
          <div className="p-6 flex-1 overflow-y-auto">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4">
              <p className="text-sm font-semibold text-emerald-700">✓ Rollback applied</p>
              <p className="text-xs text-emerald-600 mt-1">{result.vendor} native config-replace over HTTP via the <span className="font-mono">{result.vrf}</span> table, {save ? 'saved to startup-config' : 'running-config only — not saved'}.</p>
            </div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Device output</p>
            <pre className="text-[11px] font-mono bg-slate-50 border border-slate-100 rounded-lg p-3 max-h-72 overflow-y-auto whitespace-pre-wrap">{result.output || '(no output)'}</pre>
            <div className="mt-4 flex justify-end">
              <button onClick={() => { onSuccess() }} className="text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-4 py-2 transition-colors">Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-6 flex-1 overflow-y-auto space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs">
                <p className="font-semibold text-amber-800 mb-1">⚠ Vendor-native config replace</p>
                <p className="text-amber-700 leading-relaxed">
                  The hub instructs the device to fetch this snapshot over HTTP and apply it
                  with its own atomic replace command (<span className="font-mono">configure replace</span> on
                  Cisco/Arista, a <span className="font-mono">checkpoint</span> replace on Aruba CX,
                  <span className="font-mono"> load override</span> + <span className="font-mono">commit</span> on
                  Juniper). This is a true replace — anything in the running config but not in
                  this snapshot <span className="font-semibold">will be removed</span>. Review the diff
                  below before confirming.
                </p>
              </div>

              {diff && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-slate-100 rounded-lg overflow-hidden">
                    <div className="px-3 py-1.5 bg-red-50 text-[10px] font-semibold text-red-600 uppercase tracking-wide">
                      Will be removed ({diff.removed.length} lines)
                    </div>
                    <pre className="text-[11px] font-mono p-3 max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-700">
                      {diff.removed.slice(0, 100).join('\n') || '(none)'}
                      {diff.removed.length > 100 && `\n… ${diff.removed.length - 100} more`}
                    </pre>
                  </div>
                  <div className="border border-slate-100 rounded-lg overflow-hidden">
                    <div className="px-3 py-1.5 bg-emerald-50 text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">
                      Will reintroduce ({diff.added.length} lines)
                    </div>
                    <pre className="text-[11px] font-mono p-3 max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-700">
                      {diff.added.slice(0, 100).join('\n') || '(none)'}
                      {diff.added.length > 100 && `\n… ${diff.added.length - 100} more`}
                    </pre>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={2}
                  placeholder="Why are you rolling back? This is audit-logged."
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-slate-400"
                />
              </div>

              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="font-semibold text-slate-700">Save to startup-config after deploy</span>
                  <span className="block text-slate-400 mt-0.5">Persist the change so it survives reboot. Uncheck to test in running-config only.</span>
                </span>
              </label>

              <div className="border-t border-slate-100 pt-4">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Type the device hostname to confirm <span className="text-red-500">*</span>
                </label>
                <p className="text-[11px] text-slate-500 mb-2">
                  Type <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{deviceHostname}</span> exactly. This is the only safeguard against rolling back the wrong device.
                </p>
                <input
                  value={hostConfirm}
                  onChange={e => setHostConfirm(e.target.value)}
                  placeholder={deviceHostname}
                  className={`w-full text-sm font-mono border rounded-lg px-3 py-2 focus:outline-none transition-colors ${
                    hostConfirm === ''      ? 'border-slate-200 focus:border-slate-400' :
                    hostMatch                ? 'border-emerald-400 bg-emerald-50' :
                                               'border-red-300 bg-red-50'
                  }`}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-3 bg-slate-50">
              <button onClick={onClose} disabled={busy}
                className="text-sm font-semibold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 rounded-lg px-4 py-2 disabled:opacity-50">
                Cancel
              </button>
              {busy && (
                <span className="text-[11px] text-slate-500 flex-1 text-center">
                  {deviceHostname} is fetching the snapshot over HTTP and replacing its config —
                  Aruba CX can take a minute or two. Don't close this tab.
                </span>
              )}
              <button onClick={doRollback} disabled={busy || !reason.trim() || !hostMatch}
                className="text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2">
                {busy ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-amber-200 border-t-white rounded-full animate-spin" />
                    Rolling back… {Math.floor(elapsed / 60)}m {elapsed % 60}s
                  </>
                ) : (
                  '⟲ Confirm rollback'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Deploy panel ──────────────────────────────────────────────────────────────

// Vendor-specific snippet library (mirrored from ConfigPage)
const DEVICE_SNIPPETS: Record<string, { label: string; text: string }[]> = {
  arista:    [
    { label: 'NTP server',     text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',         text: 'logging host {{syslog_server}}' },
    { label: 'SSH timeout',    text: 'management ssh\n   idle-timeout 120' },
    { label: 'Banner',         text: 'banner login\nAuthorized access only.\nEOF' },
    { label: 'SNMP community', text: 'snmp-server community {{community}} ro' },
    { label: 'DNS',            text: 'ip name-server {{dns_server}}' },
  ],
  cisco:     [
    { label: 'NTP server',     text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',         text: 'logging host {{syslog_server}}' },
    { label: 'SSH v2',         text: 'ip ssh version 2' },
    { label: 'Banner',         text: 'banner login #\nAuthorized access only.\n#' },
    { label: 'SNMP community', text: 'snmp-server community {{community}} RO' },
    { label: 'DNS',            text: 'ip name-server {{dns_server}}' },
  ],
  procurve:  [
    { label: 'NTP server',     text: 'timesync ntp\nntp server {{ntp_server}}' },
    { label: 'Syslog',         text: 'logging {{syslog_server}}' },
    { label: 'Banner',         text: 'banner motd "Authorized access only"' },
    { label: 'SNMP community', text: 'snmp-server community "{{community}}" operator' },
    { label: 'DNS',            text: 'ip dns server-address priority 1 {{dns_server}}' },
  ],
  juniper:   [
    { label: 'NTP server',     text: 'set system ntp server {{ntp_server}}' },
    { label: 'Syslog',         text: 'set system syslog host {{syslog_server}} any any' },
    { label: 'SSH',            text: 'set system services ssh' },
    { label: 'Banner',         text: 'set system login message "Authorized access only"' },
    { label: 'SNMP',           text: 'set snmp community {{community}} authorization read-only' },
  ],
  fortios:   [
    { label: 'NTP',            text: 'config system ntp\n  set ntpserver1 {{ntp_server}}\n  set status enable\nend' },
    { label: 'Syslog',         text: 'config log syslogd setting\n  set status enable\n  set server {{syslog_server}}\nend' },
  ],
  generic:   [
    { label: 'NTP server',     text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog server',  text: 'logging host {{syslog_server}}' },
    { label: 'Iface shutdown', text: 'interface {{interface}}\n  shutdown' },
    { label: 'SNMP community', text: 'snmp-server community {{community}} ro' },
  ],
}

function deviceSnippets(vendor?: string) {
  if (!vendor) return DEVICE_SNIPPETS.generic
  const v = vendor.toLowerCase()
  for (const [key, snips] of Object.entries(DEVICE_SNIPPETS)) {
    if (v.includes(key) || key.includes(v)) return snips
  }
  return DEVICE_SNIPPETS.generic
}

function DeployPanel({ deviceId, vendor }: { deviceId: string; vendor?: string }) {
  const snippets = deviceSnippets(vendor)
  const [commands, setCommands]   = useState('')
  const [variables, setVariables] = useState<{ key: string; value: string }[]>([
    { key: 'ntp_server',    value: '' },
    { key: 'syslog_server', value: '' },
  ])
  const [save, setSave]           = useState(true)
  const [output, setOutput]       = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)

  const varMap = Object.fromEntries(variables.filter(v => v.key && v.value).map(v => [v.key, v.value]))

  const handleDeploy = async () => {
    const lines = commands.split('\n').filter(l => l.trim())
    if (!lines.length) return
    setDeploying(true); setOutput(null); setError(null)
    try {
      const result = await deployConfig(deviceId, lines, save)
      setOutput(result.output || '(no output)')
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? String(e))
    } finally {
      setDeploying(false)
    }
  }

  const inputCls = "border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        <p className="text-xs text-amber-700">
          Commands are pushed via SSH in config mode. Supports <code className="bg-amber-100 px-0.5 rounded">{'{{variable}}'}</code> substitution.
          A config snapshot is captured automatically after deploy.
        </p>
      </div>

      {/* Vendor-aware quick insert */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-slate-500">
            Quick insert
            {vendor && <span className="ml-1.5 text-slate-300 capitalize">· {vendor}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {snippets.map(s => (
            <button key={s.label} type="button"
              onClick={() => setCommands(c => c ? c + '\n' + s.text : s.text)}
              className="px-2 py-0.5 rounded-md text-[11px] border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
              + {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Template variables */}
      <div className="border border-slate-200 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-slate-500">Variables <span className="font-normal text-slate-400">— use <code className="bg-slate-100 px-0.5 rounded text-[10px]">{'{{var}}'}</code> in commands</span></p>
          <button onClick={() => setVariables(v => [...v, { key: '', value: '' }])} className="text-[10px] text-blue-600 hover:underline">+ Add</button>
        </div>
        {variables.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={v.key} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,key:e.target.value} : x))}
              placeholder="name" className={`${inputCls} w-28 font-mono`} />
            <span className="text-slate-400 text-xs">=</span>
            <input value={v.value} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,value:e.target.value} : x))}
              placeholder="value" className={`${inputCls} flex-1`} />
            <button onClick={() => setVariables(vs => vs.filter((_,j) => j!==i))} aria-label="Remove variable" className="text-slate-300 hover:text-red-400 text-xs">✕</button>
          </div>
        ))}
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1.5">
          Commands <span className="text-slate-400 font-normal">— one per line, no configure/end needed</span>
        </label>
        <textarea
          value={commands}
          onChange={e => setCommands(e.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={'ntp server {{ntp_server}}\nlogging host {{syslog_server}}'}
          className="w-full border border-slate-200 rounded-xl px-4 py-3 font-mono text-xs bg-slate-950 text-green-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y leading-relaxed"
        />
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)}
            className="rounded border-slate-300 text-blue-600" />
          <span className="text-xs text-slate-600">Save to startup config after deploy</span>
        </label>
        <button onClick={handleDeploy} disabled={deploying || !commands.trim()}
          className="ml-auto flex items-center gap-1.5 px-4 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {deploying ? (
            <><span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />Deploying…</>
          ) : (
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>Deploy</>
          )}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 font-mono whitespace-pre-wrap">{error}</div>
      )}

      {output !== null && !error && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs font-semibold text-slate-600">Deploy output</span>
          </div>
          <pre className="p-4 text-[11px] font-mono bg-slate-950 text-green-400 overflow-auto max-h-72 leading-relaxed whitespace-pre-wrap">{output}</pre>
        </div>
      )}
    </div>
  )
}

// ── Traps tab ─────────────────────────────────────────────────────────────────

function TrapTab({ deviceId }: { deviceId: string }) {
  const [days, setDays] = useState(7)
  const { data, isLoading } = useQuery({
    queryKey:  ['device-traps', deviceId, days],
    queryFn:   () => fetchDeviceTraps(deviceId, days),
    staleTime: 30_000,
  })

  const items = data?.items ?? []

  const sevColor: Record<string, string> = {
    critical: 'bg-red-100 text-red-700',
    warning:  'bg-amber-100 text-amber-700',
    info:     'bg-slate-100 text-slate-600',
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-slate-600">SNMP Traps</span>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="ml-auto text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
        >
          <option value={1}>Last 24 h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {isLoading ? (
        <div className="text-xs text-slate-400 py-4 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-slate-400 py-8 text-center">No trap events in this period</div>
      ) : (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-3 py-2 text-left font-semibold text-slate-500 w-36">Time</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-500">Trap type</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-500">Severity</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-500">Ver</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-500">OID</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t, i) => (
                <tr key={t.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                  <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap font-mono text-[11px]">
                    {new Date(t.received_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-800">{t.trap_type}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${sevColor[t.severity] ?? sevColor.info}`}>
                      {t.severity}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">{t.snmp_version}</td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-400 truncate max-w-[180px]" title={t.oid}>
                    {t.oid_name ?? t.oid}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
