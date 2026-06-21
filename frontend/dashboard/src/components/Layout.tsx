import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import MobileNav from './MobileNav'
import { useMobile } from '../hooks/useMobile'

export default function Layout() {
  const isMobile = useMobile()

  const skipLink = (
    <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded-lg focus:text-sm focus:font-medium focus:shadow-lg">
      Skip to content
    </a>
  )

  if (isMobile) {
    return (
      <div className="flex flex-col min-h-screen bg-slate-50 dark:bg-slate-900">
        {skipLink}
        {/* Mobile top bar */}
        <header className="fixed top-0 inset-x-0 z-30 h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4">
          <span className="text-sm font-bold text-white tracking-wide">Anthrimon</span>
        </header>

        {/* Page content — padded top for header, bottom for nav bar */}
        <main id="main-content" className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900 pt-11 pb-16">
          <Outlet />
        </main>

        <MobileNav />
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
      {skipLink}
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main id="main-content" className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
