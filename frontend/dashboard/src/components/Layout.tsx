import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import MobileNav from './MobileNav'
import { useMobile } from '../hooks/useMobile'

export default function Layout() {
  const isMobile = useMobile()

  if (isMobile) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50 dark:bg-slate-900">
        {/* Mobile top bar */}
        <header className="fixed top-0 inset-x-0 z-30 h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4">
          <span className="text-sm font-bold text-white tracking-wide">Anthrimon</span>
        </header>

        {/* Page content — padded top for header, bottom for nav bar */}
        <main className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900 pt-11 pb-16">
          <Outlet />
        </main>

        <MobileNav />
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
