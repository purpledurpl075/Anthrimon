import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow, Controls, Background, MiniMap,
  useNodesState, useEdgesState, Handle, Position,
  type NodeProps, type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchDevice, fetchDeviceHealth, fetchDeviceHealthHistory, fetchDeviceInterfaces, deleteDevice, patchDevice, setAlertExclusions, fetchDeviceCredentials, linkDeviceCredential, unlinkDeviceCredential, runSnmpDiag, fetchDeviceNeighbors, fetchDeviceOSPF, fetchDeviceAddresses, fetchDeviceRoutes, fetchDeviceVlans, fetchDeviceStp, type AddressEntry, type VlanEntry, type StpPort } from '../api/devices'
import TimeSeriesChart from '../components/TimeSeriesChart'
import { fetchCredentials } from '../api/credentials'
import { fetchConfigStatus, fetchBackups, fetchDiffs, fetchBackup, fetchDiff, triggerCollect, fetchComplianceResults, deployConfig, type ConfigBackupMeta, type ConfigDiffMeta } from '../api/config'
import { fetchCollectors } from '../api/collectors'
import { fetchDeviceBGPSessions, fetchBGPSessionEvents, type BGPSession, type BGPSessionEvent } from '../api/bgp'
import { fetchMaintenanceWindows, createMaintenanceWindow, deleteMaintenanceWindow, type MaintenanceWindow } from '../api/maintenance'
import StatusBadge from '../components/StatusBadge'
import VendorBadge from '../components/VendorBadge'
import { DeviceTypeIcon, DEVICE_TYPE_COLOR, DEVICE_TYPE_LABEL } from '../components/DeviceTypeIcon'

