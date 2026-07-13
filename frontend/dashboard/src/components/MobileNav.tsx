import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Sun, Moon, Monitor, Menu, X, LogOut } from 'lucide-react'
import api from '../api/client'
import { useTheme, type Theme } from '../hooks/useTheme'
import { hasRole } from '../hooks/useCurrentUser'
import { useLicense } from '../hooks/useLicense'
import { licensedFeaturesIn } from '../features'
import { MODERN_NAV } from '../icons'
import { DASHBOARDS_ITEM, FOOTER_ITEMS, NAV_SECTIONS, visibleItems, type NavItem } from '../navConfig'

interface MeData { username: string; role: string; is_platform_admin: boolean }
const fetchMe = () => api.get<MeData>('/auth/me').then(r => r.data)
const fetchAlertCount = () =>
  api.get<{ total: number }>('/alerts', { params: { status: 'open', limit: 1 } }).then(r => r.data.total)

const iw = 'w-5 h-5'
const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className={iw} strokeWidth={2} />,
  dark: <Moon className={iw} strokeWidth={2} />,
  system: <Monitor className={iw} strokeWidth={2} />,
}
const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** Tabs pinned to the bottom bar — the rest of the manifest lives in the drawer. */
const TAB_TOS = new Set(['/', '/devices', '/alerts', '/topology'])

// ── Bottom tab bar ─────────────────────────────────────────────────────────────

export default function MobileNav() {
  const navigate   = useNavigate()
  const [open, setOpen] = useState(false)
  const { theme, setTheme } = useTheme()
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]

  const { data: me }          = useQuery({ queryKey: ['me'],          queryFn: fetchMe,          retry: false })
  const { data: openAlerts }  = useQuery({ queryKey: ['alert-count'], queryFn: fetchAlertCount,  refetchInterval: 30_000, retry: false })
  const { data: lic }         = useLicense()
  const isLicensed = (key: string) => !!lic?.valid && (lic.modules.includes('*') || lic.modules.includes(key))

  const isAdmin = hasRole(me?.role ?? 'readonly', 'admin')
  const roleCtx = { isAdmin, isPlatformAdmin: !!me?.is_platform_admin }
  const navIcon = (key: string) => MODERN_NAV[key] ?? MODERN_NAV.grid

  const TAB_ITEMS: Array<{ to: string; label: string; icon: string; end?: boolean; badge?: number }> = [
    { to: '/',         label: 'Overview',  icon: 'grid',     end: true },
    { to: '/devices',  label: 'Devices',   icon: 'monitor' },
    { to: '/alerts',   label: 'Alerts',    icon: 'bell',     badge: openAlerts },
    { to: '/topology', label: 'Topology',  icon: 'topology' },
  ]

  // Everything in the shared manifest that isn't already pinned to a bottom
  // tab — keeps the drawer in sync with the desktop Sidebar automatically.
  const DRAWER_ITEMS: NavItem[] = [
    DASHBOARDS_ITEM,
    ...NAV_SECTIONS.flatMap(section => [
      ...visibleItems(section.items, roleCtx).filter(i => !TAB_TOS.has(i.to)),
      ...(section.licenseCategory
        ? licensedFeaturesIn(section.licenseCategory, isLicensed).map(f => ({ to: f.to, label: f.label, icon: section.icon }))
        : []),
    ]),
    ...FOOTER_ITEMS,
  ]

  return (
    <>
      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 inset-x-0 z-50 bg-slate-900 border-t border-slate-800 flex items-stretch safe-area-inset-bottom">
        {TAB_ITEMS.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 relative transition-colors ${
                isActive ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative">
                  {navIcon(item.icon)}
                  {item.badge != null && item.badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </span>
                <span className={`text-[9px] font-medium ${isActive ? 'text-blue-400' : 'text-slate-500'}`}>
                  {item.label}
                </span>
              </>
            )}
          </NavLink>
        ))}

        {/* More button */}
        <button
          onClick={() => setOpen(o => !o)}
          className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 transition-colors ${
            open ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {open ? <X className={iw} strokeWidth={2} /> : <Menu className={iw} strokeWidth={2} />}
          <span className={`text-[9px] font-medium ${open ? 'text-blue-400' : 'text-slate-500'}`}>More</span>
        </button>
      </nav>

      {/* Drawer overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Slide-up drawer */}
      <div
        className={`fixed inset-x-0 bottom-16 z-40 bg-slate-900 border-t border-slate-800 rounded-t-2xl transition-transform duration-200 ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ maxHeight: '75vh', overflowY: 'auto' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-700" />
        </div>

        {/* User info */}
        {me && (
          <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {me.username.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-medium text-white">{me.username}</p>
              <p className="text-xs text-slate-400 capitalize">{me.role}</p>
            </div>
          </div>
        )}

        {/* Nav items */}
        <div className="py-2">
          {DRAWER_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-3.5 transition-colors ${
                  isActive ? 'text-blue-400 bg-white/5' : 'text-slate-300 hover:bg-white/5'
                }`
              }
            >
              {navIcon(item.icon)}
              <span className="text-sm font-medium">{item.label}</span>
            </NavLink>
          ))}
        </div>

        {/* Bottom actions */}
        <div className="border-t border-slate-800 px-5 py-3 flex items-center justify-between gap-3 pb-safe">
          <button
            onClick={() => setTheme(nextTheme)}
            className="flex items-center gap-2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            {THEME_ICONS[theme]}
            <span className="text-sm">{THEME_LABEL[theme]}</span>
          </button>
          <button
            onClick={() => { localStorage.removeItem('token'); navigate('/login') }}
            className="flex items-center gap-2 text-slate-400 hover:text-red-400 transition-colors"
          >
            <LogOut className={iw} strokeWidth={2} />
            <span className="text-sm">Sign out</span>
          </button>
        </div>
      </div>
    </>
  )
}
