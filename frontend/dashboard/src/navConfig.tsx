/** Single source of truth for app navigation, shared by the desktop Sidebar
 *  and the mobile bottom-nav/drawer so the two can't silently drift apart.
 *  Icon values are keys into `MODERN_NAV` (see icons.tsx). */

export interface NavItem {
  to: string
  label: string
  icon: string
  requiresAdmin?: boolean
  requiresPlatformAdmin?: boolean
  badgeKey?: 'openAlerts'
}

export interface NavSection {
  key: string
  label: string
  icon: string
  /** PAID_FEATURES `category` to append (licensed items only) — see features.ts */
  licenseCategory?: string
  items: NavItem[]
}

export const DASHBOARDS_ITEM: NavItem = { to: '/dashboards', label: 'Dashboards', icon: 'dashboard' }

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'network', label: 'Network', icon: 'topology',
    items: [
      { to: '/devices',   label: 'Devices',   icon: 'monitor' },
      { to: '/topology',  label: 'Topology',  icon: 'topology' },
      { to: '/addresses', label: 'Addresses', icon: 'list' },
    ],
  },
  {
    key: 'operations', label: 'Operations', icon: 'observability', licenseCategory: 'Monitoring',
    items: [
      { to: '/alerts',       label: 'Alerts',      icon: 'bell', badgeKey: 'openAlerts' },
      { to: '/alert-rules',  label: 'Alert Rules', icon: 'rules' },
      { to: '/maintenance',  label: 'Maintenance', icon: 'calendar' },
      { to: '/flow',         label: 'Flow',        icon: 'flow' },
      { to: '/syslog',       label: 'Logging',     icon: 'syslog' },
      { to: '/path-trace',   label: 'Path Trace',  icon: 'pathTrace' },
    ],
  },
  {
    key: 'analysis', label: 'Analysis', icon: 'analysis', licenseCategory: 'Analysis',
    items: [
      { to: '/routing',  label: 'Routing',  icon: 'bgp' },
      { to: '/config',   label: 'Config',   icon: 'config' },
      { to: '/policies', label: 'Policies', icon: 'policies' },
      { to: '/changes',  label: 'Changes',  icon: 'changes' },
    ],
  },
  {
    key: 'admin', label: 'Admin', icon: 'settings',
    items: [
      { to: '/credentials',     label: 'Credentials',     icon: 'key' },
      { to: '/collectors',      label: 'Collectors',      icon: 'collectors' },
      { to: '/probes',          label: 'Probes',          icon: 'probes' },
      { to: '/discover',        label: 'Discover',        icon: 'discover' },
      { to: '/users',           label: 'Users',           icon: 'users', requiresAdmin: true },
      { to: '/audit',           label: 'Audit Log',       icon: 'auditLog', requiresAdmin: true },
      { to: '/platform-health', label: 'Platform Health', icon: 'health', requiresAdmin: true },
      { to: '/admin',           label: 'Administration',  icon: 'settings', requiresAdmin: true },
      { to: '/platform',        label: 'Platform Admin',  icon: 'platform', requiresPlatformAdmin: true },
    ],
  },
]

export const FOOTER_ITEMS: NavItem[] = [
  { to: '/wiki', label: 'Wiki', icon: 'wiki' },
]

export interface RoleCtx { isAdmin: boolean; isPlatformAdmin: boolean }

export const visibleItems = (items: NavItem[], ctx: RoleCtx): NavItem[] =>
  items.filter(i => (!i.requiresAdmin || ctx.isAdmin) && (!i.requiresPlatformAdmin || ctx.isPlatformAdmin))
