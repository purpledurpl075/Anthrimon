/**
 * Shared network device type icons.
 * Use everywhere a device_type needs a visual indicator.
 */

interface IconProps {
  size?: number
  className?: string
  style?: React.CSSProperties
}

const base = (size = 20) => ({
  width:  size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

// Router — chassis with 4-way routing arrows (the universal router glyph)
export function RouterIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      {/* central chassis */}
      <rect x="6.5" y="6.5" width="11" height="11" rx="3"/>
      {/* arrows radiating to the four directions */}
      <path d="M12 6.5V2.5M10.6 3.9 12 2.5l1.4 1.4"/>
      <path d="M12 17.5v4M10.6 20.1 12 21.5l1.4-1.4"/>
      <path d="M6.5 12H2.5M3.9 10.6 2.5 12l1.4 1.4"/>
      <path d="M17.5 12h4M20.1 10.6 21.5 12l-1.4 1.4"/>
    </svg>
  )
}

// Switch — clean 1U chassis with a row of front ports
export function SwitchIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <rect x="2" y="8.5" width="20" height="8" rx="2"/>
      <rect x="4.6"  y="11.2" width="2" height="3" rx="0.5"/>
      <rect x="7.6"  y="11.2" width="2" height="3" rx="0.5"/>
      <rect x="10.6" y="11.2" width="2" height="3" rx="0.5"/>
      <rect x="13.6" y="11.2" width="2" height="3" rx="0.5"/>
      <rect x="16.6" y="11.2" width="2" height="3" rx="0.5"/>
    </svg>
  )
}

// Access point — concentric Wi-Fi waves over a node
export function AccessPointIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <path d="M5 11a9 9 0 0 1 14 0"/>
      <path d="M8 14a5 5 0 0 1 8 0"/>
      <circle cx="12" cy="17.5" r="1.4" fill="currentColor" stroke="none"/>
    </svg>
  )
}

// Firewall — brick wall (unmistakable)
export function FirewallIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5"/>
      <path d="M3 9.83h18M3 14.17h18"/>
      <path d="M9 5.5v4.33M15 5.5v4.33"/>
      <path d="M6 9.83v4.34M12 9.83v4.34M18 9.83v4.34"/>
      <path d="M9 14.17v4.33M15 14.17v4.33"/>
    </svg>
  )
}

// Wireless controller — 1U rack with Wi-Fi waves
export function WirelessControllerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <rect x="2" y="12.5" width="20" height="6.5" rx="1.8"/>
      <circle cx="5.8" cy="15.75" r="0.9" fill="currentColor" stroke="none"/>
      <circle cx="8.4" cy="15.75" r="0.9" fill="currentColor" stroke="none"/>
      <path d="M8.5 8.7a5 5 0 0 1 7 0"/>
      <path d="M6 6a9 9 0 0 1 12 0"/>
    </svg>
  )
}

// Load balancer — one input distributed to three outputs
export function LoadBalancerIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <circle cx="4" cy="12" r="2"/>
      <path d="M6 12h5"/>
      <path d="M11 12V7h4M11 12h4M11 12v5h4"/>
      <circle cx="18" cy="7"  r="2"/>
      <circle cx="18" cy="12" r="2"/>
      <circle cx="18" cy="17" r="2"/>
    </svg>
  )
}

// Generic device — a stacked server
export function UnknownDeviceIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <rect x="3" y="4.5" width="18" height="6.5" rx="1.5"/>
      <rect x="3" y="13"  width="18" height="6.5" rx="1.5"/>
      <circle cx="6.5" cy="7.75"  r="0.9" fill="currentColor" stroke="none"/>
      <circle cx="6.5" cy="16.25" r="0.9" fill="currentColor" stroke="none"/>
      <path d="M16 7.75h2.5M16 16.25h2.5"/>
    </svg>
  )
}

// Cloud / internet node (used in topology only)
export function CloudIcon({ size, className, style }: IconProps) {
  return (
    <svg {...base(size)} className={className} style={style}>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
    </svg>
  )
}

// ── Convenience map ────────────────────────────────────────────────────────

export const DEVICE_TYPE_COLOR: Record<string, string> = {
  router:              '#2563eb',
  switch:              '#16a34a',
  access_point:        '#7c3aed',
  firewall:            '#dc2626',
  wireless_controller: '#0891b2',
  load_balancer:       '#f59e0b',
  cloud:               '#64748b',
  unknown:             '#64748b',
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  router:              'Router',
  switch:              'Switch',
  access_point:        'Access Point',
  firewall:            'Firewall',
  wireless_controller: 'Wireless Controller',
  load_balancer:       'Load Balancer',
  cloud:               'Internet / WAN',
  unknown:             'Unknown',
}

export function DeviceTypeIcon({ type, size, className, style }: { type: string } & IconProps) {
  const props = { size, className, style }
  switch (type) {
    case 'router':              return <RouterIcon {...props} />
    case 'switch':              return <SwitchIcon {...props} />
    case 'access_point':        return <AccessPointIcon {...props} />
    case 'firewall':            return <FirewallIcon {...props} />
    case 'wireless_controller': return <WirelessControllerIcon {...props} />
    case 'load_balancer':       return <LoadBalancerIcon {...props} />
    case 'cloud':               return <CloudIcon {...props} />
    default:                    return <UnknownDeviceIcon {...props} />
  }
}

export default DeviceTypeIcon
