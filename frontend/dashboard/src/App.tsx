import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Login from './pages/Login'
import HomeRedirect from './pages/HomeRedirect'
import DeviceList from './pages/DeviceList'
import DeviceDetail from './pages/DeviceDetail'
import DiscoverPage from './pages/DiscoverPage'
import CredentialsPage from './pages/CredentialsPage'
import AccountPage from './pages/AccountPage'
import AlertsPage from './pages/AlertsPage'
import AlertRulesPage from './pages/AlertRulesPage'
import PoliciesPage from './pages/PoliciesPage'
import AdminPage from './pages/AdminPage'
import AddressesPage from './pages/AddressesPage'
import TopologyPage from './pages/TopologyPage'
import AlertDetailPage from './pages/AlertDetailPage'
import InterfaceDetailPage from './pages/InterfaceDetailPage'
import MaintenancePage from './pages/MaintenancePage'
import FlowPage from './pages/FlowPage'
import SyslogPage from './pages/SyslogPage'
import ConfigPage from './pages/ConfigPage'
import CollectorsPage from './pages/CollectorsPage'
import RoutingPage from './pages/RoutingPage'
import WikiPage from './pages/WikiPage'
import ClientPage from './pages/ClientPage'
import PlatformPage from './pages/PlatformPage'
import UpgradePage from './pages/UpgradePage'
import UsersPage from './pages/UsersPage'
import AuditPage from './pages/AuditPage'
import PlatformHealthPage from './pages/PlatformHealthPage'
import ProbesPage from './pages/ProbesPage'
import PathTracePage from './pages/PathTracePage'
import DashboardsListPage from './pages/DashboardsListPage'
import DashboardViewPage from './pages/DashboardViewPage'
import KioskPage from './pages/KioskPage'
import ChangesPage from './pages/ChangesPage'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={
            localStorage.getItem('token') ? <Navigate to="/" replace /> : <Login />
          } />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/"            element={<HomeRedirect />} />
            <Route path="/devices"     element={<DeviceList />} />
            <Route path="/devices/:id" element={<DeviceDetail />} />
            <Route path="/devices/:id/interfaces/:ifaceId" element={<InterfaceDetailPage />} />
            <Route path="/discover"    element={<DiscoverPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/account"      element={<AccountPage />} />
            <Route path="/alerts"       element={<AlertsPage />} />
            <Route path="/alert-rules"  element={<AlertRulesPage />} />
            <Route path="/policies"     element={<PoliciesPage />} />
            <Route path="/admin"        element={<AdminPage />} />
            <Route path="/addresses"    element={<AddressesPage />} />
            <Route path="/topology"     element={<TopologyPage />} />
            <Route path="/alerts/:id"    element={<AlertDetailPage />} />
            <Route path="/maintenance"   element={<MaintenancePage />} />
            <Route path="/flow"          element={<FlowPage />} />
            <Route path="/syslog"        element={<SyslogPage />} />
            <Route path="/config"        element={<ConfigPage />} />
            <Route path="/collectors"    element={<CollectorsPage />} />
            <Route path="/routing"        element={<RoutingPage />} />
            <Route path="/bgp"            element={<Navigate to="/routing" replace />} />
            <Route path="/wiki"           element={<WikiPage />} />
            <Route path="/wiki/:slug"     element={<WikiPage />} />
            <Route path="/clients/:mac"   element={<ClientPage />} />
            <Route path="/platform"       element={<PlatformPage />} />
            <Route path="/upgrade"        element={<UpgradePage />} />
            <Route path="/users"          element={<UsersPage />} />
            <Route path="/audit"          element={<AuditPage />} />
            <Route path="/platform-health" element={<PlatformHealthPage />} />
            <Route path="/probes"      element={<ProbesPage />} />
            <Route path="/path-trace"  element={<PathTracePage />} />
            <Route path="/changes"        element={<ChangesPage />} />
            <Route path="/dashboards"     element={<DashboardsListPage />} />
            <Route path="/dashboards/:id" element={<DashboardViewPage />} />
          </Route>
          <Route path="/dashboards/kiosk" element={<ProtectedRoute><KioskPage /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
