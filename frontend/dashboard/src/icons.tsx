/** Sidebar icon set (lucide-react). Sizes: w-4 default; w-3.5 for section
 *  headers; chevrons smaller. */
import {
  LayoutGrid, LayoutDashboard, Server, Network, List, Search, Bell, SlidersHorizontal, FileText,
  Settings, CalendarDays, Activity, ScrollText, FileCode, Route, Boxes, BookOpen,
  LogOut, ChevronDown, ChevronLeft, ChevronRight, Building2, Users, LineChart,
  ShieldAlert, KeyRound,
} from 'lucide-react'
import type { JSX } from 'react'

const c4 = 'w-4 h-4 shrink-0'
const c35 = 'w-3.5 h-3.5 shrink-0'

export const MODERN_NAV: Record<string, JSX.Element> = {
  grid:         <LayoutGrid className={c4} strokeWidth={2} />,
  dashboard:    <LayoutDashboard className={c4} strokeWidth={2} />,
  monitor:      <Server className={c4} strokeWidth={2} />,
  topology:     <Network className={c4} strokeWidth={2} />,
  list:         <List className={c4} strokeWidth={2} />,
  search:       <Search className={c4} strokeWidth={2} />,
  bell:         <Bell className={c4} strokeWidth={2} />,
  rules:        <SlidersHorizontal className={c4} strokeWidth={2} />,
  policies:     <FileText className={c4} strokeWidth={2} />,
  settings:     <Settings className={c4} strokeWidth={2} />,
  calendar:     <CalendarDays className={c4} strokeWidth={2} />,
  flow:         <Activity className={c4} strokeWidth={2} />,
  syslog:       <ScrollText className={c4} strokeWidth={2} />,
  config:       <FileCode className={c4} strokeWidth={2} />,
  bgp:          <Route className={c4} strokeWidth={2} />,
  collectors:   <Boxes className={c4} strokeWidth={2} />,
  wiki:         <BookOpen className={c4} strokeWidth={2} />,
  key:          <KeyRound className={c4} strokeWidth={2} />,
  users:        <Users className={c4} strokeWidth={2} />,
  platform:     <Building2 className={c4} strokeWidth={2} />,
  logout:       <LogOut className={c4} strokeWidth={2} />,
  // section headers
  observability:<Activity className={c35} strokeWidth={2} />,
  analysis:     <LineChart className={c35} strokeWidth={2} />,
  alerting:     <ShieldAlert className={c35} strokeWidth={2} />,
  // chevrons
  chevronDown:  <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={2.5} />,
  chevronLeft:  <ChevronLeft className="w-4 h-4" strokeWidth={2} />,
  chevronRight: <ChevronRight className="w-4 h-4" strokeWidth={2} />,
}