function formatUptime(secs: number | string | null) {
  if (!secs) return '—'
  const s = Number(secs)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

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
                          {s.flap_count > 0 && <span className="text-amber-500">{s.flap_count} flaps</span>}
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
            <button onClick={() => setConfirmDel(a.credential_id)} className="text-slate-400 hover:text-red-500">✕</button>
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

const HEALTH_RANGES = [{ label: '1h', hours: 1 }, { label: '6h', hours: 6 }, { label: '24h', hours: 24 }]

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

      {/* DOM / Optical temperature sensors */}
      {/* Optical transceivers — power + temperature combined per port */}
      {(() => {
        const domIfaces = Array.from(new Set([
          ...domTemps.map(t => t.sensor.replace(/DOM Temperature Sensor for /i, '').trim()),
          ...Object.keys(hist?.dom_tx ?? {}),
          ...Object.keys(hist?.dom_rx ?? {}),
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
                const txNow = hist?.dom_tx?.[iface]?.at(-1)?.[1] ?? null
                const rxNow = hist?.dom_rx?.[iface]?.at(-1)?.[1] ?? null
                const txSeries = (hist?.dom_tx?.[iface] ?? []) as [number,number][]
                const rxSeries = (hist?.dom_rx?.[iface] ?? []) as [number,number][]
                const hasPower = txNow !== null || rxNow !== null || txSeries.length > 0

                return (
                  <div key={iface} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                      <svg className="w-3.5 h-3.5 text-cyan-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
                      </svg>
                      <span className="text-xs font-semibold text-slate-700">{iface}</span>
                      {tempEntry && (
                        <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${tempEntry.ok ? 'bg-slate-100 text-slate-500' : 'bg-red-100 text-red-600'}`}>
                          {tempEntry.celsius}°C
                        </span>
                      )}
                    </div>

                    <div className="px-4 py-3 space-y-2">
                      {/* Tx / Rx power current values */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Tx Power</p>
                          <p className={`text-lg font-bold ${txNow === null ? 'text-slate-300' : txNow < -30 ? 'text-red-600' : 'text-slate-800'}`}>
                            {txNow !== null ? `${txNow.toFixed(2)} dBm` : '—'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Rx Power</p>
                          <p className={`text-lg font-bold ${rxNow === null ? 'text-slate-300' : rxNow < -30 ? 'text-red-600' : 'text-slate-800'}`}>
                            {rxNow !== null ? `${rxNow.toFixed(2)} dBm` : '—'}
                          </p>
                        </div>
                      </div>

                      {/* Sparkline for Tx + Rx power history */}
                      {hasPower && (txSeries.length >= 2 || rxSeries.length >= 2) && (
                        <TimeSeriesChart height={52} yFmt={v => `${v.toFixed(1)}`}
                          series={[
                            ...(txSeries.length >= 2 ? [{ name: 'Tx', color: '#0891b2', data: txSeries }] : []),
                            ...(rxSeries.length >= 2 ? [{ name: 'Rx', color: '#f59e0b', data: rxSeries }] : []),
                          ]} />
                      )}

                      {!hasPower && (
                        <p className="text-[10px] text-slate-400">Optical power data will appear after the next collector poll.</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {temps.length === 0 && !currentHealth && (
        <div className="text-center py-8 text-slate-400 text-sm">No health data available yet.</div>
      )}
    </div>
  )
}

function formatAge(iso: string | null) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 120) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
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
  const [tab, setTab] = useState<'interfaces' | 'neighbors' | 'addresses' | 'routes' | 'vlans' | 'stp' | 'health' | 'config' | 'bgp'>('interfaces')

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

  const { data: device, isLoading, isError } = useQuery({
    queryKey: ['device', id],
    queryFn: () => fetchDevice(id!),
    enabled: !!id,
  })

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
  if (isError) return <div className="p-8 text-red-600">Failed to load device.</div>

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
                      <button onClick={() => removeTag(tag)} className="text-slate-400 hover:text-red-500 leading-none">×</button>
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

        {/* Tabbed panel */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="border-b border-slate-100 px-2 md:px-4 flex items-center gap-0 overflow-x-auto scrollbar-hide"
            style={{ WebkitOverflowScrolling: 'touch' }}>
            {([
              { id: 'interfaces', label: 'Interfaces', badge: totalIfaces || undefined },
              { id: 'neighbors',  label: 'Neighbors' },
              { id: 'addresses',  label: 'Addresses' },
              { id: 'routes',     label: 'Routes' },
              { id: 'vlans',      label: 'VLANs' },
              { id: 'stp',        label: 'STP' },
              { id: 'health',     label: 'Health' },
              ...(bgpCount > 0 ? [{ id: 'bgp' as const, label: 'BGP', badge: bgpCount, badgeAlert: bgpDownCount > 0 }] : []),
              { id: 'config',     label: 'Config' },
            ] as { id: typeof tab; label: string; badge?: number; badgeAlert?: boolean }[]).map(t => (
              <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
                className={`flex items-center gap-1 px-2.5 md:px-3 py-2.5 md:py-3 text-xs md:text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  tab === t.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {t.label}
                {t.badge ? (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                    t.badgeAlert
                      ? 'bg-red-100 text-red-600'
                      : tab === t.id ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                  }`}>{t.badge}</span>
                ) : null}
              </button>
            ))}
          </div>

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
                      return (
                        <tr
                          key={iface.id}
                          className="hover:bg-blue-50/40 cursor-pointer group transition-colors"
                          onClick={() => navigate(`/devices/${id}/interfaces/${iface.id}`)}
                        >
                          <td className="px-4 py-2 font-medium text-slate-700 font-mono text-sm group-hover:text-blue-600 transition-colors">{iface.name}</td>
                          <td className="px-4 py-2 text-slate-500 max-w-[180px] truncate text-xs hidden md:table-cell">{iface.description ?? '—'}</td>
                          <td className="px-4 py-2 text-slate-600 text-sm">{formatSpeed(iface.speed_bps)}</td>
                          <td className="px-4 py-2"><StatusBadge status={iface.admin_status} /></td>
                          <td className="px-4 py-2"><StatusBadge status={iface.oper_status} /></td>
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
              <DeviceConfigTab deviceId={id} vendor={device?.vendor} />
            </div>
          )}
        </div>

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

function BGPEventDrawer({ session }: { session: BGPSession }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey:  ['bgp-events', session.id],
    queryFn:   () => fetchBGPSessionEvents(session.id),
    staleTime: 60_000,
  })

  const STATE_COLOR: Record<string, string> = {
    established: 'text-green-700 bg-green-50',
    active:      'text-amber-700 bg-amber-50',
    idle:        'text-slate-600 bg-slate-100',
    connect:     'text-blue-700 bg-blue-50',
    opensent:    'text-purple-700 bg-purple-50',
    openconfirm: 'text-purple-700 bg-purple-50',
  }

  return (
    <tr>
      <td colSpan={8} className="bg-slate-50 px-6 py-3 border-b border-slate-100">
        <div className="text-xs font-medium text-slate-500 mb-2">State transition history</div>
        {isLoading ? (
          <span className="text-xs text-slate-400">Loading…</span>
        ) : events.length === 0 ? (
          <span className="text-xs text-slate-400">No transitions recorded yet</span>
        ) : (
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
            {events.map(e => (
              <div key={e.id} className="flex items-center gap-2 text-xs">
                <span className="text-slate-400 tabular-nums w-36 shrink-0">
                  {new Date(e.recorded_at).toLocaleString()}
                </span>
                <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${STATE_COLOR[e.prev_state] ?? 'text-slate-600 bg-slate-100'}`}>
                  {e.prev_state}
                </span>
                <span className="text-slate-400">→</span>
                <span className={`px-1.5 py-0.5 rounded capitalize font-medium ${STATE_COLOR[e.new_state] ?? 'text-slate-600 bg-slate-100'}`}>
                  {e.new_state}
                </span>
              </div>
            ))}
          </div>
        )}
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
  const flappers    = sessions.filter(s => s.flap_count > 0).length

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
                    <td className="px-4 py-3 text-xs text-slate-600 text-right tabular-nums">
                      {s.prefixes_received ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 text-right tabular-nums">
                      {s.in_updates > 0 || s.out_updates > 0
                        ? `${s.in_updates.toLocaleString()} / ${s.out_updates.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.flap_count > 0 ? (
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
                  {expanded === s.id && <BGPEventDrawer session={s} />}
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

function DeviceConfigTab({ deviceId, vendor }: { deviceId: string; vendor?: string }) {
  const qc = useQueryClient()
  const [view, setView] = useState<'history' | 'compliance' | 'deploy'>('history')
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null)
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null)
  const [collecting, setCollecting] = useState(false)

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
              <span className="text-slate-600">
                Last backup: <span className="font-medium">{status.last_collected ? fmtTime(status.last_collected) : '—'}</span>
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
            <span className="text-slate-400">No config backup yet</span>
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
              <div className="px-5 py-8 text-center text-sm text-slate-400">No backups yet</div>
            ) : (
              <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
                {backups.map(b => (
                  <button key={b.id} onClick={() => setSelectedBackupId(b.id === selectedBackupId ? null : b.id)}
                    className={`w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left ${selectedBackupId === b.id ? 'bg-blue-50' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-700">{fmtTime(b.collected_at)}</div>
                      <div className="text-[10px] font-mono text-slate-400 mt-0.5">{b.config_hash.slice(0, 12)}… · {(b.size_bytes / 1024).toFixed(1)} KB</div>
                    </div>
                    {b.is_latest && <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded shrink-0">latest</span>}
                  </button>
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
                    <button key={d.id} onClick={() => setSelectedDiffId(d.id === selectedDiffId ? null : d.id)}
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

            {/* Selected diff or backup text */}
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
          </div>
        </div>
      )}

      {view === 'compliance' && (
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
      )}

      {view === 'deploy' && (
        <DeployPanel deviceId={deviceId} vendor={vendor} />
      )}
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
          A backup is taken automatically after deploy.
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
            <button onClick={() => setVariables(vs => vs.filter((_,j) => j!==i))} className="text-slate-300 hover:text-red-400 text-xs">✕</button>
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
